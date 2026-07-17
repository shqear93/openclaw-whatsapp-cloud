import { describe, expect, it, vi } from "vitest";
import { dispatchWhatsappInboundEvent } from "./inbound.js";
import { markReplySent } from "./reply-delivery-tracker.js";
import type { MetaWebhookEvent } from "./webhook.js";

// Only mocked so a single test can force a deterministic "this IS a
// recognized control command" result -- every other test relies on the
// real hasControlCommand (unmocked default: returns false for ordinary
// chat text like "hi").
const hasControlCommandMock = vi.fn().mockReturnValue(false);
vi.mock("openclaw/plugin-sdk/command-detection", () => ({
  hasControlCommand: (...args: unknown[]) => hasControlCommandMock(...args),
}));

const ALLOWED_SENDER = "15550001234";

function makeAllowlistCfg(overrides: Record<string, unknown> = {}) {
  return {
    channels: {
      "whatsapp-cloud": {
        dmPolicy: "allowlist",
        allowFrom: [ALLOWED_SENDER],
      },
    },
    ...overrides,
  } as any;
}

function makeChannelRuntime() {
  const runInbound = vi.fn().mockResolvedValue({ dispatched: true });
  const buildContext = vi.fn().mockReturnValue({ fake: "ctx" });
  const resolveStorePath = vi.fn().mockReturnValue("/fake/store");
  const recordInboundSession = vi.fn();
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn();

  return {
    runInbound,
    buildContext,
    resolveStorePath,
    recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher,
    channelRuntime: {
      inbound: { run: runInbound, buildContext },
      session: { resolveStorePath, recordInboundSession },
      reply: { dispatchReplyWithBufferedBlockDispatcher },
    } as any,
  };
}

describe("dispatchWhatsappInboundEvent", () => {
  it("builds a turn-kernel call routed to the whatsapp agent with a deterministic session key", async () => {
    const { runInbound, channelRuntime } = makeChannelRuntime();

    const event: MetaWebhookEvent = { sender: ALLOWED_SENDER, type: "text", text: "hi", messageId: "wamid.1" };

    await dispatchWhatsappInboundEvent({
      cfg: makeAllowlistCfg(),
      event,
      channelRuntime,
      sendText: vi.fn(),
    });

    expect(runInbound).toHaveBeenCalledTimes(1);
    const call = runInbound.mock.calls[0][0];
    expect(call.channel).toBe("whatsapp-cloud");
    expect(call.raw).toBe(event);

    const input = await call.adapter.ingest(event);
    expect(input.textForAgent).toBe("hi");

    const resolved = await call.adapter.resolveTurn(input, { kind: "message", canStartAgentTurn: true }, {});
    expect(resolved.agentId).toBe("whatsapp");
    expect(resolved.routeSessionKey).toBe(`agent:whatsapp:${ALLOWED_SENDER}`);
  });

  it("returns null from ingest for audio-type events when no downloadVoiceNoteMedia callback is configured", async () => {
    const { runInbound, buildContext, channelRuntime } = makeChannelRuntime();

    const event: MetaWebhookEvent = {
      sender: ALLOWED_SENDER,
      type: "audio",
      audioMediaId: "media.1",
      messageId: "wamid.2",
    };

    await dispatchWhatsappInboundEvent({
      cfg: makeAllowlistCfg(),
      event,
      channelRuntime,
      sendText: vi.fn(),
    });

    const call = runInbound.mock.calls[0][0];
    const input = await call.adapter.ingest(event);
    expect(input).toBeNull();
    expect(buildContext).not.toHaveBeenCalled();
  });

  describe("voice notes", () => {
    it("downloads an inbound audio event via downloadVoiceNoteMedia and sets its local path on the turn's native media attachment facts; falls back to an empty rawText when no transcribeVoiceNoteMedia callback is configured", async () => {
      const { runInbound, buildContext, channelRuntime } = makeChannelRuntime();
      const downloadVoiceNoteMedia = vi
        .fn()
        .mockResolvedValue({ path: "/sandbox/media/inbound/abc.ogg", contentType: "audio/ogg" });

      const event: MetaWebhookEvent = {
        sender: ALLOWED_SENDER,
        type: "audio",
        audioMediaId: "media.1",
        messageId: "wamid.2",
      };

      await dispatchWhatsappInboundEvent({
        cfg: makeAllowlistCfg(),
        event,
        channelRuntime,
        sendText: vi.fn(),
        downloadVoiceNoteMedia,
      });

      const call = runInbound.mock.calls[0][0];
      const input = await call.adapter.ingest(event);

      expect(downloadVoiceNoteMedia).toHaveBeenCalledWith({ mediaId: "media.1" });
      // With no transcribeVoiceNoteMedia callback configured, ingest falls
      // back to its pre-existing behavior: an empty rawText, relying on the
      // framework's own turn kernel to transcribe the media attachment once
      // `resolveTurn` hands it the native `media` facts below.
      expect(input.rawText).toBe("");
      expect(input.textForAgent).toBe("");
      expect(input.id).toBe("wamid.2");
      expect(input.media).toEqual([
        {
          path: "/sandbox/media/inbound/abc.ogg",
          contentType: "audio/ogg",
          kind: "audio",
          messageId: "wamid.2",
          transcribed: false,
        },
      ]);

      const resolved = await call.adapter.resolveTurn(input, { kind: "message", canStartAgentTurn: true }, {});
      expect(resolved).toBeDefined();
      const buildContextCall = buildContext.mock.calls[0][0];
      expect(buildContextCall.media).toEqual(input.media);
    });

    it("transcribes the voice note synchronously in ingest via transcribeVoiceNoteMedia and populates rawText/textForAgent/textForCommands with the transcript directly, so the agent's prompt never depends on the framework's post-hoc media understanding patch landing in time", async () => {
      const { runInbound, buildContext, channelRuntime } = makeChannelRuntime();
      const downloadVoiceNoteMedia = vi
        .fn()
        .mockResolvedValue({ path: "/sandbox/media/inbound/abc.ogg", contentType: "audio/ogg" });
      const transcribeVoiceNoteMedia = vi.fn().mockResolvedValue({ text: "hello how are you" });

      const event: MetaWebhookEvent = {
        sender: ALLOWED_SENDER,
        type: "audio",
        audioMediaId: "media.1",
        messageId: "wamid.2",
      };

      await dispatchWhatsappInboundEvent({
        cfg: makeAllowlistCfg(),
        event,
        channelRuntime,
        sendText: vi.fn(),
        downloadVoiceNoteMedia,
        transcribeVoiceNoteMedia,
      });

      const call = runInbound.mock.calls[0][0];
      const input = await call.adapter.ingest(event);

      expect(transcribeVoiceNoteMedia).toHaveBeenCalledWith({
        filePath: "/sandbox/media/inbound/abc.ogg",
        contentType: "audio/ogg",
      });
      expect(input.rawText).toBe("hello how are you");
      expect(input.textForAgent).toBe("hello how are you");
      expect(input.textForCommands).toBe("hello how are you");
      // `transcribed: true` tells the framework's own media-understanding
      // step to skip re-transcribing this attachment (avoids a redundant
      // Deepgram call), while the `media` fact is still handed to the
      // framework for session bookkeeping/observability.
      expect(input.media).toEqual([
        {
          path: "/sandbox/media/inbound/abc.ogg",
          contentType: "audio/ogg",
          kind: "audio",
          messageId: "wamid.2",
          transcribed: true,
        },
      ]);

      const resolved = await call.adapter.resolveTurn(input, { kind: "message", canStartAgentTurn: true }, {});
      expect(resolved).toBeDefined();
      const buildContextCall = buildContext.mock.calls[0][0];
      expect(buildContextCall.message.rawBody).toBe("hello how are you");
      expect(buildContextCall.message.bodyForAgent).toBe("hello how are you");
      expect(buildContextCall.message.commandBody).toBe("hello how are you");
    });

    it("falls back to an empty rawText (and leaves transcribed: false) when transcribeVoiceNoteMedia rejects, instead of failing the whole turn", async () => {
      const { runInbound, channelRuntime } = makeChannelRuntime();
      const downloadVoiceNoteMedia = vi
        .fn()
        .mockResolvedValue({ path: "/sandbox/media/inbound/abc.ogg", contentType: "audio/ogg" });
      const transcribeVoiceNoteMedia = vi.fn().mockRejectedValue(new Error("deepgram unavailable"));
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const event: MetaWebhookEvent = {
        sender: ALLOWED_SENDER,
        type: "audio",
        audioMediaId: "media.1",
        messageId: "wamid.2",
      };

      await dispatchWhatsappInboundEvent({
        cfg: makeAllowlistCfg(),
        event,
        channelRuntime,
        sendText: vi.fn(),
        downloadVoiceNoteMedia,
        transcribeVoiceNoteMedia,
      });

      const call = runInbound.mock.calls[0][0];
      const input = await call.adapter.ingest(event);

      expect(input.rawText).toBe("");
      expect(input.media[0].transcribed).toBe(false);
      consoleWarnSpy.mockRestore();
    });

    it("falls back to an empty rawText (and leaves transcribed: false) when transcribeVoiceNoteMedia resolves with an empty/whitespace-only transcript", async () => {
      const { runInbound, channelRuntime } = makeChannelRuntime();
      const downloadVoiceNoteMedia = vi
        .fn()
        .mockResolvedValue({ path: "/sandbox/media/inbound/abc.ogg", contentType: "audio/ogg" });
      const transcribeVoiceNoteMedia = vi.fn().mockResolvedValue({ text: "   " });

      const event: MetaWebhookEvent = {
        sender: ALLOWED_SENDER,
        type: "audio",
        audioMediaId: "media.1",
        messageId: "wamid.2",
      };

      await dispatchWhatsappInboundEvent({
        cfg: makeAllowlistCfg(),
        event,
        channelRuntime,
        sendText: vi.fn(),
        downloadVoiceNoteMedia,
        transcribeVoiceNoteMedia,
      });

      const call = runInbound.mock.calls[0][0];
      const input = await call.adapter.ingest(event);

      expect(input.rawText).toBe("");
      expect(input.media[0].transcribed).toBe(false);
    });

    it("lets a download failure propagate out of ingest so the outer catch sends the standard error reply", async () => {
      const { runInbound, channelRuntime } = makeChannelRuntime();
      const failure = new Error("WhatsApp API rejected media download for media.1: status=500 body=oops");
      runInbound.mockImplementation(async (callArgs: any) => {
        await callArgs.adapter.ingest(callArgs.raw);
        return { dispatched: true };
      });
      const downloadVoiceNoteMedia = vi.fn().mockRejectedValue(failure);
      const sendText = vi.fn().mockResolvedValue(undefined);
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const event: MetaWebhookEvent = {
        sender: ALLOWED_SENDER,
        type: "audio",
        audioMediaId: "media.1",
        messageId: "wamid.2",
      };

      await expect(
        dispatchWhatsappInboundEvent({
          cfg: makeAllowlistCfg(),
          event,
          channelRuntime,
          sendText,
          downloadVoiceNoteMedia,
        }),
      ).rejects.toThrow("WhatsApp API rejected media download");

      expect(sendText).toHaveBeenCalledWith({
        to: ALLOWED_SENDER,
        text: expect.stringContaining("error"),
      });

      consoleErrorSpy.mockRestore();
    });

    it("durable() always defers text-only final replies to deliver(), regardless of whether the turn was voice- or text-originated", async () => {
      // Delivery is agent-driven now (send_text_reply_for_whatsapp/
      // send_voice_reply_for_whatsapp in channel.ts) -- durable() no longer
      // auto-claims the kernel's own plain final-text reply for message-
      // adapter.ts's unconditional sendText, since that reply is now only
      // ever a fallback, decided in deliver() below.
      const { runInbound, channelRuntime } = makeChannelRuntime();
      const downloadVoiceNoteMedia = vi
        .fn()
        .mockResolvedValue({ path: "/sandbox/media/inbound/abc.ogg", contentType: "audio/ogg" });

      const event: MetaWebhookEvent = {
        sender: ALLOWED_SENDER,
        type: "audio",
        audioMediaId: "media.1",
        messageId: "wamid.2",
      };

      await dispatchWhatsappInboundEvent({
        cfg: makeAllowlistCfg(),
        event,
        channelRuntime,
        sendText: vi.fn(),
        downloadVoiceNoteMedia,
      });

      const call = runInbound.mock.calls[0][0];
      const resolved = await call.adapter.resolveTurn(
        { rawText: "", timestamp: Date.now() },
        { kind: "message", canStartAgentTurn: true },
        {},
      );

      const durableResult = await resolved.delivery.durable({ text: "here's your answer" }, { kind: "final" });
      expect(durableResult).toBe(false);
    });

    it("still claims the durable delivery path for media replies, regardless of turn type", async () => {
      const { runInbound, channelRuntime } = makeChannelRuntime();

      const event: MetaWebhookEvent = { sender: ALLOWED_SENDER, type: "text", text: "hi", messageId: "wamid.1" };

      await dispatchWhatsappInboundEvent({
        cfg: makeAllowlistCfg(),
        event,
        channelRuntime,
        sendText: vi.fn(),
      });

      const call = runInbound.mock.calls[0][0];
      const resolved = await call.adapter.resolveTurn(
        { rawText: "hi", timestamp: Date.now() },
        { kind: "message", canStartAgentTurn: true },
        {},
      );

      const durableResult = await resolved.delivery.durable(
        { mediaUrl: "https://example.com/cat.png", text: "here's your cat" },
        { kind: "final" },
      );
      expect(durableResult).toEqual({ to: ALLOWED_SENDER });
    });

    it("deliver() skips the plain final text entirely when an explicit reply tool already fired this turn", async () => {
      const { runInbound, channelRuntime } = makeChannelRuntime();
      const sendText = vi.fn().mockResolvedValue(undefined);

      const event: MetaWebhookEvent = { sender: ALLOWED_SENDER, type: "text", text: "hi", messageId: "wamid.1" };

      await dispatchWhatsappInboundEvent({ cfg: makeAllowlistCfg(), event, channelRuntime, sendText });

      const call = runInbound.mock.calls[0][0];
      const resolved = await call.adapter.resolveTurn(
        { rawText: "hi", timestamp: Date.now() },
        { kind: "message", canStartAgentTurn: true },
        {},
      );

      // Simulates send_text_reply_for_whatsapp/send_voice_reply_for_whatsapp
      // (channel.ts) having already fired during this turn.
      markReplySent(ALLOWED_SENDER);

      const result = await resolved.delivery.deliver({ text: "leftover wrap-up text" });

      expect(sendText).not.toHaveBeenCalled();
      expect(result).toEqual({ visibleReplySent: true });
    });

    it("deliver() falls back to sending the raw text, flagged, when no explicit reply tool fired this turn", async () => {
      const { runInbound, channelRuntime } = makeChannelRuntime();
      const sendText = vi.fn().mockResolvedValue(undefined);

      const event: MetaWebhookEvent = { sender: ALLOWED_SENDER, type: "text", text: "hi", messageId: "wamid.1" };

      await dispatchWhatsappInboundEvent({ cfg: makeAllowlistCfg(), event, channelRuntime, sendText });

      const call = runInbound.mock.calls[0][0];
      const resolved = await call.adapter.resolveTurn(
        { rawText: "hi", timestamp: Date.now() },
        { kind: "message", canStartAgentTurn: true },
        {},
      );

      const result = await resolved.delivery.deliver({ text: "here's your answer" });

      expect(sendText).toHaveBeenCalledTimes(1);
      const sentPayload = sendText.mock.calls[0][0];
      expect(sentPayload.to).toBe(ALLOWED_SENDER);
      expect(sentPayload.text).toContain("here's your answer");
      expect(sentPayload.text.toLowerCase()).toContain("fallback");
      expect(result).toEqual({ visibleReplySent: true });
    });

    it("resets the reply-sent flag at the start of a new turn, so a previous turn's send never suppresses this turn's fallback", async () => {
      // Simulates a PRIOR turn for this sender already having sent a reply.
      markReplySent(ALLOWED_SENDER);

      const { runInbound, channelRuntime } = makeChannelRuntime();
      const sendText = vi.fn().mockResolvedValue(undefined);
      const event: MetaWebhookEvent = {
        sender: ALLOWED_SENDER,
        type: "text",
        text: "a new message",
        messageId: "wamid.3",
      };

      await dispatchWhatsappInboundEvent({ cfg: makeAllowlistCfg(), event, channelRuntime, sendText });

      const call = runInbound.mock.calls[0][0];
      const resolved = await call.adapter.resolveTurn(
        { rawText: "a new message", timestamp: Date.now() },
        { kind: "message", canStartAgentTurn: true },
        {},
      );

      const result = await resolved.delivery.deliver({ text: "a new answer" });

      expect(sendText).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ visibleReplySent: true });
    });

    it("re-sends the typing indicator on an interval for the whole dispatch, and stops once it settles", async () => {
      vi.useFakeTimers();
      try {
        const { runInbound, channelRuntime } = makeChannelRuntime();
        const downloadVoiceNoteMedia = vi
          .fn()
          .mockResolvedValue({ path: "/sandbox/media/inbound/abc.ogg", contentType: "audio/ogg" });
        const markAsRead = vi.fn().mockResolvedValue(undefined);
        // The fallback sendText call taking a genuinely long time to
        // resolve -- exercises the same "keepalive spans the whole
        // dispatch" behavior the old sendVoiceReply-based version of this
        // test covered, without depending on a removed callback.
        let resolveSendText: () => void;
        const sendText = vi.fn().mockReturnValue(
          new Promise<void>((resolve) => {
            resolveSendText = resolve;
          }),
        );

        const event: MetaWebhookEvent = {
          sender: ALLOWED_SENDER,
          type: "audio",
          audioMediaId: "media.1",
          messageId: "wamid.2",
        };

        // Drive ingest -> resolveTurn -> delivery INSIDE the mocked
        // `channelRuntime.inbound.run`, so its promise stays genuinely
        // pending until delivery completes -- exactly like the real turn
        // kernel, and exactly what lets the keepalive (started before this
        // call, in `dispatchWhatsappInboundEvent` itself) actually span the
        // whole thing rather than just a manually-invoked `deliver()` call
        // made after dispatch already returned.
        runInbound.mockImplementation(async (callArgs: any) => {
          const input = await callArgs.adapter.ingest(callArgs.raw);
          const resolved = await callArgs.adapter.resolveTurn(
            input,
            { kind: "message", canStartAgentTurn: true },
            {},
          );
          await resolved.delivery.deliver({ text: "a very long answer" });
          return { dispatched: true };
        });

        const dispatchPromise = dispatchWhatsappInboundEvent({
          cfg: makeAllowlistCfg(),
          event,
          channelRuntime,
          sendText,
          markAsRead,
          downloadVoiceNoteMedia,
        });

        // Let the initial upfront markAsRead/typing call, ingest, and
        // resolveTurn settle (all microtask-resolvable, no real timers)
        // before clearing the mock -- only the keepalive's OWN interval
        // refreshes matter for the rest of this test.
        await vi.advanceTimersByTimeAsync(0);
        expect(runInbound).toHaveBeenCalledTimes(1);
        markAsRead.mockClear();

        await vi.advanceTimersByTimeAsync(20_000);
        expect(markAsRead).toHaveBeenCalledTimes(1);
        expect(markAsRead).toHaveBeenNthCalledWith(1, { messageId: "wamid.2", typing: true });

        await vi.advanceTimersByTimeAsync(20_000);
        expect(markAsRead).toHaveBeenCalledTimes(2);

        resolveSendText!();
        await dispatchPromise;

        // No further refreshes fire once dispatch has fully settled.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(markAsRead).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("still delivers a media reply as media, unaffected by the reply-sent flag", async () => {
      const { runInbound, channelRuntime } = makeChannelRuntime();
      const downloadVoiceNoteMedia = vi
        .fn()
        .mockResolvedValue({ path: "/sandbox/media/inbound/abc.ogg", contentType: "audio/ogg" });
      const sendMedia = vi.fn().mockResolvedValue(undefined);

      const event: MetaWebhookEvent = {
        sender: ALLOWED_SENDER,
        type: "audio",
        audioMediaId: "media.1",
        messageId: "wamid.2",
      };

      await dispatchWhatsappInboundEvent({
        cfg: makeAllowlistCfg(),
        event,
        channelRuntime,
        sendText: vi.fn(),
        sendMedia,
        downloadVoiceNoteMedia,
      });

      const call = runInbound.mock.calls[0][0];
      const resolved = await call.adapter.resolveTurn(
        { rawText: "", timestamp: Date.now() },
        { kind: "message", canStartAgentTurn: true },
        {},
      );

      const result = await resolved.delivery.deliver({
        mediaUrl: "https://example.com/cat.png",
        text: "here's your cat",
      });

      expect(sendMedia).toHaveBeenCalledWith({
        to: ALLOWED_SENDER,
        mediaUrl: "https://example.com/cat.png",
        caption: "here's your cat",
      });
      expect(result).toEqual({ visibleReplySent: true });
    });
  });

  it("delivers a control-command reply (e.g. /reset) as plain text, unwrapped -- never flagged as a fallback", async () => {
    // Regression test: control commands are handled by the framework
    // BEFORE the agent ever runs, so there is no opportunity for
    // send_text_reply_for_whatsapp/send_voice_reply_for_whatsapp to fire.
    // Wrapping "Session reset." in the "no explicit send" fallback caption
    // would be actively wrong, not just unnecessary.
    hasControlCommandMock.mockReturnValue(true);
    try {
      const { runInbound, channelRuntime } = makeChannelRuntime();
      const sendText = vi.fn().mockResolvedValue(undefined);

      const event: MetaWebhookEvent = { sender: ALLOWED_SENDER, type: "text", text: "/reset", messageId: "wamid.1" };

      await dispatchWhatsappInboundEvent({ cfg: makeAllowlistCfg(), event, channelRuntime, sendText });

      const call = runInbound.mock.calls[0][0];
      const resolved = await call.adapter.resolveTurn(
        { rawText: "/reset", timestamp: Date.now() },
        { kind: "message", canStartAgentTurn: true },
        {},
      );

      const result = await resolved.delivery.deliver({ text: "✅ Session reset." });

      expect(sendText).toHaveBeenCalledWith({ to: ALLOWED_SENDER, text: "✅ Session reset." });
      expect(result).toEqual({ visibleReplySent: true });
    } finally {
      hasControlCommandMock.mockReturnValue(false);
    }
  });

  it("forwards media-only reply payloads via sendMedia instead of dropping them", async () => {
    const { runInbound, channelRuntime } = makeChannelRuntime();

    const event: MetaWebhookEvent = { sender: ALLOWED_SENDER, type: "text", text: "hi", messageId: "wamid.1" };
    const sendText = vi.fn();
    const sendMedia = vi.fn().mockResolvedValue(undefined);

    await dispatchWhatsappInboundEvent({
      cfg: makeAllowlistCfg(),
      event,
      channelRuntime,
      sendText,
      sendMedia,
    });

    const call = runInbound.mock.calls[0][0];
    const resolved = await call.adapter.resolveTurn(
      { rawText: "hi", timestamp: Date.now() },
      { kind: "message", canStartAgentTurn: true },
      {},
    );

    const result = await resolved.delivery.deliver({
      mediaUrl: "https://example.com/image.png",
      text: "a caption",
    });

    expect(sendMedia).toHaveBeenCalledWith({
      to: ALLOWED_SENDER,
      mediaUrl: "https://example.com/image.png",
      caption: "a caption",
    });
    expect(sendText).not.toHaveBeenCalled();
    expect(result).toEqual({ visibleReplySent: true });
  });

  it("marks the turn as replied after a media delivery, so trailing plain text isn't fallback-wrapped", async () => {
    // Regression test: generate_image_for_whatsapp saves the image but the
    // actual send happens through the framework's own `message` tool, which
    // arrives here as a mediaUrl deliver() payload -- not one of our two
    // explicit reply tools. Before this fix, that media send never called
    // markReplySent(), so any trailing agent text (e.g. a leftover "Sent."
    // acknowledgment) in the same turn got wrapped in the "no explicit send"
    // fallback warning even though the image had already gone out correctly.
    const { runInbound, channelRuntime } = makeChannelRuntime();

    const event: MetaWebhookEvent = { sender: ALLOWED_SENDER, type: "text", text: "hi", messageId: "wamid.1" };
    const sendText = vi.fn().mockResolvedValue(undefined);
    const sendMedia = vi.fn().mockResolvedValue(undefined);

    await dispatchWhatsappInboundEvent({
      cfg: makeAllowlistCfg(),
      event,
      channelRuntime,
      sendText,
      sendMedia,
    });

    const call = runInbound.mock.calls[0][0];
    const resolved = await call.adapter.resolveTurn(
      { rawText: "hi", timestamp: Date.now() },
      { kind: "message", canStartAgentTurn: true },
      {},
    );

    await resolved.delivery.deliver({ mediaUrl: "https://example.com/moon.png", text: "here's your moon" });
    const result = await resolved.delivery.deliver({ text: "Sent." });

    expect(sendText).not.toHaveBeenCalled();
    expect(result).toEqual({ visibleReplySent: true });
  });

  it("marks the turn as replied via the mediaUrls array too, not just the singular mediaUrl field", async () => {
    // Same fix as above, but exercising the plural mediaUrls[0] fallback
    // path (payload.mediaUrl ?? payload.mediaUrls?.[0]) which had zero
    // coverage -- only the singular mediaUrl field was ever tested.
    const { runInbound, channelRuntime } = makeChannelRuntime();

    const event: MetaWebhookEvent = { sender: ALLOWED_SENDER, type: "text", text: "hi", messageId: "wamid.1" };
    const sendText = vi.fn().mockResolvedValue(undefined);
    const sendMedia = vi.fn().mockResolvedValue(undefined);

    await dispatchWhatsappInboundEvent({
      cfg: makeAllowlistCfg(),
      event,
      channelRuntime,
      sendText,
      sendMedia,
    });

    const call = runInbound.mock.calls[0][0];
    const resolved = await call.adapter.resolveTurn(
      { rawText: "hi", timestamp: Date.now() },
      { kind: "message", canStartAgentTurn: true },
      {},
    );

    const mediaResult = await resolved.delivery.deliver({
      mediaUrls: ["https://example.com/first.png", "https://example.com/second.png"],
      text: "here's the first one",
    });

    expect(sendMedia).toHaveBeenCalledWith({
      to: ALLOWED_SENDER,
      mediaUrl: "https://example.com/first.png",
      caption: "here's the first one",
    });
    expect(mediaResult).toEqual({ visibleReplySent: true });

    const textResult = await resolved.delivery.deliver({ text: "Sent." });
    expect(sendText).not.toHaveBeenCalled();
    expect(textResult).toEqual({ visibleReplySent: true });
  });

  it("does not let a reply-tool call from a PREVIOUS turn suppress the fallback wrap on the NEXT turn for the same sender", async () => {
    // Regression test for resetReplySentFlag: dispatchWhatsappInboundEvent
    // calls resetReplySentFlag(sender) once per dispatch. Without that
    // reset actually taking effect, a stale "replied" flag left over from
    // an earlier turn (e.g. send_text_reply_for_whatsapp firing) would
    // wrongly suppress the fallback wrap on a later, unrelated turn where
    // nothing was actually sent.
    const { runInbound, channelRuntime } = makeChannelRuntime();
    const sendText = vi.fn().mockResolvedValue(undefined);

    const firstEvent: MetaWebhookEvent = {
      sender: ALLOWED_SENDER,
      type: "text",
      text: "first message",
      messageId: "wamid.1",
    };
    await dispatchWhatsappInboundEvent({ cfg: makeAllowlistCfg(), event: firstEvent, channelRuntime, sendText });
    const firstCall = runInbound.mock.calls[0][0];
    const firstResolved = await firstCall.adapter.resolveTurn(
      { rawText: "first message", timestamp: Date.now() },
      { kind: "message", canStartAgentTurn: true },
      {},
    );
    // Simulates send_text_reply_for_whatsapp firing during turn 1.
    markReplySent(ALLOWED_SENDER);
    await firstResolved.delivery.deliver({ text: "turn 1 reply, sent via the explicit tool" });
    expect(sendText).not.toHaveBeenCalled();

    const secondEvent: MetaWebhookEvent = {
      sender: ALLOWED_SENDER,
      type: "text",
      text: "second message",
      messageId: "wamid.2",
    };
    await dispatchWhatsappInboundEvent({ cfg: makeAllowlistCfg(), event: secondEvent, channelRuntime, sendText });
    const secondCall = runInbound.mock.calls[1][0];
    const secondResolved = await secondCall.adapter.resolveTurn(
      { rawText: "second message", timestamp: Date.now() },
      { kind: "message", canStartAgentTurn: true },
      {},
    );
    // Turn 2: no explicit tool fires this time, so this SHOULD fall back.
    const result = await secondResolved.delivery.deliver({ text: "turn 2 reply, no explicit send" });

    expect(sendText).toHaveBeenCalledWith({
      to: ALLOWED_SENDER,
      text: "⚠️ Fallback reply (no explicit send this turn):\n\nturn 2 reply, no explicit send",
    });
    expect(result).toEqual({ visibleReplySent: true });
  });

  it("logs, sends an error reply, and re-throws when channelRuntime.inbound.run rejects", async () => {
    const failure = new Error("kernel durable delivery failed");
    const { runInbound, channelRuntime } = makeChannelRuntime();
    runInbound.mockRejectedValue(failure);

    const event: MetaWebhookEvent = { sender: ALLOWED_SENDER, type: "text", text: "hi", messageId: "wamid.1" };
    const sendText = vi.fn().mockResolvedValue(undefined);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      dispatchWhatsappInboundEvent({
        cfg: makeAllowlistCfg(),
        event,
        channelRuntime,
        sendText,
      }),
    ).rejects.toThrow("kernel durable delivery failed");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(ALLOWED_SENDER),
      failure,
    );
    expect(sendText).toHaveBeenCalledWith({
      to: ALLOWED_SENDER,
      text: expect.stringContaining("error"),
    });

    consoleErrorSpy.mockRestore();
  });

  it("reacts with an error emoji on the original message, in addition to the text error reply, when dispatch fails", async () => {
    const failure = new Error("kernel durable delivery failed");
    const { runInbound, channelRuntime } = makeChannelRuntime();
    runInbound.mockRejectedValue(failure);

    const event: MetaWebhookEvent = { sender: ALLOWED_SENDER, type: "text", text: "hi", messageId: "wamid.1" };
    const sendText = vi.fn().mockResolvedValue(undefined);
    const sendReaction = vi.fn().mockResolvedValue(undefined);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      dispatchWhatsappInboundEvent({
        cfg: makeAllowlistCfg(),
        event,
        channelRuntime,
        sendText,
        sendReaction,
      }),
    ).rejects.toThrow("kernel durable delivery failed");

    expect(sendReaction).toHaveBeenCalledWith({
      to: ALLOWED_SENDER,
      messageId: "wamid.1",
      emoji: "❌",
    });
    expect(sendText).toHaveBeenCalledWith({
      to: ALLOWED_SENDER,
      text: expect.stringContaining("error"),
    });

    consoleErrorSpy.mockRestore();
  });

  it("does not attempt an error reaction when the event has no messageId", async () => {
    const failure = new Error("kernel durable delivery failed");
    const { runInbound, channelRuntime } = makeChannelRuntime();
    runInbound.mockRejectedValue(failure);

    const event: MetaWebhookEvent = { sender: ALLOWED_SENDER, type: "text", text: "hi" };
    const sendText = vi.fn().mockResolvedValue(undefined);
    const sendReaction = vi.fn().mockResolvedValue(undefined);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      dispatchWhatsappInboundEvent({
        cfg: makeAllowlistCfg(),
        event,
        channelRuntime,
        sendText,
        sendReaction,
      }),
    ).rejects.toThrow("kernel durable delivery failed");

    expect(sendReaction).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("still sends the text error reply and re-throws the original error when the error reaction itself fails", async () => {
    const failure = new Error("kernel durable delivery failed");
    const { runInbound, channelRuntime } = makeChannelRuntime();
    runInbound.mockRejectedValue(failure);

    const event: MetaWebhookEvent = { sender: ALLOWED_SENDER, type: "text", text: "hi", messageId: "wamid.1" };
    const sendText = vi.fn().mockResolvedValue(undefined);
    const sendReaction = vi.fn().mockRejectedValue(new Error("reaction api down"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      dispatchWhatsappInboundEvent({
        cfg: makeAllowlistCfg(),
        event,
        channelRuntime,
        sendText,
        sendReaction,
      }),
    ).rejects.toThrow("kernel durable delivery failed");

    expect(sendText).toHaveBeenCalledWith({
      to: ALLOWED_SENDER,
      text: expect.stringContaining("error"),
    });
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining(ALLOWED_SENDER),
      expect.any(Error),
    );

    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it("re-sends the typing indicator on an interval while a slow TEXT turn (e.g. a slow tool call) is in flight, not just voice replies", async () => {
    vi.useFakeTimers();
    try {
      const { runInbound, channelRuntime } = makeChannelRuntime();
      const sendText = vi.fn().mockResolvedValue(undefined);
      const markAsRead = vi.fn().mockResolvedValue(undefined);
      // A turn that legitimately takes far longer than Meta's ~25s typing
      // auto-clear window without ever touching the voice-reply path --
      // e.g. an agent turn that calls `generate_image_for_whatsapp`
      // (225-260s worst case, see `image-tool.ts`). The keepalive must cover
      // this too, not just `sendVoiceReply`'s synthesis leg.
      let resolveRun: (value: { dispatched: boolean }) => void;
      runInbound.mockReturnValue(
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
      );

      const event: MetaWebhookEvent = { sender: ALLOWED_SENDER, type: "text", text: "make me an image", messageId: "wamid.1" };

      const dispatchPromise = dispatchWhatsappInboundEvent({
        cfg: makeAllowlistCfg(),
        event,
        channelRuntime,
        sendText,
        markAsRead,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(runInbound).toHaveBeenCalledTimes(1);
      markAsRead.mockClear(); // clear the initial upfront call, only the keepalive's refreshes matter below

      await vi.advanceTimersByTimeAsync(20_000);
      expect(markAsRead).toHaveBeenCalledTimes(1);
      expect(markAsRead).toHaveBeenNthCalledWith(1, { messageId: "wamid.1", typing: true });

      await vi.advanceTimersByTimeAsync(40_000);
      expect(markAsRead).toHaveBeenCalledTimes(3);

      resolveRun!({ dispatched: true });
      await dispatchPromise;

      // No further refreshes fire once dispatch has fully settled.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(markAsRead).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds channelRuntime.inbound.run with a dispatch-level deadline so a hang anywhere in the dispatch chain surfaces through the existing error-reply catch instead of hanging forever", async () => {
    vi.useFakeTimers();
    try {
      const { runInbound, channelRuntime } = makeChannelRuntime();
      // Simulate any future hang anywhere in the dispatch chain (not just the
      // voice-note bug this fix targets) -- a promise that simply never
      // settles, e.g. a stuck tool call or a stuck delivery.
      runInbound.mockImplementation(() => new Promise(() => {}));

      const event: MetaWebhookEvent = { sender: ALLOWED_SENDER, type: "text", text: "hi", messageId: "wamid.1" };
      const sendText = vi.fn().mockResolvedValue(undefined);
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const resultPromise = dispatchWhatsappInboundEvent({
        cfg: makeAllowlistCfg(),
        event,
        channelRuntime,
        sendText,
      });
      const assertion = expect(resultPromise).rejects.toThrow(/timed out after 600000ms/);

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

      await assertion;
      expect(sendText).toHaveBeenCalledWith({
        to: ALLOWED_SENDER,
        text: expect.stringContaining("error"),
      });

      consoleErrorSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still re-throws the original error when the best-effort error reply itself fails to send", async () => {
    const failure = new Error("kernel durable delivery failed");
    const runInbound = vi.fn().mockRejectedValue(failure);
    const buildContext = vi.fn();
    const resolveStorePath = vi.fn();
    const recordInboundSession = vi.fn();
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn();

    const channelRuntime = {
      inbound: { run: runInbound, buildContext },
      session: { resolveStorePath, recordInboundSession },
      reply: { dispatchReplyWithBufferedBlockDispatcher },
    } as any;

    const event: MetaWebhookEvent = { sender: ALLOWED_SENDER, type: "text", text: "hi", messageId: "wamid.1" };
    const sendText = vi.fn().mockRejectedValue(new Error("send also failed"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      dispatchWhatsappInboundEvent({
        cfg: makeAllowlistCfg(),
        event,
        channelRuntime,
        sendText,
      }),
    ).rejects.toThrow("kernel durable delivery failed");

    expect(sendText).toHaveBeenCalledTimes(1);

    consoleErrorSpy.mockRestore();
  });

  it("marks the inbound message as read with typing before running the turn kernel", async () => {
    const runInbound = vi.fn().mockResolvedValue({ dispatched: true });
    const buildContext = vi.fn().mockReturnValue({ fake: "ctx" });
    const resolveStorePath = vi.fn().mockReturnValue("/fake/store");
    const recordInboundSession = vi.fn();
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn();

    const channelRuntime = {
      inbound: { run: runInbound, buildContext },
      session: { resolveStorePath, recordInboundSession },
      reply: { dispatchReplyWithBufferedBlockDispatcher },
    } as any;

    const event: MetaWebhookEvent = { sender: ALLOWED_SENDER, type: "text", text: "hi", messageId: "wamid.1" };
    const markAsRead = vi.fn().mockResolvedValue(undefined);
    const callOrder: string[] = [];
    markAsRead.mockImplementation(async () => {
      callOrder.push("markAsRead");
    });
    runInbound.mockImplementation(async () => {
      callOrder.push("run");
      return { dispatched: true };
    });

    await dispatchWhatsappInboundEvent({
      cfg: makeAllowlistCfg(),
      event,
      channelRuntime,
      sendText: vi.fn(),
      markAsRead,
    });

    expect(markAsRead).toHaveBeenCalledWith({ messageId: "wamid.1", typing: true });
    expect(callOrder).toEqual(["markAsRead", "run"]);
  });

  it("marks audio events as read with typing before running the turn kernel, same as text (voice notes are the slowest path)", async () => {
    const runInbound = vi.fn().mockResolvedValue({ admission: { kind: "drop", reason: "ingest-null" }, dispatched: false });
    const buildContext = vi.fn();
    const resolveStorePath = vi.fn();
    const recordInboundSession = vi.fn();
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn();

    const channelRuntime = {
      inbound: { run: runInbound, buildContext },
      session: { resolveStorePath, recordInboundSession },
      reply: { dispatchReplyWithBufferedBlockDispatcher },
    } as any;

    const event: MetaWebhookEvent = {
      sender: ALLOWED_SENDER,
      type: "audio",
      audioMediaId: "media.1",
      messageId: "wamid.2",
    };
    const markAsRead = vi.fn().mockResolvedValue(undefined);
    const callOrder: string[] = [];
    markAsRead.mockImplementation(async () => {
      callOrder.push("markAsRead");
    });
    runInbound.mockImplementation(async () => {
      callOrder.push("run");
      return { admission: { kind: "drop", reason: "ingest-null" }, dispatched: false };
    });

    await dispatchWhatsappInboundEvent({
      cfg: makeAllowlistCfg(),
      event,
      channelRuntime,
      sendText: vi.fn(),
      markAsRead,
    });

    expect(markAsRead).toHaveBeenCalledWith({ messageId: "wamid.2", typing: true });
    expect(callOrder).toEqual(["markAsRead", "run"]);
  });

  it("does not attempt to mark an event as read when it has no messageId", async () => {
    const { runInbound, channelRuntime } = makeChannelRuntime();

    const event: MetaWebhookEvent = { sender: ALLOWED_SENDER, type: "text", text: "hi" };
    const markAsRead = vi.fn().mockResolvedValue(undefined);

    await dispatchWhatsappInboundEvent({
      cfg: makeAllowlistCfg(),
      event,
      channelRuntime,
      sendText: vi.fn(),
      markAsRead,
    });

    expect(markAsRead).not.toHaveBeenCalled();
    expect(runInbound).toHaveBeenCalledTimes(1);
  });

  it("does not let a failed mark-as-read/typing call block dispatch", async () => {
    const runInbound = vi.fn().mockResolvedValue({ dispatched: true });
    const buildContext = vi.fn().mockReturnValue({ fake: "ctx" });
    const resolveStorePath = vi.fn().mockReturnValue("/fake/store");
    const recordInboundSession = vi.fn();
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn();

    const channelRuntime = {
      inbound: { run: runInbound, buildContext },
      session: { resolveStorePath, recordInboundSession },
      reply: { dispatchReplyWithBufferedBlockDispatcher },
    } as any;

    const event: MetaWebhookEvent = { sender: ALLOWED_SENDER, type: "text", text: "hi", messageId: "wamid.1" };
    const markAsRead = vi.fn().mockRejectedValue(new Error("read receipt api down"));
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      dispatchWhatsappInboundEvent({
        cfg: makeAllowlistCfg(),
        event,
        channelRuntime,
        sendText: vi.fn(),
        markAsRead,
      }),
    ).resolves.toBeUndefined();

    expect(runInbound).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining(ALLOWED_SENDER),
      expect.any(Error),
    );

    consoleWarnSpy.mockRestore();
  });

  it("accepts numeric senders and derives a deterministic session key", async () => {
    const { runInbound, channelRuntime } = makeChannelRuntime();

    const event: MetaWebhookEvent = { sender: `+${ALLOWED_SENDER}`, type: "text", text: "hi", messageId: "wamid.1" };

    await dispatchWhatsappInboundEvent({
      cfg: makeAllowlistCfg(),
      event,
      channelRuntime,
      sendText: vi.fn(),
    });

    const call = runInbound.mock.calls[0][0];
    const resolved = await call.adapter.resolveTurn(
      { rawText: "hi", timestamp: Date.now() },
      { kind: "message", canStartAgentTurn: true },
      {},
    );
    expect(resolved.routeSessionKey).toBe(`agent:whatsapp:+${ALLOWED_SENDER}`);
  });

  it("throws for a sender that is not a plausible phone number, avoiding session-key collisions", async () => {
    const { channelRuntime } = makeChannelRuntime();

    const event: MetaWebhookEvent = { sender: "1-234", type: "text", text: "hi", messageId: "wamid.1" };

    await expect(
      dispatchWhatsappInboundEvent({
        cfg: makeAllowlistCfg(),
        event,
        channelRuntime,
        sendText: vi.fn(),
      }),
    ).rejects.toThrow("Invalid WhatsApp sender: 1-234");
  });

  describe("DM allowlist enforcement", () => {
    it("rejects a sender not present in cfg.channels['whatsapp-cloud'].allowFrom without dispatching a turn", async () => {
      const { runInbound, channelRuntime } = makeChannelRuntime();
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const event: MetaWebhookEvent = { sender: "15551234567", type: "text", text: "hi", messageId: "wamid.1" };

      await dispatchWhatsappInboundEvent({
        cfg: makeAllowlistCfg(),
        event,
        channelRuntime,
        sendText: vi.fn(),
      });

      expect(runInbound).not.toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("15551234567"));

      consoleWarnSpy.mockRestore();
    });

    it("rejects every sender when the channel has no allowlist config at all (fail closed)", async () => {
      const { runInbound, channelRuntime } = makeChannelRuntime();
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const event: MetaWebhookEvent = { sender: ALLOWED_SENDER, type: "text", text: "hi", messageId: "wamid.1" };

      await dispatchWhatsappInboundEvent({
        cfg: {} as any,
        event,
        channelRuntime,
        sendText: vi.fn(),
      });

      expect(runInbound).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it("matches allowlisted senders whether or not the webhook sender includes a leading +", async () => {
      const { runInbound, channelRuntime } = makeChannelRuntime();

      const event: MetaWebhookEvent = { sender: `+${ALLOWED_SENDER}`, type: "text", text: "hi", messageId: "wamid.1" };

      await dispatchWhatsappInboundEvent({
        cfg: makeAllowlistCfg(),
        event,
        channelRuntime,
        sendText: vi.fn(),
      });

      expect(runInbound).toHaveBeenCalledTimes(1);
    });
  });

  describe("command-authorization facts", () => {
    it("marks commands.authorized true for an allowlisted sender sending a control command", async () => {
      const { runInbound, buildContext, channelRuntime } = makeChannelRuntime();

      const event: MetaWebhookEvent = { sender: ALLOWED_SENDER, type: "text", text: "/reset", messageId: "wamid.1" };

      await dispatchWhatsappInboundEvent({
        cfg: makeAllowlistCfg(),
        event,
        channelRuntime,
        sendText: vi.fn(),
      });

      const call = runInbound.mock.calls[0][0];
      await call.adapter.resolveTurn(
        { rawText: "/reset", timestamp: Date.now() },
        { kind: "message", canStartAgentTurn: true },
        {},
      );

      expect(buildContext).toHaveBeenCalledTimes(1);
      const buildContextCall = buildContext.mock.calls[0][0];
      expect(buildContextCall.access.commands.authorized).toBe(true);
      expect(buildContextCall.access.commands.allowTextCommands).toBe(true);
      expect(buildContextCall.access.commands.shouldBlockControlCommand).toBe(false);
    });

    it("still populates access.commands for a plain chat message from an allowlisted sender", async () => {
      const { runInbound, buildContext, channelRuntime } = makeChannelRuntime();

      const event: MetaWebhookEvent = { sender: ALLOWED_SENDER, type: "text", text: "hello there", messageId: "wamid.1" };

      await dispatchWhatsappInboundEvent({
        cfg: makeAllowlistCfg(),
        event,
        channelRuntime,
        sendText: vi.fn(),
      });

      const call = runInbound.mock.calls[0][0];
      await call.adapter.resolveTurn(
        { rawText: "hello there", timestamp: Date.now() },
        { kind: "message", canStartAgentTurn: true },
        {},
      );

      const buildContextCall = buildContext.mock.calls[0][0];
      expect(buildContextCall.access.commands).toBeDefined();
      expect(buildContextCall.access.commands.useAccessGroups).toBe(true);
    });
  });
});
