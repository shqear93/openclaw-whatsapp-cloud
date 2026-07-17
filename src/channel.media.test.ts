import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Regression coverage for the media-delivery wiring bug: `channel.ts` used to
// only pass `sendText` into `dispatchWhatsappInboundEvent`, so `sendMedia`
// was always undefined and `delivery.deliver` silently dropped every media
// reply (see inbound.ts). These tests prove (1) the standalone bridge
// function fetches the media URL and forwards correct bytes/mimeType/caption
// to `metaClient.sendImage`, and (2) `registerFull` actually wires that
// bridge into `dispatchWhatsappInboundEvent` as `sendMedia`.

const sendImageMock = vi.fn().mockResolvedValue({ messageId: "wamid.image123" });
const sendTextMock = vi.fn().mockResolvedValue({ messageId: "wamid.text123" });
const sendReactionMock = vi.fn().mockResolvedValue({ messageId: "wamid.reaction123" });

vi.mock("./meta-client.js", () => ({
  createMetaClient: vi.fn(() => ({
    sendText: sendTextMock,
    sendAudio: vi.fn(),
    sendAudioBytes: vi.fn(),
    sendImage: sendImageMock,
    downloadMedia: vi.fn(),
    markAsRead: vi.fn(),
    sendReaction: sendReactionMock,
  })),
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

describe("WhatsApp Cloud media delivery wiring", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnEvent = undefined;
    process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "test-phone-id";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
      headers: {
        get: (key: string) => (key.toLowerCase() === "content-type" ? "image/png" : null),
      },
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.WHATSAPP_VERIFY_TOKEN;
    delete process.env.WHATSAPP_APP_SECRET;
  });

  it("sendWhatsappCloudMedia fetches the media URL and forwards bytes/mimeType/caption to metaClient.sendImage", async () => {
    const { sendWhatsappCloudMedia } = await import("./channel.js");

    await sendWhatsappCloudMedia({
      to: "15551234567",
      mediaUrl: "https://example.com/photo.png",
      caption: "a caption",
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://example.com/photo.png",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(sendImageMock).toHaveBeenCalledTimes(1);
    const call = sendImageMock.mock.calls[0][0];
    expect(call.to).toBe("15551234567");
    expect(call.mimeType).toBe("image/png");
    expect(call.caption).toBe("a caption");
    expect(new Uint8Array(call.imageBytes)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("registerFull wires sendWhatsappCloudMedia as sendMedia into dispatchWhatsappInboundEvent", async () => {
    process.env.WHATSAPP_VERIFY_TOKEN = "verify-token";
    process.env.WHATSAPP_APP_SECRET = "app-secret";

    const { registerFull, sendWhatsappCloudMedia } = await import("./channel.js");

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
    expect(dispatchParams.sendMedia).toBe(sendWhatsappCloudMedia);

    // Prove the wired callback actually reaches metaClient.sendImage end to end.
    await dispatchParams.sendMedia({ to: "15551234567", mediaUrl: "https://example.com/x.png" });
    expect(sendImageMock).toHaveBeenCalledTimes(1);
  });

  it("registerFull wires sendReaction into dispatchWhatsappInboundEvent, reaching metaClient.sendReaction end to end", async () => {
    process.env.WHATSAPP_VERIFY_TOKEN = "verify-token";
    process.env.WHATSAPP_APP_SECRET = "app-secret";

    const { registerFull } = await import("./channel.js");

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
    expect(typeof dispatchParams.sendReaction).toBe("function");

    await dispatchParams.sendReaction({ to: "15551234567", messageId: "wamid.1", emoji: "❌" });
    expect(sendReactionMock).toHaveBeenCalledWith({
      to: "15551234567",
      messageId: "wamid.1",
      emoji: "❌",
    });
  });
});
