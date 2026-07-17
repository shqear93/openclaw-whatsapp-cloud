// Cartesia TTS client for outbound WhatsApp voice replies. Replaces the
// previous Deepgram TTS wiring (see `speech.ts`'s doc comment) to match how
// this stack's OTHER voice feature -- the real-time LiveKit voice agent,
// `livekit/agent/agent.py` -- already does TTS in production
// (`TTS_PROVIDER=cartesia`, `CARTESIA_MODEL=sonic-3`, a specific
// `CARTESIA_VOICE_ID` chosen for this stack; see `channel.ts` for how the
// WhatsApp-specific model/voice/language env vars default).
//
// Endpoint shape confirmed against Cartesia's own docs: `POST
// https://api.cartesia.ai/tts/bytes`, headers `Cartesia-Version: <date>` and
// `Authorization: Bearer <key>`, a JSON body of `{model_id, transcript,
// voice: {mode: "id", id}, language, output_format}`, and a raw-bytes
// (non-JSON) response body -- the same request/response shape as
// `speech.ts`'s (now-removed) Deepgram TTS call and `meta-client.ts`'s
// `uploadMedia`/`sendAudioBytes`, just against a different provider.

type FetchImpl = typeof fetch;

const CARTESIA_REQUEST_TIMEOUT_MS = 30_000;

// Cartesia's API is versioned via this header rather than the URL path.
// Pinned to a concrete date (not "latest") so a future Cartesia-side default
// bump can't silently change this plugin's request/response shape underneath
// it -- the same "don't trust an unpinned default" rationale as this
// plugin's other external API integrations.
const CARTESIA_API_VERSION = "2026-03-01";

export type CartesiaClientOptions = {
  apiKey: string;
  /** Cartesia `model_id`, e.g. `"sonic-3"`. */
  model: string;
  /** Cartesia voice UUID. */
  voiceId: string;
  fetchImpl?: FetchImpl;
};

export type CartesiaSynthesizeResult = {
  audioBytes: Uint8Array;
  /**
   * Always mp3: `synthesize` always requests `output_format.container: "mp3"`
   * -- the same container `meta-client.ts`'s `sendAudioBytes` already knows
   * how to upload/send as a WhatsApp voice note (see its
   * `DEFAULT_AUDIO_EXTENSIONS` map), proven working by the old Deepgram TTS
   * path this replaces.
   */
  mimeType: "audio/mpeg";
};

export function createCartesiaClient(options: CartesiaClientOptions) {
  const { apiKey, model, voiceId } = options;
  const fetchImpl: FetchImpl = options.fetchImpl ?? fetch;

  return {
    /**
     * Synthesizes speech via Cartesia's `/tts/bytes` endpoint. `language` is
     * an optional BCP-47-ish language code (e.g. `"ar"`, `"en"`) so a reply
     * comes back in the same language the user was speaking -- see
     * `channel.ts`'s `sendWhatsappCloudVoiceReply`, which sources this from
     * the same `WHATSAPP_STT_LANGUAGE` env var used for inbound STT.
     */
    async synthesize(text: string, language?: string): Promise<CartesiaSynthesizeResult> {
      const body = {
        model_id: model,
        transcript: text,
        voice: { mode: "id", id: voiceId },
        ...(language ? { language } : {}),
        output_format: {
          container: "mp3",
          sample_rate: 44100,
          bit_rate: 128000,
        },
      };

      let response: Response;
      try {
        response = await fetchImpl("https://api.cartesia.ai/tts/bytes", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Cartesia-Version": CARTESIA_API_VERSION,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(CARTESIA_REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        const original = error instanceof Error ? error : new Error(String(error));
        throw new Error(`Cartesia TTS request failed: ${original.message}`, { cause: original });
      }

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        throw new Error(`Cartesia TTS request rejected: status=${response.status} body=${bodyText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return { audioBytes: new Uint8Array(arrayBuffer), mimeType: "audio/mpeg" };
    },
  };
}

export type CartesiaClient = ReturnType<typeof createCartesiaClient>;
