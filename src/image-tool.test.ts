import { describe, expect, it, vi } from "vitest";
import { generateImageForWhatsapp } from "./image-tool.js";

const CONFIG_BASE = {
  baseUrl: "http://litellm:4000",
  apiKey: "test-key",
  model: "pollinations-image",
};

describe("generateImageForWhatsapp", () => {
  it("calls LiteLLM's images/generations endpoint and returns raw base64 + contentType from b64_json", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: "aGVsbG8=" }] }),
    });

    const result = await generateImageForWhatsapp(
      { prompt: "a red circle on a white background" },
      { ...CONFIG_BASE, fetchImpl: fetchMock as unknown as typeof fetch },
    );

    expect(result.imageBase64).toBe("aGVsbG8=");
    expect(result.contentType).toBe("image/jpeg");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://litellm:4000/images/generations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        }),
      }),
    );
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: "pollinations-image",
      prompt: "a red circle on a white background",
      response_format: "b64_json",
    });
  });

  it("throws a clear error when LiteLLM returns a plain url instead of b64_json", async () => {
    // Both current backing providers (Pollinations.ai, AI Horde) always
    // populate b64_json themselves; a url-only response isn't a real shape
    // from this stack and can't be used as the `buffer` param the message
    // tool needs, so it's treated the same as "no image".
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ url: "https://example.com/generated.png" }] }),
    });

    await expect(
      generateImageForWhatsapp(
        { prompt: "a red circle" },
        { ...CONFIG_BASE, fetchImpl: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/no image/i);
  });

  it("strips a trailing slash from baseUrl before building the request URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: "aGVsbG8=" }] }),
    });

    await generateImageForWhatsapp(
      { prompt: "a red circle" },
      { ...CONFIG_BASE, baseUrl: "http://litellm:4000/", fetchImpl: fetchMock as unknown as typeof fetch },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://litellm:4000/images/generations",
      expect.anything(),
    );
  });

  it("throws a clear error when LiteLLM returns no image", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });

    await expect(
      generateImageForWhatsapp(
        { prompt: "..." },
        { ...CONFIG_BASE, fetchImpl: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/no image/i);
  });

  it("wraps a network-level failure with clear error context", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));

    await expect(
      generateImageForWhatsapp(
        { prompt: "a red circle" },
        { ...CONFIG_BASE, fetchImpl: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/LiteLLM image generation request failed.*network down/is);
  });

  it("throws a clear error when LiteLLM responds with a non-ok status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });

    await expect(
      generateImageForWhatsapp(
        { prompt: "a red circle" },
        { ...CONFIG_BASE, fetchImpl: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/429/);
  });

  it("wires a 260s AbortSignal timeout into the fetch call", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: "aGVsbG8=" }] }),
    });

    await generateImageForWhatsapp(
      { prompt: "a red circle" },
      { ...CONFIG_BASE, fetchImpl: fetchMock as unknown as typeof fetch },
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
