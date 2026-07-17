// TypeScript port of the old bridge's `whatsapp-bridge/speech.py`
// (`DeepgramSpeech`), which was the proven, already-in-production Deepgram
// STT wiring before this plugin replaced the standalone `whatsapp-bridge`
// FastAPI service. The endpoint shape, headers, and default model name
// (`nova-3` STT, see `.env.example`'s `DEEPGRAM_STT_MODEL`) are carried over
// unchanged.
//
// TTS is no longer Deepgram's job here -- outbound WhatsApp voice replies
// now go through `cartesia.ts`'s Cartesia client instead (see `channel.ts`'s
// `sendWhatsappCloudVoiceReply`), matching the stack's OTHER voice feature
// (`livekit/agent/agent.py`'s real-time voice agent, `TTS_PROVIDER=cartesia`
// in production). This module is trimmed to STT-only accordingly.

type FetchImpl = typeof fetch;

const DEEPGRAM_REQUEST_TIMEOUT_MS = 30_000;

export type DeepgramClientOptions = {
  apiKey: string;
  sttModel: string;
  fetchImpl?: FetchImpl;
};

export function createDeepgramClient(options: DeepgramClientOptions) {
  const { apiKey, sttModel } = options;
  const fetchImpl: FetchImpl = options.fetchImpl ?? fetch;

  return {
    /**
     * Transcribes raw audio bytes via Deepgram's `/v1/listen` endpoint. The
     * audio bytes are sent as the raw request body (not JSON, not
     * multipart) with `Content-Type` set to the audio's own mime type --
     * the exact shape proven by `whatsapp-bridge/speech.py`'s `transcribe`.
     *
     * `language` is an optional Deepgram `language` query param (e.g. `"ar"`,
     * `"ar-SA"`, `"en"`) -- confirmed via Deepgram's own docs that `nova-3`
     * natively supports Arabic (and regional variants) via this param, no
     * different model needed. When omitted, Deepgram falls back to its own
     * default (English), which is the exact bug this param exists to let
     * callers avoid.
     */
    async transcribe(audioBytes: Uint8Array, mimeType: string, language?: string): Promise<string> {
      const url = new URL("https://api.deepgram.com/v1/listen");
      url.searchParams.set("model", sttModel);
      if (language) {
        url.searchParams.set("language", language);
      }

      let response: Response;
      try {
        response = await fetchImpl(url.toString(), {
          method: "POST",
          headers: {
            Authorization: `Token ${apiKey}`,
            "Content-Type": mimeType,
          },
          // `fetch`'s `BodyInit` typing wants a plain `Uint8Array<ArrayBuffer>`,
          // not the generic `Uint8Array<ArrayBufferLike>` callers may pass in
          // (e.g. a view straight off another `Response.arrayBuffer()`) --
          // copy through `Uint8Array.from` the same way `meta-client.ts`'s
          // `uploadMedia` copies bytes before handing them to `File`.
          body: Uint8Array.from(audioBytes) as BodyInit,
          signal: AbortSignal.timeout(DEEPGRAM_REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        const original = error instanceof Error ? error : new Error(String(error));
        throw new Error(`Deepgram STT request failed: ${original.message}`, { cause: original });
      }

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        throw new Error(`Deepgram STT request rejected: status=${response.status} body=${bodyText}`);
      }

      const data = (await response.json()) as {
        results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
      };
      const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript;
      if (transcript === undefined) {
        throw new Error("Deepgram STT response did not include a transcript");
      }
      return transcript;
    },
  };
}

export type DeepgramClient = ReturnType<typeof createDeepgramClient>;
