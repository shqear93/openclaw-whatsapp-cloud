import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Coverage for the voice-note wiring: (1) the inbound leg downloads the
// audio from Meta and saves it to the sandboxed media directory (no longer
// calling `speech.ts`'s custom `transcribe()` at all -- that's now the
// framework's own job, driven off the native `media` attachment facts wired
// in `inbound.ts`, with a `language` override sourced from
// `WHATSAPP_STT_LANGUAGE`), (2) the outbound leg chains Cartesia synthesize
// -> meta-client.sendAudioBytes, under an explicit outer deadline, and (3)
// registerFull actually wires both into dispatchWhatsappInboundEvent as
// downloadVoiceNoteMedia/sendVoiceReply.

const downloadMediaMock = vi.fn();
const sendAudioBytesMock = vi.fn();
const sendTextMock = vi.fn().mockResolvedValue({ messageId: "wamid.text123" });
const sendImageMock = vi.fn();

vi.mock("./meta-client.js", () => ({
  createMetaClient: vi.fn(() => ({
    sendText: sendTextMock,
    sendAudio: vi.fn(),
    sendAudioBytes: sendAudioBytesMock,
    sendImage: sendImageMock,
    downloadMedia: downloadMediaMock,
    markAsRead: vi.fn(),
    sendReaction: vi.fn(),
  })),
}));

const synthesizeMock = vi.fn();

vi.mock("./cartesia.js", () => ({
  createCartesiaClient: vi.fn(() => ({
    synthesize: synthesizeMock,
  })),
}));

const saveMediaBufferMock = vi.fn();

vi.mock("openclaw/plugin-sdk/media-store", () => ({
  saveMediaBuffer: (...args: unknown[]) => saveMediaBufferMock(...args),
}));

const transcribeMock = vi.fn();
const createDeepgramClientMock = vi.fn((..._args: unknown[]) => ({ transcribe: transcribeMock }));

vi.mock("./speech.js", () => ({
  createDeepgramClient: (...args: unknown[]) => createDeepgramClientMock(...args),
}));

const readFileMock = vi.fn();

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
}));

let capturedOnEvent: ((event: unknown) => void) | undefined;
const dispatchWhatsappInboundEventMock = vi.fn().mockResolvedValue(undefined);

vi.mock("./inbound.js", () => ({
  dispatchWhatsappInboundEvent: (...args: unknown[]) => dispatchWhatsappInboundEventMock(...args),
}));

vi.mock("./webhook.js", () => ({
  createMetaWebhookHandler: vi.fn((params: { onEvent: (event: unknown) => void }) => {
    capturedOnEvent = params.onEvent;
    return vi.fn();
  }),
}));

describe("WhatsApp Cloud voice-note wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // channel.ts lazily caches its Cartesia/Meta clients at module scope
    // (`cachedCartesiaClient`/`cachedMetaClient`) on first real use, exactly
    // like the pre-existing `cachedMetaClient` pattern -- so tests that
    // assert on the *construction* args (model names, api key) need a fresh
    // module instance each time, not just cleared mock call history.
    vi.resetModules();
    capturedOnEvent = undefined;
    process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "test-phone-id";
    process.env.DEEPGRAM_API_KEY = "test-deepgram-key";
    process.env.CARTESIA_API_KEY = "test-cartesia-key";
    readFileMock.mockResolvedValue(Buffer.from([1, 2, 3]));
  });

  afterEach(() => {
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.WHATSAPP_VERIFY_TOKEN;
    delete process.env.WHATSAPP_APP_SECRET;
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.DEEPGRAM_STT_MODEL;
    delete process.env.DEEPGRAM_TTS_MODEL;
    delete process.env.CARTESIA_API_KEY;
    delete process.env.WHATSAPP_STT_LANGUAGE;
    delete process.env.WHATSAPP_STT_MODEL;
    delete process.env.WHATSAPP_TTS_LANGUAGE;
    delete process.env.WHATSAPP_CARTESIA_MODEL;
    delete process.env.WHATSAPP_CARTESIA_VOICE_ID;
  });

  it("downloadWhatsappCloudVoiceNoteMedia downloads media from Meta and saves it to the sandboxed inbound media dir", async () => {
    downloadMediaMock.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/ogg" });
    saveMediaBufferMock.mockResolvedValue({ path: "/sandbox/media/inbound/abc.ogg", contentType: "audio/ogg" });

    const { downloadWhatsappCloudVoiceNoteMedia } = await import("./channel.js");

    const media = await downloadWhatsappCloudVoiceNoteMedia({ mediaId: "media-1" });

    expect(downloadMediaMock).toHaveBeenCalledWith("media-1");
    expect(saveMediaBufferMock).toHaveBeenCalledWith(Buffer.from([1, 2, 3]), "audio/ogg", "inbound");
    expect(media).toEqual({ path: "/sandbox/media/inbound/abc.ogg", contentType: "audio/ogg" });
  });

  it("sendWhatsappCloudVoiceReply synthesizes text via Cartesia (with the default 'ar' language) then sends the resulting bytes as a voice note", async () => {
    synthesizeMock.mockResolvedValue({ audioBytes: new Uint8Array([9, 9, 9]), mimeType: "audio/mpeg" });
    sendAudioBytesMock.mockResolvedValue({ messageId: "wamid.audio1" });

    const { sendWhatsappCloudVoiceReply } = await import("./channel.js");

    await sendWhatsappCloudVoiceReply({ to: "15551234567", text: "here's your answer" });

    expect(synthesizeMock).toHaveBeenCalledWith("here's your answer", "ar");
    expect(sendAudioBytesMock).toHaveBeenCalledWith({
      to: "15551234567",
      audioBytes: new Uint8Array([9, 9, 9]),
      mimeType: "audio/mpeg",
    });
  });

  it("sendWhatsappCloudVoiceReply strips markdown from the reply text before handing it to Cartesia synthesize", async () => {
    synthesizeMock.mockResolvedValue({ audioBytes: new Uint8Array([9, 9, 9]), mimeType: "audio/mpeg" });
    sendAudioBytesMock.mockResolvedValue({ messageId: "wamid.audio1" });

    const { sendWhatsappCloudVoiceReply } = await import("./channel.js");

    await sendWhatsappCloudVoiceReply({
      to: "15551234567",
      text: "### Here's the transcript\n- **bold** answer\n---\n1. done",
    });

    expect(synthesizeMock).toHaveBeenCalledWith("Here's the transcript\nbold answer\n\ndone", "ar");
  });

  it("sendWhatsappCloudVoiceReply uses WHATSAPP_TTS_LANGUAGE (not WHATSAPP_STT_LANGUAGE) as the Cartesia TTS language when set", async () => {
    process.env.WHATSAPP_TTS_LANGUAGE = "en";
    // STT's "multi" default must never leak into TTS -- Cartesia has no
    // "multi" language, so setting only WHATSAPP_STT_LANGUAGE here must NOT
    // affect the TTS call.
    process.env.WHATSAPP_STT_LANGUAGE = "multi";
    synthesizeMock.mockResolvedValue({ audioBytes: new Uint8Array([1]), mimeType: "audio/mpeg" });
    sendAudioBytesMock.mockResolvedValue({ messageId: "wamid.audio1" });

    const { sendWhatsappCloudVoiceReply } = await import("./channel.js");
    await sendWhatsappCloudVoiceReply({ to: "15551234567", text: "hi" });

    expect(synthesizeMock).toHaveBeenCalledWith("hi", "en");
  });

  it("sendWhatsappCloudVoiceReply times out and rejects instead of hanging forever when Cartesia synthesize never resolves", async () => {
    vi.useFakeTimers();
    try {
      // Simulate the exact failure mode this fix targets: a call that never
      // settles at all (not even via its own internal AbortSignal timeout).
      synthesizeMock.mockImplementation(() => new Promise(() => {}));

      const { sendWhatsappCloudVoiceReply } = await import("./channel.js");

      const resultPromise = sendWhatsappCloudVoiceReply({ to: "15551234567", text: "hello" });
      // Swallow the eventual rejection so vitest doesn't flag it as
      // unhandled while the fake-timer advance below is still pending.
      const assertion = expect(resultPromise).rejects.toThrow(/timed out after 100000ms/);

      await vi.advanceTimersByTimeAsync(100_000);

      await assertion;
      expect(sendAudioBytesMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("constructs the Cartesia client with the WhatsApp-specific default model/voice when no override env vars are set", async () => {
    synthesizeMock.mockResolvedValue({ audioBytes: new Uint8Array([1]), mimeType: "audio/mpeg" });
    sendAudioBytesMock.mockResolvedValue({ messageId: "wamid.audio1" });
    const { createCartesiaClient } = await import("./cartesia.js");

    const { sendWhatsappCloudVoiceReply } = await import("./channel.js");
    await sendWhatsappCloudVoiceReply({ to: "15551234567", text: "hi" });

    expect(createCartesiaClient).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "test-cartesia-key",
        model: "sonic-3",
        voiceId: "69f116b4-c5aa-45d3-a01c-d2e8d2c382a0",
      }),
    );
  });

  it("honors WHATSAPP_CARTESIA_MODEL/WHATSAPP_CARTESIA_VOICE_ID overrides when set", async () => {
    process.env.WHATSAPP_CARTESIA_MODEL = "sonic-2";
    process.env.WHATSAPP_CARTESIA_VOICE_ID = "custom-voice-id";
    synthesizeMock.mockResolvedValue({ audioBytes: new Uint8Array([1]), mimeType: "audio/mpeg" });
    sendAudioBytesMock.mockResolvedValue({ messageId: "wamid.audio1" });
    const { createCartesiaClient } = await import("./cartesia.js");

    const { sendWhatsappCloudVoiceReply } = await import("./channel.js");
    await sendWhatsappCloudVoiceReply({ to: "15551234567", text: "hi" });

    expect(createCartesiaClient).toHaveBeenCalledWith(
      expect.objectContaining({ model: "sonic-2", voiceId: "custom-voice-id" }),
    );
  });

  it("registerFull wires downloadWhatsappCloudVoiceNoteMedia/transcribeVoiceNoteMedia into dispatchWhatsappInboundEvent (voice sending is now tool-only, no longer passed to inbound.ts)", async () => {
    process.env.WHATSAPP_VERIFY_TOKEN = "verify-token";
    process.env.WHATSAPP_APP_SECRET = "app-secret";

    const { registerFull, downloadWhatsappCloudVoiceNoteMedia } = await import("./channel.js");

    const fakeApi = {
      config: {},
      runtime: { channel: {} },
      logger: { info: vi.fn(), error: vi.fn() },
      registerTool: vi.fn(),
      registerHttpRoute: vi.fn(),
    };

    registerFull(fakeApi);
    expect(capturedOnEvent).toBeDefined();

    capturedOnEvent!({ sender: "15551234567", type: "text", text: "hi", messageId: "wamid.1" });

    expect(dispatchWhatsappInboundEventMock).toHaveBeenCalledTimes(1);
    const dispatchParams = dispatchWhatsappInboundEventMock.mock.calls[0][0];
    expect(dispatchParams.downloadVoiceNoteMedia).toBe(downloadWhatsappCloudVoiceNoteMedia);
    expect(dispatchParams.sendVoiceReply).toBeUndefined();
    expect(typeof dispatchParams.transcribeVoiceNoteMedia).toBe("function");
  });

  it("registerFull registers send_text_reply_for_whatsapp and send_voice_reply_for_whatsapp tools", async () => {
    process.env.WHATSAPP_VERIFY_TOKEN = "verify-token";
    process.env.WHATSAPP_APP_SECRET = "app-secret";

    const { registerFull } = await import("./channel.js");

    const registerTool = vi.fn();
    const fakeApi = {
      config: {},
      runtime: { channel: {} },
      logger: { info: vi.fn(), error: vi.fn() },
      registerTool,
      registerHttpRoute: vi.fn(),
    };

    registerFull(fakeApi);

    expect(registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "send_text_reply_for_whatsapp" }),
    );
    expect(registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "send_voice_reply_for_whatsapp" }),
    );
  });

  it("send_text_reply_for_whatsapp tool sends text via meta-client and marks the reply-sent tracker", async () => {
    process.env.WHATSAPP_VERIFY_TOKEN = "verify-token";
    process.env.WHATSAPP_APP_SECRET = "app-secret";
    sendTextMock.mockResolvedValue({ messageId: "wamid.text1" });

    const { registerFull } = await import("./channel.js");
    const { wasReplySentThisTurn, resetReplySentFlag } = await import("./reply-delivery-tracker.js");

    const registeredTools: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }> = [];
    const fakeApi = {
      config: {},
      runtime: { channel: {} },
      logger: { info: vi.fn(), error: vi.fn() },
      registerTool: vi.fn((tool: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) =>
        registeredTools.push(tool),
      ),
      registerHttpRoute: vi.fn(),
    };

    registerFull(fakeApi);
    const tool = registeredTools.find((t) => t.name === "send_text_reply_for_whatsapp");
    if (!tool) throw new Error("send_text_reply_for_whatsapp was not registered");

    resetReplySentFlag("15551234567");
    const result = await tool.execute("call-1", { to: "15551234567", text: "hello there" });

    expect(sendTextMock).toHaveBeenCalledWith({ to: "15551234567", text: "hello there" });
    expect(wasReplySentThisTurn("15551234567")).toBe(true);
    expect(result).toEqual({ content: [{ type: "text", text: "Text reply sent." }] });
  });

  it("send_voice_reply_for_whatsapp tool synthesizes+sends voice via Cartesia/meta-client and marks the reply-sent tracker", async () => {
    process.env.WHATSAPP_VERIFY_TOKEN = "verify-token";
    process.env.WHATSAPP_APP_SECRET = "app-secret";
    synthesizeMock.mockResolvedValue({ audioBytes: new Uint8Array([1, 2, 3]), mimeType: "audio/mpeg" });
    sendAudioBytesMock.mockResolvedValue({ messageId: "wamid.audio1" });

    const { registerFull } = await import("./channel.js");
    const { wasReplySentThisTurn, resetReplySentFlag } = await import("./reply-delivery-tracker.js");

    const registeredTools: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }> = [];
    const fakeApi = {
      config: {},
      runtime: { channel: {} },
      logger: { info: vi.fn(), error: vi.fn() },
      registerTool: vi.fn((tool: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) =>
        registeredTools.push(tool),
      ),
      registerHttpRoute: vi.fn(),
    };

    registerFull(fakeApi);
    const tool = registeredTools.find((t) => t.name === "send_voice_reply_for_whatsapp");
    if (!tool) throw new Error("send_voice_reply_for_whatsapp was not registered");

    resetReplySentFlag("15551234567");
    const result = await tool.execute("call-1", { to: "15551234567", text: "hello there" });

    expect(synthesizeMock).toHaveBeenCalledWith("hello there", "ar");
    expect(sendAudioBytesMock).toHaveBeenCalledWith({
      to: "15551234567",
      audioBytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/mpeg",
    });
    expect(wasReplySentThisTurn("15551234567")).toBe(true);
    expect(result).toEqual({ content: [{ type: "text", text: "Voice reply sent." }] });
  });

  describe("createWhatsappCloudVoiceNoteTranscriber", () => {
    // Calls Deepgram DIRECTLY via speech.ts's createDeepgramClient, NOT the
    // framework's transcribeAudioFile -- see channel.ts's doc comment on
    // createWhatsappCloudVoiceNoteTranscriber for why: transcribeAudioFile's
    // activeModel.model override is silently ignored for the "audio"
    // capability in the installed openclaw package (confirmed via Deepgram's
    // own request logs -- every in-app call landed on model=nova-3 despite
    // requesting whisper-large), so a bespoke direct call is the only way to
    // actually control which Deepgram model this plugin's own STT uses.
    it("reads the file, calls Deepgram directly with the default nova-3 model and a fixed language=ar, returning its text", async () => {
      transcribeMock.mockResolvedValue("مرحبا كيف حالك شو الاخبار");

      const { createWhatsappCloudVoiceNoteTranscriber } = await import("./channel.js");
      const transcribe = createWhatsappCloudVoiceNoteTranscriber({});

      const result = await transcribe({ filePath: "/sandbox/media/inbound/abc.ogg", contentType: "audio/ogg" });

      expect(readFileMock).toHaveBeenCalledWith("/sandbox/media/inbound/abc.ogg");
      expect(createDeepgramClientMock).toHaveBeenCalledWith({
        apiKey: "test-deepgram-key",
        sttModel: "nova-3",
      });
      expect(transcribeMock).toHaveBeenCalledWith(Buffer.from([1, 2, 3]), "audio/ogg", "ar");
      expect(result).toEqual({ text: "مرحبا كيف حالك شو الاخبار" });
    });

    it("uses WHATSAPP_STT_MODEL as the primary model override when set", async () => {
      process.env.WHATSAPP_STT_MODEL = "nova-2";
      transcribeMock.mockResolvedValue("hello");

      const { createWhatsappCloudVoiceNoteTranscriber } = await import("./channel.js");
      const transcribe = createWhatsappCloudVoiceNoteTranscriber({});

      await transcribe({ filePath: "/sandbox/media/inbound/abc.ogg", contentType: "audio/ogg" });

      expect(createDeepgramClientMock).toHaveBeenCalledWith({
        apiKey: "test-deepgram-key",
        sttModel: "nova-2",
      });
    });

    it("uses WHATSAPP_STT_LANGUAGE as a forced language override for the primary model when set", async () => {
      process.env.WHATSAPP_STT_LANGUAGE = "ar-EG";
      transcribeMock.mockResolvedValue("أهلا");

      const { createWhatsappCloudVoiceNoteTranscriber } = await import("./channel.js");
      const transcribe = createWhatsappCloudVoiceNoteTranscriber({});

      await transcribe({ filePath: "/sandbox/media/inbound/abc.ogg", contentType: "audio/ogg" });

      expect(transcribeMock).toHaveBeenCalledWith(expect.anything(), "audio/ogg", "ar-EG");
    });

    it("retries once with the same primary model/language after a transient rejection and returns the retry's text", async () => {
      vi.useFakeTimers();
      try {
        transcribeMock
          .mockRejectedValueOnce(new Error("Deepgram STT request rejected: status=500"))
          .mockResolvedValueOnce("مرحبا");

        const { createWhatsappCloudVoiceNoteTranscriber } = await import("./channel.js");
        const transcribe = createWhatsappCloudVoiceNoteTranscriber({});

        const resultPromise = transcribe({ filePath: "/sandbox/media/inbound/abc.ogg", contentType: "audio/ogg" });
        await vi.advanceTimersByTimeAsync(3_000);
        const result = await resultPromise;

        expect(transcribeMock).toHaveBeenCalledTimes(2);
        expect(createDeepgramClientMock).toHaveBeenCalledTimes(1);
        expect(createDeepgramClientMock).toHaveBeenCalledWith(
          expect.objectContaining({ sttModel: "nova-3" }),
        );
        expect(transcribeMock.mock.calls[1]).toEqual([Buffer.from([1, 2, 3]), "audio/ogg", "ar"]);
        expect(result).toEqual({ text: "مرحبا" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("treats an empty (but technically successful) transcript the same as a failure and advances to the next attempt", async () => {
      vi.useFakeTimers();
      try {
        // Confirmed live via Deepgram's own request logs: a call can return
        // HTTP 200 with a genuinely empty transcript for real speech --
        // that must be treated as a failure signal, not a valid empty reply.
        transcribeMock.mockResolvedValueOnce("   ").mockResolvedValueOnce("real content");

        const { createWhatsappCloudVoiceNoteTranscriber } = await import("./channel.js");
        const transcribe = createWhatsappCloudVoiceNoteTranscriber({});

        const resultPromise = transcribe({ filePath: "/sandbox/media/inbound/abc.ogg", contentType: "audio/ogg" });
        await vi.advanceTimersByTimeAsync(3_000);
        const result = await resultPromise;

        expect(transcribeMock).toHaveBeenCalledTimes(2);
        expect(result).toEqual({ text: "real content" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("falls back to whisper-large (no forced language) on a third attempt if both nova-3/ar attempts fail, and returns its text", async () => {
      vi.useFakeTimers();
      try {
        transcribeMock
          .mockRejectedValueOnce(new Error("empty transcript"))
          .mockRejectedValueOnce(new Error("empty transcript"))
          .mockResolvedValueOnce("hello how are you");

        const { createWhatsappCloudVoiceNoteTranscriber } = await import("./channel.js");
        const transcribe = createWhatsappCloudVoiceNoteTranscriber({});

        const resultPromise = transcribe({ filePath: "/sandbox/media/inbound/abc.ogg", contentType: "audio/ogg" });
        await vi.advanceTimersByTimeAsync(3_000);
        const result = await resultPromise;

        expect(transcribeMock).toHaveBeenCalledTimes(3);
        expect(createDeepgramClientMock).toHaveBeenCalledWith(
          expect.objectContaining({ sttModel: "whisper-large" }),
        );
        expect(transcribeMock.mock.calls[2]).toEqual([Buffer.from([1, 2, 3]), "audio/ogg", undefined]);
        expect(result).toEqual({ text: "hello how are you" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("propagates a rejection if the whisper-large fallback also fails, so ingest's own timeout/try-catch can handle it", async () => {
      vi.useFakeTimers();
      try {
        transcribeMock.mockRejectedValue(new Error("deepgram unavailable"));

        const { createWhatsappCloudVoiceNoteTranscriber } = await import("./channel.js");
        const transcribe = createWhatsappCloudVoiceNoteTranscriber({});

        const resultPromise = transcribe({ filePath: "/sandbox/media/inbound/abc.ogg", contentType: "audio/ogg" });
        const assertion = expect(resultPromise).rejects.toThrow("deepgram unavailable");
        await vi.advanceTimersByTimeAsync(3_000);
        await assertion;

        expect(transcribeMock).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
