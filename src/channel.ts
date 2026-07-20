import { readFile } from "node:fs/promises";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { Type } from "typebox";
import { createMetaClient, type MetaClient } from "./meta-client.js";
import { createWhatsappMessageAdapter, resolveImageBytesAndMimeType } from "./message-adapter.js";
import { createMetaWebhookHandler } from "./webhook.js";
import { dispatchWhatsappInboundEvent } from "./inbound.js";
import { generateImageForWhatsapp } from "./image-tool.js";
import { createCartesiaClient, type CartesiaClient } from "./cartesia.js";
import { createDeepgramClient, type DeepgramClient } from "./speech.js";
import { withDeadline } from "./timeout.js";
import { stripMarkdownForSpeech } from "./markdown-strip.js";
import { markReplySent } from "./reply-delivery-tracker.js";

const CHANNEL_ID = "whatsapp-cloud";

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * The Meta client needs credentials from env vars that are only guaranteed to
 * be loaded by the time `registerFull` runs, but `whatsappCloudPlugin` itself
 * (below) is built once at module-import time. Rather than constructing the
 * real client eagerly (which would throw at import time in any environment
 * where the plugin is merely loaded for inspection, e.g. `openclaw doctor`),
 * or building the plugin without a message adapter and mutating it in later
 * with `as any` once real credentials are available, this resolves the
 * client lazily on first actual send. This mirrors how the real bundled
 * channel plugins do it: `extensions/sms/src/channel.ts`'s `sendSmsText`
 * calls `resolveSmsAccount(cfg, accountId)` inside the send function itself,
 * and `extensions/whatsapp/src/channel.ts`'s outbound/message adapters
 * resolve the account (and its auth state) lazily per call via
 * `resolveWhatsAppAccount`/`loadWhatsAppChannelRuntime()` -- neither ever
 * mutates a pre-built plugin object post-construction.
 */
let cachedMetaClient: MetaClient | null = null;
function getMetaClient(): MetaClient {
  if (!cachedMetaClient) {
    cachedMetaClient = createMetaClient({
      accessToken: requiredEnv("WHATSAPP_ACCESS_TOKEN"),
      phoneNumberId: requiredEnv("WHATSAPP_PHONE_NUMBER_ID"),
      graphApiVersion: process.env.WHATSAPP_GRAPH_API_VERSION || undefined,
      maxMediaDownloadBytes: resolveMaxMediaDownloadBytes(),
    });
  }
  return cachedMetaClient;
}

// Overrides meta-client.ts's DEFAULT_MAX_MEDIA_DOWNLOAD_BYTES (20MB) --
// confirmed live: a real 41MB voice note was silently unprocessable under
// that fixed cap with no way to admit it without a code change. Invalid or
// non-positive values fall back to the default rather than disabling the
// cap entirely, since an unbounded download is a real resource-exhaustion
// risk, not a reasonable "opt out" setting.
function resolveMaxMediaDownloadBytes(): number | undefined {
  const raw = process.env.WHATSAPP_MAX_MEDIA_DOWNLOAD_BYTES?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// Same shape as `MetaClient`, but every method defers to `getMetaClient()` so
// construction (and therefore env var resolution) only happens once a send is
// actually attempted, never at module load.
const lazyMetaClient: MetaClient = {
  sendText: (params) => getMetaClient().sendText(params),
  sendAudio: (params) => getMetaClient().sendAudio(params),
  sendAudioBytes: (params) => getMetaClient().sendAudioBytes(params),
  sendImage: (params) => getMetaClient().sendImage(params),
  markAsRead: (params) => getMetaClient().markAsRead(params),
  downloadMedia: (mediaId) => getMetaClient().downloadMedia(mediaId),
  sendReaction: (params) => getMetaClient().sendReaction(params),
};

const messageAdapter = createWhatsappMessageAdapter(lazyMetaClient);

// WhatsApp-specific STT language override, sourced from `WHATSAPP_STT_LANGUAGE`
// (deliberately NOT the LiveKit voice agent's own `STT_LANGUAGE` env var --
// reusing that name would silently couple this plugin's config to
// `livekit/agent/agent.py`'s, which reads `STT_LANGUAGE` for a completely
// different feature).
//
// Unset by default -- see `DEFAULT_WHATSAPP_STT_MODEL` below for why. Setting
// this forces a single fixed Deepgram `language` value, which OVERRIDES
// auto-detection entirely (Deepgram forwards whatever is set here verbatim as
// the `language` query param, for any model). Two prior fixed defaults were
// each confirmed broken in production: hardcoded `language=ar` correctly
// fixed Arabic speech but mis-transcribed a user's mid-conversation switch to
// English as garbled Arabic-script phonetic transliteration (Deepgram forces
// every word into the one specified language's script/vocabulary); the
// follow-up `language=multi` (Nova-3's multilingual code-switching mode) then
// did the opposite -- Nova-3's `multi` mode's documented language list
// (English, Spanish, French, German, Hindi, Russian, Portuguese, Japanese,
// Italian, Dutch) does not include Arabic at all, so Arabic speech under
// `multi` was forced into the closest-sounding phonetics of one of those ten
// languages instead, producing nonsense transliterations (confirmed live:
// a real Arabic voice note came back as "walit surat makuk fadai al akaukab
// maris"). Nova's own `detect_language=true` auto-detect was independently
// confirmed NOT viable either: Deepgram's docs list Arabic as absent from
// that feature's 35 supported detection languages entirely. No Deepgram Nova
// mode does real Arabic+English code-switching.
//
// Attempt 4 (current): defaults to a fixed `"ar"`, paired with `nova-3` as
// the primary model (see `DEFAULT_WHATSAPP_STT_MODEL`), because a direct
// side-by-side comparison on the same real production audio -- confirmed
// live, not assumed -- showed `nova-3`+`language=ar` producing a correct
// Arabic-script transcript with word confidences of 0.60-0.99 ("مرحبا كيف
// حالك شو الاخبار"), while `whisper-large`'s auto-detection on the exact
// same file produced an English-lettered transliteration with confidences
// of only 0.05-0.61 ("marhaba how are you what's up") for the SAME pure
// Arabic speech -- Whisper had defaulted to English decoding instead of
// detecting Arabic. Since this user's real usage is predominantly pure
// Arabic, a fixed `language=ar` primary is measurably more accurate than
// auto-detection for the common case, at the cost of mis-transcribing a
// fully-English or heavily code-switched voice note (the original problem
// attempt 1 hit) -- accepted as a worse fallback case than a routinely
// wrong primary case. See `DEFAULT_WHATSAPP_STT_MODEL` for the Whisper
// fallback that exists specifically to catch that case.
function resolveWhatsappSttLanguage(): string | undefined {
  const value = process.env.WHATSAPP_STT_LANGUAGE?.trim();
  return value ? value : DEFAULT_WHATSAPP_STT_LANGUAGE;
}
const DEFAULT_WHATSAPP_STT_LANGUAGE = "ar";

// Defaults the primary STT model to `nova-3` (paired with the fixed
// `language=ar` above) rather than `whisper-large` -- see
// `resolveWhatsappSttLanguage`'s doc comment for the live comparison that
// motivated this. `whisper-large` is still used by default, unconditionally
// and without a forced language, as the fallback model in
// `createWhatsappCloudVoiceNoteTranscriber` below (see
// `resolveFallbackSttModel`) -- its independent ~100-language auto-detection
// is a better safety net for an English or mixed-language voice note than
// retrying `nova-3`+`ar` again, which would just get the wrong language a
// second time. `WHATSAPP_STT_MODEL`, if explicitly set, overrides the
// PRIMARY model only -- the fallback model is an entirely separate override
// (`WHATSAPP_STT_FALLBACK_MODEL`), since it exists specifically to catch what
// the primary gets wrong.
const DEFAULT_WHATSAPP_STT_MODEL = "nova-3";

function resolveWhatsappSttModel(): string {
  return process.env.WHATSAPP_STT_MODEL || DEFAULT_WHATSAPP_STT_MODEL;
}

// Cartesia TTS has no auto-detect concept -- a spoken reply must commit to
// one language, unlike Whisper's per-message STT auto-detection above. This
// is a genuinely separate, single-language default: `"ar"`, since the user's
// explicit ask ("I want talking in arabic") is about the primary/default
// spoken-reply experience. Independently overridable via
// `WHATSAPP_TTS_LANGUAGE` if a different default reply language is ever
// wanted, without affecting STT's auto-detection.
const DEFAULT_WHATSAPP_TTS_LANGUAGE = "ar";

function resolveWhatsappTtsLanguage(): string {
  return process.env.WHATSAPP_TTS_LANGUAGE || DEFAULT_WHATSAPP_TTS_LANGUAGE;
}

// Cartesia TTS defaults for WhatsApp voice replies -- distinctly-named from
// the LiveKit voice agent's own `CARTESIA_MODEL`/`CARTESIA_VOICE_ID` env vars
// (`livekit/agent/agent.py`) so this plugin's config can never silently leak
// into, or be leaked into by, that unrelated feature, even though both
// features may reasonably share the same underlying `CARTESIA_API_KEY`
// (same Cartesia account -- fine to reuse the literal secret, just not the
// per-feature model/voice/language config around it).
//
// `sonic-3` mirrors the LiveKit agent's own already-proven-good
// `CARTESIA_MODEL` default (`compose/features/compose.voice.yml`) -- no
// reason to pick a different Cartesia model for this feature.
const DEFAULT_WHATSAPP_CARTESIA_MODEL = "sonic-3";
// This is the LiveKit agent's actual *configured* production voice ID
// (confirmed via the real, non-secret `.env` values on the VPS:
// `CARTESIA_VOICE_ID=69f116b4-c5aa-45d3-a01c-d2e8d2c382a0`) -- deliberately
// NOT the LiveKit code's own hardcoded fallback default
// (`9626c31c-bec5-4cca-baa8-f8ba9e84c8bc`), which is only ever used if that
// env var is unset. Defaulting WhatsApp voice replies to the same
// already-chosen-good voice (same Cartesia account) is a better starting
// point than an arbitrary fresh choice; it can still be overridden
// independently via `WHATSAPP_CARTESIA_VOICE_ID` if a different voice ever
// makes sense for text-message-triggered replies specifically.
const DEFAULT_WHATSAPP_CARTESIA_VOICE_ID = "69f116b4-c5aa-45d3-a01c-d2e8d2c382a0";

// The `model_name` this plugin requests from the configured LiteLLM
// `/images/generations` endpoint (see ARCHITECTURE.md §5: the plugin only
// depends on that endpoint responding within its own timeout budget, not on
// any specific provider). Defaults to this project's own reference
// deployment's model name, but a deployer pointing at a differently-named
// LiteLLM deployment (or a different provider entirely) can override it
// without a code change.
const DEFAULT_WHATSAPP_IMAGE_GENERATION_MODEL = "pollinations-image";

function resolveWhatsappImageGenerationModel(): string {
  return process.env.WHATSAPP_IMAGE_GENERATION_MODEL || DEFAULT_WHATSAPP_IMAGE_GENERATION_MODEL;
}

// Same lazy-construction rationale as `getMetaClient()` above: building this
// eagerly at module-import time would throw in any environment where the
// plugin is merely loaded for inspection and CARTESIA_API_KEY isn't set.
let cachedCartesiaClient: CartesiaClient | null = null;
function getCartesiaClient(): CartesiaClient {
  if (!cachedCartesiaClient) {
    cachedCartesiaClient = createCartesiaClient({
      apiKey: requiredEnv("CARTESIA_API_KEY"),
      model: process.env.WHATSAPP_CARTESIA_MODEL || DEFAULT_WHATSAPP_CARTESIA_MODEL,
      voiceId: process.env.WHATSAPP_CARTESIA_VOICE_ID || DEFAULT_WHATSAPP_CARTESIA_VOICE_ID,
    });
  }
  return cachedCartesiaClient;
}

// One Deepgram client per requested model (`whisper-large` for the primary
// attempts, `nova-3` for the last-resort fallback) -- built lazily for the
// same reason as `getCartesiaClient()` above, and cached per model so a
// retry within the same process reuses the same client instance.
const cachedDeepgramClientsByModel = new Map<string, DeepgramClient>();
function getDeepgramClient(sttModel: string): DeepgramClient {
  let client = cachedDeepgramClientsByModel.get(sttModel);
  if (!client) {
    client = createDeepgramClient({ apiKey: requiredEnv("DEEPGRAM_API_KEY"), sttModel });
    cachedDeepgramClientsByModel.set(sttModel, client);
  }
  return client;
}

/**
 * Inbound media leg (voice notes and images): download the bytes from Meta
 * and save them to the sandboxed managed-media directory, handing back a
 * local file path for `inbound.ts` to set on the turn's native `media`
 * attachment facts. Generic across media kinds -- there's nothing
 * audio-specific in this function itself, only in how `inbound.ts` uses its
 * result (voice notes get a synchronous transcription pass alongside this;
 * images don't need one, since OpenClaw's own native image-understanding
 * pipeline handles the `"image"` capability correctly out of the box, unlike
 * the `"audio"` capability's `activeModel` override bug documented below).
 *
 * This replaces the previous bespoke inline-transcription approach (download
 * via `meta-client.ts` then run it straight through `speech.ts`'s custom
 * Deepgram `transcribe()` inside `ingest`), which was the confirmed root
 * cause of a real production incident: a multi-hour silent hang with no
 * error and no timeout firing, because that call ran in `ingest` -- a
 * pre-dispatch phase OpenClaw's built-in stuck-session watchdog does not
 * monitor (it only watches the phase after an agent's embedded model-call
 * run registers itself as active), and nothing in `inbound.ts` put an outer
 * deadline around the call itself.
 *
 * The fix is to hand the framework a local path via `MediaPath` instead of
 * transcribing here at all, so OpenClaw's OWN turn kernel
 * (`applyMediaUnderstandingIfNeeded`, confirmed against the installed
 * `openclaw` package's `dist/get-reply-*.js` and `dist/apply-*.js`) picks it
 * up automatically and transcribes it via the bundled `deepgram` extension's
 * `mediaUnderstandingProvider` (`dist/extensions/deepgram/media-understanding-provider.js`
 * -> `transcribeDeepgramAudio`), under the framework's own bounded
 * per-attachment timeout (`cfg.tools.media.audio.timeoutSeconds`, defaulting
 * to 60s -- `DEFAULT_TIMEOUT_SECONDS.audio` in the installed package's
 * `dist/defaults.constants-*.js`), with a clean skip on timeout instead of a
 * hang. `speech.ts`'s `transcribe()` is no longer called for the inbound leg
 * at all.
 *
 * `MediaPath` (a local path) is used rather than `MediaUrl` because Meta's
 * media download URLs require the app's Bearer access token to fetch (they
 * are not public pre-signed URLs), and the framework's own remote-media
 * fetch for `MediaUrl` (confirmed against `readRemoteMediaBuffer` in the
 * installed package, used by `MediaAttachmentCache.getBuffer`) does not
 * support attaching custom auth headers. This is the same
 * `saveMediaBuffer`-to-sandbox-then-path-reference pattern already proven
 * for outbound image delivery below (`generate_image_for_whatsapp`, fixed in
 * an earlier commit this session) -- `saveMediaBuffer`'s default `subdir`
 * ("inbound") is the one intended for exactly this direction.
 *
 * Reuses `meta-client.ts`'s already-working, already time-bounded
 * `downloadMedia` (its own 30s `AbortSignal.timeout` per request) -- that
 * part of the old flow was never the problem and stays as-is.
 */
export async function downloadWhatsappCloudInboundMedia(
  params: { mediaId: string },
): Promise<{ path: string; contentType: string }> {
  const { bytes, mimeType } = await lazyMetaClient.downloadMedia(params.mediaId);
  const saved = await saveMediaBuffer(Buffer.from(bytes), mimeType, "inbound");
  return { path: saved.path, contentType: saved.contentType ?? mimeType };
}

/**
 * Builds `inbound.ts`'s `transcribeVoiceNoteMedia` dependency.
 *
 * This calls Deepgram DIRECTLY via `speech.ts`'s `createDeepgramClient`,
 * NOT the framework's `transcribeAudioFile`
 * (`openclaw/plugin-sdk/media-understanding-runtime`). That switch is
 * deliberate and load-bearing, not a style choice: `transcribeAudioFile`'s
 * `activeModel.model` override is silently IGNORED for the `"audio"`
 * capability in the installed `openclaw` package (confirmed by reading the
 * installed `resolveActiveModelEntry` in `runner-*.js` -- for
 * `capability === "audio"` it calls `resolveDefaultMediaModelFromRegistry`
 * unconditionally instead of using `params.activeModel?.model`, unlike the
 * `"image"` capability branch, which does honor an explicit override). This
 * was proven, not assumed: pulling the actual request log from Deepgram's
 * own Management API (`GET /v1/projects/{id}/requests`) for the exact
 * timestamps of two real in-app transcription attempts showed BOTH hit
 * `path: "/v1/listen?model=nova-3"` -- never `whisper-large` -- despite this
 * plugin passing `activeModel: {provider: "deepgram", model:
 * "whisper-large"}` on every call. So every "Whisper" failure investigated
 * earlier was actually a `nova-3` call with no `language` override (since
 * `WHATSAPP_STT_LANGUAGE` defaults to unset for Whisper auto-detection),
 * which explains real empty-transcript failures on non-English speech far
 * more directly than any Whisper-specific flakiness theory. Calling
 * Deepgram directly here is the only way to actually control which model
 * this plugin's own STT attempts use, independent of the shared
 * `DEEPGRAM_STT_MODEL`/registry default (`nova-3`, used elsewhere in this
 * stack, e.g. the LiveKit voice agent) that `transcribeAudioFile` always
 * falls back to for audio regardless of `activeModel`.
 *
 * The framework's OWN post-hoc `applyMediaUnderstandingIfNeeded` pass (via
 * the native `media` fact set, §2.2 in ARCHITECTURE.md) still runs
 * separately as a backstop and is unaffected by this -- it always uses the
 * registry default (`nova-3`) regardless of what this function does.
 *
 * Retry/fallback ladder: two primary-model attempts (`nova-3`+`language=ar`
 * by default, see `resolveWhatsappSttModel`/`resolveWhatsappSttLanguage`)
 * with a real gap between them (`STT_RETRY_DELAY_MS`), then one final
 * attempt using `whisper-large` with NO forced language (real auto-detection)
 * as the fallback -- chosen specifically because it's a better safety net
 * for an English or heavily code-switched voice note than retrying the fixed
 * `language=ar` primary a second time, which would just get the wrong
 * language again. A result whose `text` is empty/whitespace-only is treated
 * the same as a thrown error and advances to the next rung, since Deepgram
 * can return a technically-successful response with an empty transcript.
 * All of this stays well inside `VOICE_TRANSCRIPTION_TIMEOUT_MS` (75s) in
 * `inbound.ts`.
 */
const STT_RETRY_DELAY_MS = 3_000;
// `WHATSAPP_STT_FALLBACK_MODEL`, if set, overrides only the last-resort
// fallback model -- the primary model/language pair (`WHATSAPP_STT_MODEL`/
// `WHATSAPP_STT_LANGUAGE`) is a separate, independent override. There's no
// equivalent override for the fallback's language: it stays unconditionally
// `undefined` (real auto-detection) by design, since that's the whole reason
// it exists as a safety net for whatever the primary got wrong (see
// `resolveWhatsappSttModel`'s doc comment) -- a fixed fallback language would
// defeat that purpose.
const DEFAULT_FALLBACK_STT_MODEL = "whisper-large";

function resolveFallbackSttModel(): string {
  return process.env.WHATSAPP_STT_FALLBACK_MODEL || DEFAULT_FALLBACK_STT_MODEL;
}
const FALLBACK_STT_LANGUAGE = undefined;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBlankTranscript(text: string): boolean {
  return text.trim().length === 0;
}

export function createWhatsappCloudVoiceNoteTranscriber(
  _cfg: unknown,
): (params: { filePath: string; contentType?: string }) => Promise<{ text?: string }> {
  const transcribeWith = async (
    filePath: string,
    contentType: string | undefined,
    sttModel: string,
    language: string | undefined,
  ): Promise<string> => {
    const audioBytes = await readFile(filePath);
    const text = await getDeepgramClient(sttModel).transcribe(
      audioBytes,
      contentType ?? "application/octet-stream",
      language,
    );
    if (isBlankTranscript(text)) {
      throw new Error(`Deepgram STT (${sttModel}) returned an empty transcript`);
    }
    return text;
  };

  return async ({ filePath, contentType }) => {
    const primaryModel = resolveWhatsappSttModel();
    const primaryLanguage = resolveWhatsappSttLanguage();
    const fallbackModel = resolveFallbackSttModel();

    try {
      const text = await transcribeWith(filePath, contentType, primaryModel, primaryLanguage);
      return { text };
    } catch (firstError) {
      console.warn(
        `[whatsapp-cloud] STT attempt 1 (${primaryModel}) failed, retrying after ${STT_RETRY_DELAY_MS}ms`,
        firstError,
      );
      await delay(STT_RETRY_DELAY_MS);
      try {
        const text = await transcribeWith(filePath, contentType, primaryModel, primaryLanguage);
        return { text };
      } catch (secondError) {
        console.warn(
          `[whatsapp-cloud] STT attempt 2 (${primaryModel}) also failed, falling back to ${fallbackModel}/${FALLBACK_STT_LANGUAGE}`,
          secondError,
        );
        const text = await transcribeWith(filePath, contentType, fallbackModel, FALLBACK_STT_LANGUAGE);
        return { text };
      }
    }
  };
}

// Cartesia TTS (`cartesia.ts`'s `synthesize`, its own 30s
// `AbortSignal.timeout`) and Meta's upload-then-send (`meta-client.ts`'s
// `sendAudioBytes`, an `uploadMedia` call and a `post` call, each with its
// own 30s `AbortSignal.timeout`) are three sequential network legs, each
// already individually time-bounded -- worst case 3 * 30s = 90s if every leg
// legitimately uses its full budget. Nothing bounds the OUTER composition of
// those three `await`s, though, which is the exact same root-cause class as
// the inbound hang this plugin's timeout wiring fixes elsewhere (a stuck
// retry, a hung DNS resolution, or anything else between/inside those awaits
// that doesn't honor its own `AbortSignal.timeout` would still hang
// forever). 100s gives enough headroom above the traced 90s worst case to
// not clip a legitimate slow-but-bounded reply, while still guaranteeing the
// turn fails cleanly (surfacing `inbound.ts`'s existing "something went
// wrong" error-reply fallback) instead of hanging.
const VOICE_REPLY_TIMEOUT_MS = 100_000;

/**
 * Voice-note outbound leg: synthesize the agent's text reply via Cartesia
 * TTS, then upload+send it as a WhatsApp voice note. Originally ported from
 * the old bridge's `whatsapp-bridge/app.py::_handle_audio_message` (its
 * `speech.synthesize` + `media_client.upload_media` +
 * `whatsapp_client.send_audio` sequence, which used Deepgram TTS) -- this
 * now uses Cartesia instead, matching how this stack's OTHER voice feature
 * (the real-time LiveKit voice agent, `livekit/agent/agent.py`) already does
 * TTS in production (`TTS_PROVIDER=cartesia`). See `inbound.ts`'s
 * `dispatchWhatsappInboundEvent` for where this is only wired in for
 * voice-originated turns (unconditional voice-in-voice-out symmetry, same as
 * the old bridge). There is no native OpenClaw TTS path for Cartesia either
 * (`speech-core`/`talk-voice`'s TTS abstraction only supports
 * `openai`/`microsoft`/`elevenlabs` providers), so this stays custom -- but
 * is wrapped in `withDeadline` (see `VOICE_REPLY_TIMEOUT_MS` above) so it
 * can't repeat the inbound leg's silent-hang failure mode.
 *
 * The reply is synthesized in `WHATSAPP_TTS_LANGUAGE` (see
 * `resolveWhatsappTtsLanguage`; defaults to Arabic, distinct from STT's
 * `WHATSAPP_STT_LANGUAGE`/`"multi"` code-switching default -- Cartesia has no
 * "multi" language, a spoken reply must commit to one language).
 *
 * `params.text` is the agent's RAW reply text, written for a markdown-
 * rendering chat surface (see `openclaw/workspace-whatsapp/AGENTS.md`'s
 * "Formatting" bullet) -- it can contain `**bold**`, `- bullet`, `### headers`,
 * `---` dividers, etc, none of which should be spoken literally by Cartesia.
 * `stripMarkdownForSpeech` (`markdown-strip.ts`) is a deterministic,
 * code-level backstop for that, applied here right before synthesis --
 * alongside (not instead of) the prompt-level instruction in
 * `workspace-whatsapp/AGENTS.md` telling the agent to reply in plain spoken
 * prose for voice-originated turns in the first place.
 */
export async function sendWhatsappCloudVoiceReply(params: { to: string; text: string }): Promise<void> {
  await withDeadline(
    (async () => {
      const { audioBytes, mimeType } = await getCartesiaClient().synthesize(
        stripMarkdownForSpeech(params.text),
        resolveWhatsappTtsLanguage(),
      );
      await lazyMetaClient.sendAudioBytes({ to: params.to, audioBytes, mimeType });
    })(),
    VOICE_REPLY_TIMEOUT_MS,
    `WhatsApp Cloud voice reply to ${params.to} (Cartesia TTS + Meta upload/send)`,
  );
}

/**
 * Bridges `dispatchWhatsappInboundEvent`'s `sendMedia` shape (a remote
 * `mediaUrl` string, since inbound reply payloads are never local file
 * paths) to `MetaClient.sendImage`'s shape (raw bytes + mime type). Reuses
 * `resolveImageBytesAndMimeType` from the outbound message adapter rather
 * than reimplementing the fetch-with-timeout/size-cap/ok-check hardening
 * from Task 7 -- it already solves exactly this problem for the URL-only
 * case (no `mediaReadFile` is ever passed here).
 */
export async function sendWhatsappCloudMedia(params: {
  to: string;
  mediaUrl: string;
  caption?: string;
}): Promise<void> {
  const { imageBytes, mimeType } = await resolveImageBytesAndMimeType({ mediaUrl: params.mediaUrl });
  await lazyMetaClient.sendImage({
    to: params.to,
    imageBytes,
    mimeType,
    caption: params.caption,
  });
}

type ResolvedWhatsappCloudAccount = {
  accountId: string;
};

const REQUIRED_ENV_VARS = [
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
] as const;

function isWhatsappCloudConfigured(): boolean {
  return REQUIRED_ENV_VARS.every((name) => Boolean(process.env[name]));
}

/**
 * `whatsappCloudPlugin` is fully assembled here, at module scope, exactly
 * like the real `smsPlugin`/`whatsappPlugin` exports in the OpenClaw
 * monorepo (`extensions/sms/src/channel.ts`, `extensions/whatsapp/src/channel.ts`).
 * `registerFull` below only adds registrations that genuinely require the
 * plugin API object (HTTP route, agent tool) -- it never mutates this plugin.
 */
export const whatsappCloudPlugin: ChannelPlugin<ResolvedWhatsappCloudAccount> =
  createChatChannelPlugin<ResolvedWhatsappCloudAccount>({
    base: {
      id: CHANNEL_ID,
      meta: {
        id: CHANNEL_ID,
        label: "WhatsApp Cloud",
        selectionLabel: "WhatsApp (Meta Cloud API)",
        detailLabel: "Meta WhatsApp Business Cloud API",
        docsPath: "/channels/whatsapp-cloud",
        docsLabel: "whatsapp-cloud",
        blurb:
          "Meta's official WhatsApp Business Cloud API, with inbound webhooks and outbound replies including images.",
        order: 90,
      },
      capabilities: {
        chatTypes: ["direct"],
        media: true,
        threads: false,
        reactions: false,
        edit: false,
        unsend: false,
        reply: false,
        effects: false,
        blockStreaming: false,
      },
      config: {
        listAccountIds: () => [DEFAULT_ACCOUNT_ID],
        resolveAccount: (_cfg, accountId) => ({
          accountId: accountId ?? DEFAULT_ACCOUNT_ID,
        }),
        isConfigured: () => isWhatsappCloudConfigured(),
        unconfiguredReason: () =>
          "WhatsApp Cloud requires WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET, and WHATSAPP_VERIFY_TOKEN.",
        describeAccount: (account) => ({
          accountId: account.accountId,
          name: "WhatsApp Cloud",
          configured: isWhatsappCloudConfigured(),
        }),
      },
      message: messageAdapter,
    },
  });

export function registerFull(api: any): void {
  const webhookHandler = createMetaWebhookHandler({
    verifyToken: requiredEnv("WHATSAPP_VERIFY_TOKEN"),
    appSecret: requiredEnv("WHATSAPP_APP_SECRET"),
    onEvent: (event) => {
      void dispatchWhatsappInboundEvent({
        cfg: api.config,
        event,
        channelRuntime: api.runtime.channel,
        sendText: async ({ to, text }) => {
          await lazyMetaClient.sendText({ to, text });
        },
        sendMedia: sendWhatsappCloudMedia,
        markAsRead: (params) => lazyMetaClient.markAsRead(params),
        sendReaction: async (params) => {
          await lazyMetaClient.sendReaction(params);
        },
        downloadVoiceNoteMedia: downloadWhatsappCloudInboundMedia,
        transcribeVoiceNoteMedia: createWhatsappCloudVoiceNoteTranscriber(api.config),
        downloadImageMedia: downloadWhatsappCloudInboundMedia,
      }).catch((err: unknown) => {
        api.logger?.error?.(`WhatsApp Cloud dispatch failed: ${String(err)}`);
      });
    },
  });

  // `registerPluginHttpRoute` (the standalone helper from
  // `openclaw/plugin-sdk/webhook-ingress`) resolves its target registry from
  // an AsyncLocalStorage-scoped "active" plugin registry pointer. During
  // `registerFull`, the registry that is being *built* for this gateway
  // startup pass is not yet the "active" one (it only becomes active via
  // `setActivePluginRegistry(...)` after all plugins finish loading), so a
  // route registered this way lands in a throwaway registry and is never
  // wired into the gateway's actual HTTP dispatch table -- the webhook path
  // then silently falls through to the Control UI's SPA catch-all. The
  // correct API for a route registered synchronously inside `register(api)`
  // is `api.registerHttpRoute(...)`, which is bound directly to the plugin
  // record/registry under construction (confirmed against the real
  // `ghcr.io/openclaw/openclaw:2026.5.27` image: its own internal deprecation
  // hint for the removed `api.registerHttpHandler` says "use
  // api.registerHttpRoute(...) for plugin-owned routes or
  // registerPluginHttpRoute(...) for dynamic lifecycle routes").
  api.registerHttpRoute({
    path: "/whatsapp-cloud/webhook",
    auth: "plugin",
    handler: webhookHandler,
  });

  const generateImageTool = {
    name: "generate_image_for_whatsapp",
    label: "Generate Image for WhatsApp",
    description: "Generate an image from a text prompt, for sending on WhatsApp.",
    parameters: Type.Object({
      prompt: Type.String(),
    }),
    execute: async (_toolCallId: string, params: unknown) => {
      const { prompt } = params as { prompt: string };
      const { imageBase64, contentType } = await generateImageForWhatsapp(
        { prompt },
        {
          baseUrl: requiredEnv("LITELLM_BASE_URL"),
          apiKey: requiredEnv("LITELLM_API_KEY"),
          model: resolveWhatsappImageGenerationModel(),
        },
      );
      // Mirror OpenClaw's own `image_generate`/`music_generate` tools
      // (`openclaw-tools-BUQsixTe.js`'s `executeImageGenerationJob`): save
      // the generated bytes to the sandboxed managed-media directory via
      // `saveMediaBuffer` (re-exported for plugins from
      // `openclaw/plugin-sdk/media-store`, confirmed real against the
      // installed `openclaw` package: `node_modules/openclaw/dist/plugin-sdk/media-store.js`
      // re-exports it from `../store-CkmEdlzm.js`, the same module the
      // bundled `image_generate` tool imports it from) and hand the agent
      // back a short file path instead of raw base64. Asking an LLM to
      // reproduce tens of thousands of characters of base64 verbatim across
      // tool-call retries is fundamentally unreliable -- in production this
      // produced a hallucinated ~200-byte placeholder PNG instead of the
      // real ~33KB image after a couple of retries. `saveMediaBuffer`'s
      // `subdir` must satisfy `isManagedMediaPathUnderRoot`
      // (`sandbox-paths-U414eGG1.js`): the first path segment under
      // `<mediaDir>/` has to be in `MANAGED_MEDIA_SUBDIRS` (just
      // `"outbound"`) or start with `"tool-"`. `"tool-whatsapp-image-generation"`
      // mirrors the bundled tool's own `"tool-image-generation"` subdir.
      const saved = await saveMediaBuffer(
        Buffer.from(imageBase64, "base64"),
        contentType,
        "tool-whatsapp-image-generation",
      );
      return {
        content: [
          {
            type: "text",
            text: `Image generated and saved to ${saved.path}. To send it, call the message tool with action="send", path="${saved.path}", and a short message (do NOT pass buffer/contentType or reconstruct base64 -- just reuse this exact path string). Omit target entirely to reply in the current conversation.`,
          },
        ],
        details: { path: saved.path, contentType: saved.contentType ?? contentType },
      };
    },
  };

  api.registerTool(generateImageTool);

  // Explicit reply-delivery tools -- the agent's plain final-text reply is
  // NO LONGER automatically delivered. Every reply, text or voice, must go
  // through one of these two tools, mirroring `generate_image_for_whatsapp`
  // + `message`'s existing explicit-delivery pattern instead of relying on
  // the turn kernel's automatic `durable()`/`deliver()` conversion. This
  // replaces the previous design where `durable()` auto-converted a
  // voice-originated turn's plain text reply to speech: that design gave
  // the agent no way to ever choose text on a voice-originated turn (or
  // voice on a text-originated one). See `inbound.ts`'s `deliver()` for the
  // fallback that still fires if a turn ends with neither tool called (a
  // safety net against a fully silent turn, not the primary mechanism).
  //
  // Both tools require an explicit `to` param rather than inferring the
  // recipient automatically (unlike the framework's own built-in `message`
  // tool, which has privileged access to `toolContext.currentChannelId`):
  // confirmed against the installed `openclaw` package's
  // `AnyAgentTool`/`ErasedAgentToolExecute` type that a plugin-registered
  // tool's `execute(toolCallId, params, signal?, onUpdate?)` signature
  // carries no session/channel context at all. The workaround is reliable
  // because every turn's prompt already includes a "Conversation info"
  // metadata block with `sender_id`/`chat_id` set to the sender's phone
  // number (confirmed live in real trajectory data) -- the agent copies
  // that value verbatim rather than us needing an ambient context lookup.
  //
  // `markReplySent` (`reply-delivery-tracker.ts`) records that an explicit
  // send happened for this sender, so `inbound.ts`'s `deliver()` can both
  // skip its fallback (avoid double-sending) and know when the fallback
  // needs to fire at all.
  const sendTextReplyTool = {
    name: "send_text_reply_for_whatsapp",
    label: "Send Text Reply on WhatsApp",
    description:
      'Send a plain text reply on WhatsApp. This is the ONLY way to deliver a text reply -- your plain final response text is NOT automatically sent. `to` must be the exact sender_id/chat_id value from this turn\'s "Conversation info" metadata block -- never invent or guess it.',
    parameters: Type.Object({
      to: Type.String(),
      text: Type.String(),
    }),
    execute: async (_toolCallId: string, params: unknown) => {
      const { to, text } = params as { to: string; text: string };
      await lazyMetaClient.sendText({ to, text });
      markReplySent(to);
      return {
        content: [{ type: "text" as const, text: "Text reply sent." }],
      };
    },
  };

  const sendVoiceReplyTool = {
    name: "send_voice_reply_for_whatsapp",
    label: "Send Voice Reply on WhatsApp",
    description:
      'Speak a reply on WhatsApp: synthesizes `text` to speech (Cartesia TTS) and sends it as a voice note. Use this for voice-originated turns (the default expectation) or any time you deliberately want a voice reply instead of text. `to` must be the exact sender_id/chat_id value from this turn\'s "Conversation info" metadata block -- never invent or guess it.',
    parameters: Type.Object({
      to: Type.String(),
      text: Type.String(),
    }),
    execute: async (_toolCallId: string, params: unknown) => {
      const { to, text } = params as { to: string; text: string };
      await sendWhatsappCloudVoiceReply({ to, text });
      markReplySent(to);
      return {
        content: [{ type: "text" as const, text: "Voice reply sent." }],
      };
    },
  };

  api.registerTool(sendTextReplyTool);
  api.registerTool(sendVoiceReplyTool);
}
