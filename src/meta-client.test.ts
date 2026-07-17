import { describe, expect, it, vi } from "vitest";
import { createMetaClient } from "./meta-client.js";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as Response;
}

describe("createMetaClient", () => {
  describe("sendText", () => {
    it("posts the text payload to the messages endpoint and returns the message id", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({ messages: [{ id: "wamid.text123" }] }),
      );
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      const result = await client.sendText({ to: "15551234567", text: "hello there" });

      expect(result).toEqual({ messageId: "wamid.text123" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe("https://graph.facebook.com/v21.0/555000/messages");
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer token-123");
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(init.body)).toEqual({
        messaging_product: "whatsapp",
        to: "15551234567",
        type: "text",
        text: { body: "hello there" },
      });
    });

    it("throws when the API responds with an error status", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({ error: { message: "bad token" } }, false, 401),
      );
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      await expect(client.sendText({ to: "15551234567", text: "hi" })).rejects.toThrow();
    });

    it("sets a 30s abort signal on the request", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({ messages: [{ id: "wamid.text123" }] }),
      );
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      await client.sendText({ to: "15551234567", text: "hello there" });

      const [, init] = fetchImpl.mock.calls[0];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("wraps network-level fetch failures with operation and recipient context", async () => {
      const networkError = new Error("fetch failed: getaddrinfo ENOTFOUND");
      const fetchImpl = vi.fn().mockRejectedValue(networkError);
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      await expect(
        client.sendText({ to: "15551234567", text: "hi" }),
      ).rejects.toMatchObject({
        message: expect.stringContaining(
          "WhatsApp API request failed (text message to 15551234567): fetch failed: getaddrinfo ENOTFOUND",
        ),
        cause: networkError,
      });
    });
  });

  describe("markAsRead", () => {
    it("posts a read receipt without a typing indicator by default", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ success: true }));
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      await client.markAsRead({ messageId: "wamid.inbound1" });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe("https://graph.facebook.com/v21.0/555000/messages");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        messaging_product: "whatsapp",
        status: "read",
        message_id: "wamid.inbound1",
      });
    });

    it("includes a text typing indicator when typing is true", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ success: true }));
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      await client.markAsRead({ messageId: "wamid.inbound1", typing: true });

      const [, init] = fetchImpl.mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({
        messaging_product: "whatsapp",
        status: "read",
        message_id: "wamid.inbound1",
        typing_indicator: { type: "text" },
      });
    });

    it("throws when the API responds with an error status", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({ error: { message: "bad token" } }, false, 401),
      );
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      await expect(
        client.markAsRead({ messageId: "wamid.inbound1", typing: true }),
      ).rejects.toThrow();
    });

    it("wraps network-level fetch failures with operation and message context", async () => {
      const networkError = new Error("fetch failed: getaddrinfo ENOTFOUND");
      const fetchImpl = vi.fn().mockRejectedValue(networkError);
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      await expect(
        client.markAsRead({ messageId: "wamid.inbound1" }),
      ).rejects.toMatchObject({
        message: expect.stringContaining(
          "WhatsApp API request failed (mark as read for message wamid.inbound1): fetch failed: getaddrinfo ENOTFOUND",
        ),
        cause: networkError,
      });
    });
  });

  describe("sendAudio", () => {
    it("posts the audio payload with the given media id", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({ messages: [{ id: "wamid.audio123" }] }),
      );
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      const result = await client.sendAudio({ to: "15551234567", mediaId: "media-abc" });

      expect(result).toEqual({ messageId: "wamid.audio123" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe("https://graph.facebook.com/v21.0/555000/messages");
      expect(JSON.parse(init.body)).toEqual({
        messaging_product: "whatsapp",
        to: "15551234567",
        type: "audio",
        audio: { id: "media-abc" },
      });
    });
  });

  describe("downloadMedia", () => {
    it("resolves the temp download url then fetches it, both requests bearer-authenticated", async () => {
      const audioBytes = new Uint8Array([1, 2, 3, 4]);
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/signed-url",
            mime_type: "audio/ogg; codecs=opus",
          }),
        )
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-length": String(audioBytes.byteLength) }),
          text: () => Promise.resolve(""),
          arrayBuffer: () => Promise.resolve(audioBytes.buffer),
        } as unknown as Response);
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      const result = await client.downloadMedia("media-abc");

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [metaUrl, metaInit] = fetchImpl.mock.calls[0];
      expect(metaUrl).toBe("https://graph.facebook.com/v21.0/media-abc");
      expect(metaInit.method).toBe("GET");
      expect(metaInit.headers.Authorization).toBe("Bearer token-123");

      const [dataUrl, dataInit] = fetchImpl.mock.calls[1];
      expect(dataUrl).toBe("https://lookaside.fbsbx.com/whatsapp_business/attachments/signed-url");
      expect(dataInit.headers.Authorization).toBe("Bearer token-123");

      expect(result.mimeType).toBe("audio/ogg; codecs=opus");
      expect(result.bytes).toEqual(audioBytes);
    });

    it("throws when the media lookup step fails and never attempts the download", async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(
        jsonResponse({ error: { message: "media not found" } }, false, 404),
      );
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      await expect(client.downloadMedia("media-abc")).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("throws when the lookup response has no download url", async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ mime_type: "audio/ogg" }));
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      await expect(client.downloadMedia("media-abc")).rejects.toThrow(
        "did not include a download url",
      );
    });

    it("throws when the download step fails after a successful lookup", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ url: "https://example.com/signed", mime_type: "audio/ogg" }))
        .mockResolvedValueOnce(jsonResponse({ error: "gone" }, false, 410));
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      await expect(client.downloadMedia("media-abc")).rejects.toThrow();
    });

    it("wraps network-level fetch failures during lookup with operation context", async () => {
      const networkError = new Error("connection reset");
      const fetchImpl = vi.fn().mockRejectedValueOnce(networkError);
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      await expect(client.downloadMedia("media-abc")).rejects.toMatchObject({
        message: expect.stringContaining("resolving media url for media-abc"),
        cause: networkError,
      });
    });

    it("rejects when the content-length header exceeds the 20MB cap, without buffering the body", async () => {
      const arrayBuffer = vi.fn();
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ url: "https://example.com/signed", mime_type: "audio/ogg" }),
        )
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-length": String(21 * 1024 * 1024) }),
          text: () => Promise.resolve(""),
          arrayBuffer,
        } as unknown as Response);
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      await expect(client.downloadMedia("media-abc")).rejects.toThrow(
        "exceeds maximum allowed size",
      );
      expect(arrayBuffer).not.toHaveBeenCalled();
    });

    it("rejects when the actual downloaded byte length exceeds the 20MB cap even without a content-length header", async () => {
      const oversized = new Uint8Array(21 * 1024 * 1024);
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ url: "https://example.com/signed", mime_type: "audio/ogg" }),
        )
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          text: () => Promise.resolve(""),
          arrayBuffer: () => Promise.resolve(oversized.buffer),
        } as unknown as Response);
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      await expect(client.downloadMedia("media-abc")).rejects.toThrow(
        "exceeds maximum allowed size",
      );
    });

    it("accepts media at or under the 20MB cap", async () => {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ url: "https://example.com/signed", mime_type: "audio/ogg" }),
        )
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-length": String(bytes.byteLength) }),
          text: () => Promise.resolve(""),
          arrayBuffer: () => Promise.resolve(bytes.buffer),
        } as unknown as Response);
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      const result = await client.downloadMedia("media-abc");
      expect(result.bytes).toEqual(bytes);
    });
  });

  describe("sendAudioBytes", () => {
    it("uploads the audio bytes as mp3 then sends a voice-note message referencing the returned media id", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ id: "media-xyz" }))
        .mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.audio789" }] }));
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });
      const audioBytes = new Uint8Array([1, 2, 3, 4]);

      const result = await client.sendAudioBytes({
        to: "15551234567",
        audioBytes,
        mimeType: "audio/mpeg",
      });

      expect(result).toEqual({ messageId: "wamid.audio789" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      const [uploadUrl, uploadInit] = fetchImpl.mock.calls[0];
      expect(uploadUrl).toBe("https://graph.facebook.com/v21.0/555000/media");
      const form = uploadInit.body as FormData;
      expect(form.get("type")).toBe("audio/mpeg");
      const file = form.get("file") as File;
      expect(file.name).toBe("reply.mp3");
      expect(file.type).toBe("audio/mpeg");

      const [sendUrl, sendInit] = fetchImpl.mock.calls[1];
      expect(sendUrl).toBe("https://graph.facebook.com/v21.0/555000/messages");
      expect(JSON.parse(sendInit.body)).toEqual({
        messaging_product: "whatsapp",
        to: "15551234567",
        type: "audio",
        audio: { id: "media-xyz" },
      });
    });

    it("throws when the upload step fails and never attempts to send the message", async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(
        jsonResponse({ error: { message: "upload failed" } }, false, 400),
      );
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      await expect(
        client.sendAudioBytes({
          to: "15551234567",
          audioBytes: new Uint8Array([1, 2, 3]),
          mimeType: "audio/mpeg",
        }),
      ).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendImage", () => {
    it("uploads the image bytes then sends a message referencing the returned media id", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ id: "media-xyz" }))
        .mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.image123" }] }));
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });
      const imageBytes = new Uint8Array([1, 2, 3, 4]);

      const result = await client.sendImage({
        to: "15551234567",
        imageBytes,
        mimeType: "image/jpeg",
        caption: "a photo",
      });

      expect(result).toEqual({ messageId: "wamid.image123" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      const [uploadUrl, uploadInit] = fetchImpl.mock.calls[0];
      expect(uploadUrl).toBe("https://graph.facebook.com/v21.0/555000/media");
      expect(uploadInit.method).toBe("POST");
      expect(uploadInit.headers.Authorization).toBe("Bearer token-123");
      expect(uploadInit.body).toBeInstanceOf(FormData);
      const form = uploadInit.body as FormData;
      expect(form.get("messaging_product")).toBe("whatsapp");
      expect(form.get("type")).toBe("image/jpeg");
      const file = form.get("file") as File;
      expect(file).toBeInstanceOf(File);
      expect(file.name).toBe("reply.jpg");
      expect(file.type).toBe("image/jpeg");
      const uploadedBytes = new Uint8Array(await file.arrayBuffer());
      expect(uploadedBytes).toEqual(imageBytes);

      const [sendUrl, sendInit] = fetchImpl.mock.calls[1];
      expect(sendUrl).toBe("https://graph.facebook.com/v21.0/555000/messages");
      expect(JSON.parse(sendInit.body)).toEqual({
        messaging_product: "whatsapp",
        to: "15551234567",
        type: "image",
        image: { id: "media-xyz", caption: "a photo" },
      });
    });

    it("omits the caption field when none is provided", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ id: "media-xyz" }))
        .mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.image456" }] }));
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      await client.sendImage({
        to: "15551234567",
        imageBytes: new Uint8Array([1, 2, 3]),
        mimeType: "image/png",
      });

      const [, sendInit] = fetchImpl.mock.calls[1];
      const body = JSON.parse(sendInit.body);
      expect(body.image).toEqual({ id: "media-xyz" });
      expect(body.image.caption).toBeUndefined();
    });

    it("throws when the upload step fails and never attempts to send the message", async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(
        jsonResponse({ error: { message: "upload failed" } }, false, 400),
      );
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      await expect(
        client.sendImage({
          to: "15551234567",
          imageBytes: new Uint8Array([1, 2, 3]),
          mimeType: "image/png",
        }),
      ).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("wraps network-level fetch failures during upload with operation and recipient context", async () => {
      const networkError = new Error("connection reset");
      const fetchImpl = vi.fn().mockRejectedValueOnce(networkError);
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      await expect(
        client.sendImage({
          to: "15551234567",
          imageBytes: new Uint8Array([1, 2, 3]),
          mimeType: "image/png",
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining(
          "WhatsApp API request failed (media upload to 15551234567): connection reset",
        ),
        cause: networkError,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendReaction", () => {
    it("posts a reaction message referencing the original message id and emoji", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({ messages: [{ id: "wamid.reaction1" }] }),
      );
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      const result = await client.sendReaction({
        to: "15551234567",
        messageId: "wamid.inbound1",
        emoji: "❌",
      });

      expect(result).toEqual({ messageId: "wamid.reaction1" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe("https://graph.facebook.com/v21.0/555000/messages");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        messaging_product: "whatsapp",
        to: "15551234567",
        type: "reaction",
        reaction: { message_id: "wamid.inbound1", emoji: "❌" },
      });
    });

    it("throws when the API responds with an error status", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({ error: { message: "bad token" } }, false, 401),
      );
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      await expect(
        client.sendReaction({ to: "15551234567", messageId: "wamid.inbound1", emoji: "❌" }),
      ).rejects.toThrow();
    });

    it("wraps network-level fetch failures with operation and recipient context", async () => {
      const networkError = new Error("fetch failed: getaddrinfo ENOTFOUND");
      const fetchImpl = vi.fn().mockRejectedValue(networkError);
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      await expect(
        client.sendReaction({ to: "15551234567", messageId: "wamid.inbound1", emoji: "❌" }),
      ).rejects.toMatchObject({
        message: expect.stringContaining(
          "WhatsApp API request failed (reaction to 15551234567): fetch failed: getaddrinfo ENOTFOUND",
        ),
        cause: networkError,
      });
    });

    it("sets a 30s abort signal on the request", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({ messages: [{ id: "wamid.reaction1" }] }),
      );
      const client = createMetaClient({
        accessToken: "token-123",
        phoneNumberId: "555000",
        fetchImpl,
      });

      await client.sendReaction({ to: "15551234567", messageId: "wamid.inbound1", emoji: "❌" });

      const [, init] = fetchImpl.mock.calls[0];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });
  });
});
