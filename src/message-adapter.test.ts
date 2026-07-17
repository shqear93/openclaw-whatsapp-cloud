import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createWhatsappMessageAdapter } from "./message-adapter.js";
import type { MetaClient } from "./meta-client.js";

function makeMetaClient(overrides: Partial<MetaClient> = {}): MetaClient {
  return {
    sendText: vi.fn().mockResolvedValue({ messageId: "wamid.text123" }),
    sendAudio: vi.fn().mockResolvedValue({ messageId: "wamid.audio123" }),
    sendImage: vi.fn().mockResolvedValue({ messageId: "wamid.image123" }),
    ...overrides,
  } as MetaClient;
}

describe("createWhatsappMessageAdapter", () => {
  it("exposes id and durableFinal capabilities", () => {
    const adapter = createWhatsappMessageAdapter(makeMetaClient());
    expect(adapter.id).toBe("whatsapp-cloud");
    expect(adapter.durableFinal).toEqual({
      capabilities: { text: true, media: true, messageSendingHooks: true },
    });
  });

  describe("send.text", () => {
    it("calls metaClient.sendText with to/text and returns a receipt and messageId", async () => {
      const metaClient = makeMetaClient();
      const adapter = createWhatsappMessageAdapter(metaClient);

      const result = await adapter.send!.text!({
        cfg: {} as never,
        to: "15551234567",
        text: "hello there",
      });

      expect(metaClient.sendText).toHaveBeenCalledWith({
        to: "15551234567",
        text: "hello there",
      });
      expect(result.messageId).toBe("wamid.text123");
      expect(result.receipt).toBeDefined();
      expect(result.receipt.platformMessageIds).toContain("wamid.text123");
      expect(result.receipt.primaryPlatformMessageId).toBe("wamid.text123");
    });

    it("propagates the error when metaClient.sendText rejects", async () => {
      const metaClient = makeMetaClient({
        sendText: vi.fn().mockRejectedValue(new Error("network down")),
      });
      const adapter = createWhatsappMessageAdapter(metaClient);

      await expect(
        adapter.send!.text!({
          cfg: {} as never,
          to: "15551234567",
          text: "hello there",
        }),
      ).rejects.toThrow("network down");
    });
  });

  describe("send.media", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      globalThis.fetch = vi.fn();
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("fetches remote media bytes and calls sendImage with fetched bytes/mimeType/caption", async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(bytes.buffer),
        headers: { get: (key: string) => (key.toLowerCase() === "content-type" ? "image/png" : null) },
      });

      const metaClient = makeMetaClient();
      const adapter = createWhatsappMessageAdapter(metaClient);

      const result = await adapter.send!.media!({
        cfg: {} as never,
        to: "15551234567",
        text: "a caption",
        mediaUrl: "https://example.com/photo.png",
      });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://example.com/photo.png",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(metaClient.sendImage).toHaveBeenCalledTimes(1);
      const call = (metaClient.sendImage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.to).toBe("15551234567");
      expect(call.mimeType).toBe("image/png");
      expect(call.caption).toBe("a caption");
      expect(new Uint8Array(call.imageBytes)).toEqual(bytes);
      expect(result.messageId).toBe("wamid.image123");
      expect(result.receipt.platformMessageIds).toContain("wamid.image123");
    });

    it("defaults mimeType to image/jpeg when content-type header is missing", async () => {
      const bytes = new Uint8Array([9, 9, 9]);
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(bytes.buffer),
        headers: { get: () => null },
      });

      const metaClient = makeMetaClient();
      const adapter = createWhatsappMessageAdapter(metaClient);

      await adapter.send!.media!({
        cfg: {} as never,
        to: "15551234567",
        text: "",
        mediaUrl: "https://example.com/photo",
      });

      const call = (metaClient.sendImage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.mimeType).toBe("image/jpeg");
      expect(call.caption).toBeUndefined();
    });

    it("reads local file bytes via mediaReadFile instead of fetching, deriving mimeType from extension", async () => {
      const bytes = Buffer.from([4, 5, 6]);
      const mediaReadFile = vi.fn().mockResolvedValue(bytes);
      const metaClient = makeMetaClient();
      const adapter = createWhatsappMessageAdapter(metaClient);

      const result = await adapter.send!.media!({
        cfg: {} as never,
        to: "15551234567",
        text: "local caption",
        mediaUrl: "/tmp/local/photo.webp",
        mediaReadFile,
      });

      expect(mediaReadFile).toHaveBeenCalledWith("/tmp/local/photo.webp");
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(metaClient.sendImage).toHaveBeenCalledTimes(1);
      const call = (metaClient.sendImage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.mimeType).toBe("image/webp");
      expect(call.caption).toBe("local caption");
      expect(new Uint8Array(call.imageBytes)).toEqual(new Uint8Array(bytes));
      expect(result.messageId).toBe("wamid.image123");
    });

    it("throws a clear error when the remote fetch returns a non-ok response", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 404,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        headers: { get: () => null },
      });

      const metaClient = makeMetaClient();
      const adapter = createWhatsappMessageAdapter(metaClient);

      await expect(
        adapter.send!.media!({
          cfg: {} as never,
          to: "15551234567",
          text: "a caption",
          mediaUrl: "https://example.com/missing.png",
        }),
      ).rejects.toThrow("Failed to fetch media from https://example.com/missing.png: 404");
      expect(metaClient.sendImage).not.toHaveBeenCalled();
    });

    it("rejects remote media that exceeds the size cap via content-length", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        headers: {
          get: (key: string) =>
            key.toLowerCase() === "content-length" ? String(21 * 1024 * 1024) : null,
        },
      });

      const metaClient = makeMetaClient();
      const adapter = createWhatsappMessageAdapter(metaClient);

      await expect(
        adapter.send!.media!({
          cfg: {} as never,
          to: "15551234567",
          text: "a caption",
          mediaUrl: "https://example.com/huge.png",
        }),
      ).rejects.toThrow(/exceeds maximum allowed size/);
      expect(metaClient.sendImage).not.toHaveBeenCalled();
    });

    it("forwards ctx.signal combined with the timeout signal to fetch", async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(bytes.buffer),
        headers: { get: () => null },
      });

      const metaClient = makeMetaClient();
      const adapter = createWhatsappMessageAdapter(metaClient);
      const controller = new AbortController();

      await adapter.send!.media!({
        cfg: {} as never,
        to: "15551234567",
        text: "a caption",
        mediaUrl: "https://example.com/photo.png",
        signal: controller.signal,
      });

      const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.signal.aborted).toBe(false);
      controller.abort();
      expect(options.signal.aborted).toBe(true);
    });

    it("propagates the error when metaClient.sendImage rejects", async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(bytes.buffer),
        headers: { get: () => null },
      });

      const metaClient = makeMetaClient({
        sendImage: vi.fn().mockRejectedValue(new Error("upload failed")),
      });
      const adapter = createWhatsappMessageAdapter(metaClient);

      await expect(
        adapter.send!.media!({
          cfg: {} as never,
          to: "15551234567",
          text: "a caption",
          mediaUrl: "https://example.com/photo.png",
        }),
      ).rejects.toThrow("upload failed");
    });

    it("propagates the error when mediaReadFile rejects", async () => {
      const mediaReadFile = vi.fn().mockRejectedValue(new Error("file not found"));
      const metaClient = makeMetaClient();
      const adapter = createWhatsappMessageAdapter(metaClient);

      await expect(
        adapter.send!.media!({
          cfg: {} as never,
          to: "15551234567",
          text: "local caption",
          mediaUrl: "/tmp/local/missing.webp",
          mediaReadFile,
        }),
      ).rejects.toThrow("file not found");
      expect(metaClient.sendImage).not.toHaveBeenCalled();
    });
  });
});
