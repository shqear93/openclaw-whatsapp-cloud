import { describe, expect, it, vi } from "vitest";
import { createDeepgramClient } from "./speech.js";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as Response;
}

describe("createDeepgramClient", () => {
  describe("transcribe", () => {
    it("posts raw audio bytes to /v1/listen with the configured model and mime-type content-type header", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({ results: { channels: [{ alternatives: [{ transcript: "hello there" }] }] } }),
      );
      const client = createDeepgramClient({
        apiKey: "dg-key-123",
        sttModel: "nova-3",
        fetchImpl,
      });
      const audioBytes = new Uint8Array([1, 2, 3, 4]);

      const transcript = await client.transcribe(audioBytes, "audio/ogg");

      expect(transcript).toBe("hello there");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe("https://api.deepgram.com/v1/listen?model=nova-3");
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Token dg-key-123");
      expect(init.headers["Content-Type"]).toBe("audio/ogg");
      expect(init.body).toEqual(audioBytes);
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("adds a language query param when a language is passed", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({ results: { channels: [{ alternatives: [{ transcript: "مرحبا" }] }] } }),
      );
      const client = createDeepgramClient({
        apiKey: "dg-key-123",
        sttModel: "nova-3",
        fetchImpl,
      });

      const transcript = await client.transcribe(new Uint8Array([1, 2, 3]), "audio/ogg", "ar");

      expect(transcript).toBe("مرحبا");
      const [url] = fetchImpl.mock.calls[0];
      expect(url).toBe("https://api.deepgram.com/v1/listen?model=nova-3&language=ar");
    });

    it("omits the language query param entirely when no language is passed", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({ results: { channels: [{ alternatives: [{ transcript: "hi" }] }] } }),
      );
      const client = createDeepgramClient({
        apiKey: "dg-key-123",
        sttModel: "nova-3",
        fetchImpl,
      });

      await client.transcribe(new Uint8Array([1]), "audio/ogg");

      const [url] = fetchImpl.mock.calls[0];
      expect(url).toBe("https://api.deepgram.com/v1/listen?model=nova-3");
    });

    it("throws when Deepgram responds with an error status", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "bad key" }, false, 401));
      const client = createDeepgramClient({
        apiKey: "dg-key-123",
        sttModel: "nova-3",
        fetchImpl,
      });

      await expect(client.transcribe(new Uint8Array([1]), "audio/ogg")).rejects.toThrow(
        /Deepgram STT request rejected: status=401/,
      );
    });

    it("throws when the response has no transcript field at all", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: { channels: [] } }));
      const client = createDeepgramClient({
        apiKey: "dg-key-123",
        sttModel: "nova-3",
        fetchImpl,
      });

      await expect(client.transcribe(new Uint8Array([1]), "audio/ogg")).rejects.toThrow(
        "Deepgram STT response did not include a transcript",
      );
    });

    it("wraps network-level fetch failures with operation context", async () => {
      const networkError = new Error("fetch failed: ECONNRESET");
      const fetchImpl = vi.fn().mockRejectedValue(networkError);
      const client = createDeepgramClient({
        apiKey: "dg-key-123",
        sttModel: "nova-3",
        fetchImpl,
      });

      await expect(client.transcribe(new Uint8Array([1]), "audio/ogg")).rejects.toMatchObject({
        message: expect.stringContaining("Deepgram STT request failed: fetch failed: ECONNRESET"),
        cause: networkError,
      });
    });
  });
});
