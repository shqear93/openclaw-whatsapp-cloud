import { describe, expect, it, vi } from "vitest";
import { createCartesiaClient } from "./cartesia.js";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as Response;
}

function audioResponse(bytes: Uint8Array, ok = true, status = 200) {
  return {
    ok,
    status,
    text: () => Promise.resolve("mp3 bytes"),
    arrayBuffer: () => Promise.resolve(bytes.buffer),
  } as unknown as Response;
}

describe("createCartesiaClient", () => {
  describe("synthesize", () => {
    it("posts JSON to /tts/bytes with model_id/transcript/voice/output_format and returns raw mp3 bytes", async () => {
      const mp3Bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
      const fetchImpl = vi.fn().mockResolvedValue(audioResponse(mp3Bytes));
      const client = createCartesiaClient({
        apiKey: "cartesia-key-123",
        model: "sonic-3",
        voiceId: "69f116b4-c5aa-45d3-a01c-d2e8d2c382a0",
        fetchImpl,
      });

      const result = await client.synthesize("hello there");

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe("https://api.cartesia.ai/tts/bytes");
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer cartesia-key-123");
      expect(init.headers["Cartesia-Version"]).toEqual(expect.any(String));
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(init.body);
      expect(body).toEqual({
        model_id: "sonic-3",
        transcript: "hello there",
        voice: { mode: "id", id: "69f116b4-c5aa-45d3-a01c-d2e8d2c382a0" },
        output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
      });
      expect(result.mimeType).toBe("audio/mpeg");
      expect(result.audioBytes).toEqual(mp3Bytes);
    });

    it("includes a language field in the request body when a language is passed", async () => {
      const mp3Bytes = new Uint8Array([1, 2, 3]);
      const fetchImpl = vi.fn().mockResolvedValue(audioResponse(mp3Bytes));
      const client = createCartesiaClient({
        apiKey: "cartesia-key-123",
        model: "sonic-3",
        voiceId: "voice-id",
        fetchImpl,
      });

      await client.synthesize("مرحبا", "ar");

      const [, init] = fetchImpl.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.language).toBe("ar");
    });

    it("omits the language field entirely when no language is passed", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(audioResponse(new Uint8Array([1])));
      const client = createCartesiaClient({
        apiKey: "cartesia-key-123",
        model: "sonic-3",
        voiceId: "voice-id",
        fetchImpl,
      });

      await client.synthesize("hi");

      const [, init] = fetchImpl.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body).not.toHaveProperty("language");
    });

    it("throws when Cartesia responds with an error status", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "bad key" }, false, 401));
      const client = createCartesiaClient({
        apiKey: "cartesia-key-123",
        model: "sonic-3",
        voiceId: "voice-id",
        fetchImpl,
      });

      await expect(client.synthesize("hi")).rejects.toThrow(/Cartesia TTS request rejected: status=401/);
    });

    it("wraps network-level fetch failures with operation context", async () => {
      const networkError = new Error("fetch failed: ECONNRESET");
      const fetchImpl = vi.fn().mockRejectedValue(networkError);
      const client = createCartesiaClient({
        apiKey: "cartesia-key-123",
        model: "sonic-3",
        voiceId: "voice-id",
        fetchImpl,
      });

      await expect(client.synthesize("hi")).rejects.toMatchObject({
        message: expect.stringContaining("Cartesia TTS request failed: fetch failed: ECONNRESET"),
        cause: networkError,
      });
    });
  });
});
