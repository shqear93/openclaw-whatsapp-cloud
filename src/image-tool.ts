type FetchImpl = typeof fetch;

export type GenerateImageInput = {
  prompt: string;
};

export type GenerateImageConfig = {
  /** LiteLLM proxy base URL, e.g. `http://litellm:4000` (no trailing slash required). */
  baseUrl: string;
  /** LiteLLM virtual/master API key. */
  apiKey: string;
  /** LiteLLM `model_name` to request -- expected to be `pollinations-image`. */
  model: string;
  fetchImpl?: FetchImpl;
};

export type GenerateImageResult = {
  /**
   * Raw base64-encoded image bytes -- NOT a `data:` URL, and no MIME
   * prefix.
   *
   * This is an intermediate value, not something that should ever reach the
   * agent directly: `channel.ts`'s `generate_image_for_whatsapp` tool
   * `execute` closure takes this and writes it to the sandboxed managed
   * media directory via `saveMediaBuffer`
   * (`openclaw/plugin-sdk/media-store`), then hands the agent back a short
   * `path` string. Handing the agent the raw base64 itself (the previous
   * design) required it to reproduce tens of thousands of characters
   * verbatim across `message`-tool retries, which is fundamentally
   * unreliable -- in production this degraded into a hallucinated
   * ~200-byte placeholder PNG after a couple of retries instead of the
   * real ~33KB image.
   *
   * Both current backing providers (Pollinations.ai and AI Horde, see
   * `litellm/bootstrap/custom_pollinations_image.py` and
   * `custom_ai_horde_image.py`) always populate `ImageObject(b64_json=...)`
   * themselves before LiteLLM's response is ever built, so this field is
   * always populated from LiteLLM's `b64_json`, never fetched from a
   * hosted URL.
   */
  imageBase64: string;
  /** MIME type of the image, e.g. "image/jpeg" -- passed through to `saveMediaBuffer` as the file's content type. */
  contentType: string;
};

function litellmImagesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/images/generations`;
}

export async function generateImageForWhatsapp(
  input: GenerateImageInput,
  config: GenerateImageConfig,
): Promise<GenerateImageResult> {
  const fetchImpl: FetchImpl = config.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(litellmImagesUrl(config.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        prompt: input.prompt,
        response_format: "b64_json",
      }),
      // Must exceed the worst-case latency of LiteLLM's full fallback
      // chain for `pollinations-image` (see litellm/config.yaml's
      // router_settings.fallbacks and per-deployment timeouts), not just a
      // single provider's timeout: a fallback's total worst-case latency is
      // the SUM of each attempt's deployment-level timeout, since the
      // router tries pollinations-image (45s timeout) and only then falls
      // back to ai-horde-image (180s timeout, since AI Horde's
      // anonymous-tier crowdsourced jobs can genuinely take minutes) on
      // failure. 45s + 180s = 225s worst case.
      //
      // This depends on litellm/config.yaml's `pollinations-image` and
      // `ai-horde-image` deployments both setting `num_retries: 0` to
      // override `router_settings.num_retries: 1` (a GLOBAL default that
      // would otherwise apply to them too). Traced through litellm 1.89.2's
      // actual router.py/exception_mapping_utils.py:
      // `async_function_with_fallbacks` calls `async_function_with_retries`
      // BEFORE ever falling back to the next model group, and a
      // CustomLLMError from these handlers maps to a retryable exception
      // type -- so without that override, a failing pollinations-image call
      // would retry the SAME deployment once before falling back even
      // starts (up to 90s), and a failing ai-horde-image call would do the
      // same (up to 360s), pushing the real worst case to ~450s. With
      // num_retries: 0 on both, worst case is genuinely 225s again.
      //
      // Set this client-side abort comfortably above that 225s worst case
      // (not just barely above it) so it can't fire before the server-side
      // fallback chain finishes and discard a request that might have
      // succeeded -- 260s gives ~35s of headroom for real-world variance
      // (network latency, LiteLLM's own overhead) on top of the traced
      // math.
      signal: AbortSignal.timeout(260_000),
    });
  } catch (error) {
    const original = error instanceof Error ? error : new Error(String(error));
    throw new Error(`LiteLLM image generation request failed: ${original.message}`, {
      cause: original,
    });
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(
      `LiteLLM image generation failed: status=${response.status} body=${bodyText}`,
    );
  }

  const data = (await response.json()) as {
    data?: { b64_json?: string; url?: string }[];
  };
  const first = data.data?.[0];
  const b64Json = first?.b64_json;
  if (b64Json) {
    return { imageBase64: b64Json, contentType: "image/jpeg" };
  }

  // We always request `response_format: "b64_json"` above, and both
  // current backing providers (Pollinations.ai and AI Horde) are custom
  // LiteLLM handlers that unconditionally populate `b64_json` themselves
  // (see litellm/bootstrap/custom_pollinations_image.py and
  // custom_ai_horde_image.py) -- neither ever returns a plain `url`. A
  // hosted-URL-only response is therefore not a real/expected shape from
  // this stack's current providers; treat it the same as no image at all
  // rather than silently returning a URL that can't be used as `buffer`.
  throw new Error("LiteLLM returned no image");
}
