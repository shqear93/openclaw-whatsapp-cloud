import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import type { MetaWebhookEvent } from "./webhook.js";
import { withDeadline } from "./timeout.js";
import { markReplySent, resetReplySentFlag, wasReplySentThisTurn } from "./reply-delivery-tracker.js";

const CHANNEL_ID = "whatsapp-cloud";
const AGENT_ID = "whatsapp";

const SENDER_PATTERN = /^\+?\d+$/;

function sanitizeSender(sender: string): string {
  if (!SENDER_PATTERN.test(sender)) {
    throw new Error(`Invalid WhatsApp sender: ${sender}`);
  }
  return sender.replace(/[^a-zA-Z0-9_+]/g, "");
}

function sessionKeyFor(sender: string): string {
  return `agent:${AGENT_ID}:${sanitizeSender(sender)}`;
}

// Meta clears the "typing…" indicator automatically ~25s after it's shown,
// or once a reply is actually sent -- whichever comes first. That's fine for
// a fast reply, but the FULL dispatch this wraps (ingest, the agent turn,
// any tool calls it makes, and delivery) can legitimately take much longer
// than 25s -- not just for voice replies (Cartesia TTS streaming + Meta
// media upload for a long reply took ~40s in production), but for any turn
// that calls a slow tool: `generate_image_for_whatsapp` alone has a traced
// 225-260s worst case (see `image-tool.ts`), dwarfing the 25s window. Without
// a refresh, the indicator would go silent partway through any such turn --
// text-originated or voice-originated -- and the exchange looks broken even
// though nothing failed. `keepTypingIndicatorAlive` re-sends the typing
// indicator on an interval shorter than Meta's ~25s auto-clear window for as
// long as the dispatch this call wraps is still in flight, so the user keeps
// seeing "typing…" the whole time instead of it going silent partway
// through. Best-effort, same as the initial `markAsRead` call below: a
// failure here must never block or fail the actual dispatch.
const TYPING_INDICATOR_REFRESH_MS = 20_000;

function keepTypingIndicatorAlive(params: {
  markAsRead?: (params: { messageId: string; typing?: boolean }) => Promise<void>;
  messageId: string | undefined;
  sender: string;
}): () => void {
  if (!params.markAsRead || !params.messageId) {
    return () => {};
  }
  const markAsRead = params.markAsRead;
  const messageId = params.messageId;
  const timer = setInterval(() => {
    markAsRead({ messageId, typing: true }).catch((error) => {
      console.warn(`[whatsapp-cloud] failed to refresh typing indicator for ${params.sender}`, error);
    });
  }, TYPING_INDICATOR_REFRESH_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Defense-in-depth deadline around the ENTIRE dispatch chain
 * (`channelRuntime.inbound.run(...)`), not just the voice-note leg that
 * caused the confirmed production incident this commit fixes. The turn
 * kernel itself has no outer timeout of its own -- OpenClaw's stuck-session
 * watchdog only monitors the phase after an agent's embedded model-call run
 * registers itself as active, so any future hang anywhere else in the
 * dispatch chain (a plugin bug, a hung tool call, a stuck delivery) would be
 * just as silent and unrecoverable as the voice-note bug was.
 *
 * 10 minutes is chosen to comfortably exceed the worst-case latency of any
 * single tool call this plugin makes today (`image-tool.ts`'s
 * `generateImageForWhatsapp` alone has a traced 225s / ~260s worst case for
 * its own request) plus room for an agent turn that chains several tool
 * calls and retries, while still being a bounded ceiling rather than the
 * unbounded hang this incident was.
 */
const DISPATCH_DEADLINE_MS = 10 * 60 * 1000;

type InboundMediaFact = {
  path?: string;
  url?: string;
  contentType?: string;
  kind?: "image" | "video" | "audio" | "document" | "unknown";
  messageId?: string;
  /**
   * Confirmed against the installed `openclaw` package's
   * `runner.entries-*.js` (`normalizeAttachments`'s `alreadyTranscribed`
   * flag, sourced from `ctx.MediaTranscribedIndexes`, itself built from this
   * `transcribed` field in `kernel-*.js`'s `toInboundMediaFacts`): when
   * `true`, the framework's own `applyMediaUnderstandingIfNeeded` step skips
   * re-transcribing this attachment (`runner.entries-*.js`: `if (capability
   * === "audio" && item.alreadyTranscribed) return false;`). Set this once
   * `ingest` has already produced a transcript itself, so the framework
   * doesn't pay for (and doesn't overwrite `Body` with) a second, redundant
   * Deepgram call for the same audio.
   */
  transcribed?: boolean;
};

/**
 * Timeout for `transcribeVoiceNoteMedia` (below): the framework's own
 * `transcribeAudioFile` (`openclaw/plugin-sdk/media-understanding-runtime`)
 * is itself bounded by `cfg.tools.media.audio.timeoutSeconds`, defaulting to
 * 60s (confirmed against the installed package's
 * `defaults.constants-*.js`'s `DEFAULT_TIMEOUT_SECONDS.audio`) -- but this
 * plugin's whole raison d'etre this session has been "never trust a single
 * inner timeout to actually bound an `await` chain in `ingest`" (see
 * `timeout.ts`'s `withDeadline` doc comment, written after the confirmed
 * multi-hour hang incident). 75s gives headroom above that 60s default
 * config timeout while still guaranteeing `ingest` can't hang forever if
 * something inside the SDK call doesn't honor its own configured timeout.
 */
const VOICE_TRANSCRIPTION_TIMEOUT_MS = 75_000;

/**
 * `cfg.channels["whatsapp-cloud"].allowFrom` entries are configured as bare
 * E.164-without-plus digit strings (see `openclaw/config/openclaw.base.json`),
 * but Meta's webhook `from` field and our own sender pattern both tolerate a
 * leading `+`. Normalize it away so allowlist matching doesn't silently miss
 * a sender that's really the same number.
 */
function stripLeadingPlus(value: string): string {
  return value.startsWith("+") ? value.slice(1) : value;
}

/**
 * The turn kernel's command gate and this channel's own DM-allowlist
 * enforcement both go through the SDK's shared ingress resolver
 * (`openclaw/plugin-sdk/channel-ingress-runtime`) instead of hand-rolled
 * allowlist/command-authorization logic. This is the same helper the bundled
 * `extensions/sms` reference plugin uses (`resolveStableChannelMessageIngress`)
 * -- reusing it means our access-control semantics can't quietly drift from
 * the rest of the stack's channels.
 */
async function resolveWhatsappAccess(params: { cfg: OpenClawConfig; sender: string; rawText: string }) {
  const channelConfig = (params.cfg.channels?.[CHANNEL_ID] ?? {}) as {
    dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
    allowFrom?: Array<string | number>;
  };

  return await resolveStableChannelMessageIngress({
    channelId: CHANNEL_ID,
    accountId: DEFAULT_ACCOUNT_ID,
    cfg: params.cfg,
    identity: {
      key: "phone",
      entryIdPrefix: "whatsapp-cloud-entry",
      normalize: stripLeadingPlus,
    },
    subject: { stableId: params.sender },
    conversation: { kind: "direct", id: "direct" },
    event: { mayPair: true },
    dmPolicy: channelConfig.dmPolicy,
    allowFrom: channelConfig.allowFrom,
    command: {
      // WhatsApp has no native slash-command surface; text commands are the
      // only mechanism, same as the other text-command-only surfaces called
      // out in the slash-commands docs (WebChat/Signal/iMessage/...).
      allowTextCommands: true,
      hasControlCommand: hasControlCommand(params.rawText, params.cfg),
    },
  });
}

export async function dispatchWhatsappInboundEvent(params: {
  cfg: OpenClawConfig;
  event: MetaWebhookEvent;
  channelRuntime: {
    inbound: { run: Function; buildContext: Function };
    session: { resolveStorePath: Function; recordInboundSession: Function };
    reply: { dispatchReplyWithBufferedBlockDispatcher: Function };
  };
  sendText: (params: { to: string; text: string }) => Promise<void>;
  sendMedia?: (params: { to: string; mediaUrl: string; caption?: string }) => Promise<void>;
  markAsRead?: (params: { messageId: string; typing?: boolean }) => Promise<void>;
  /**
   * Best-effort visual error signal: reacts to the original inbound message
   * with an emoji (❌) when dispatch fails, alongside the existing text error
   * reply below -- a faster, more visible "something went wrong" cue than
   * waiting for the text reply alone, and closer to how a normal WhatsApp
   * bot signals failure. Same best-effort contract as `markAsRead`/`sendText`
   * in the catch block: a failure to react must never mask or block the
   * original error, which is always logged and re-thrown regardless.
   */
  sendReaction?: (params: { to: string; messageId: string; emoji: string }) => Promise<void>;
  /**
   * Voice-note support (see `whatsapp-bridge/app.py`'s `_handle_audio_message`,
   * the proven old-bridge behavior this replicates for the outbound leg):
   * `downloadVoiceNoteMedia` downloads the inbound audio from Meta and saves
   * it to the sandboxed media directory (see `channel.ts`'s
   * `downloadWhatsappCloudInboundMedia`), handing back a local file path.
   * `ingest` sets that path on the turn's native `media` attachment facts so
   * OpenClaw's OWN turn kernel still transcribes it automatically via the
   * bundled `deepgram` extension as a fallback/observability path, under the
   * framework's own bounded per-attachment timeout -- this plugin's bespoke
   * `speech.ts` `transcribe()` (Deepgram STT) is still never called for the
   * inbound leg. This replaces the previous inline `transcribeVoiceNote`
   * callback, which called that custom transcription directly inside
   * `ingest` with no outer deadline and was the confirmed root cause of a
   * real production incident: a multi-hour silent hang with no error and no
   * timeout firing, because `ingest` runs in a pre-dispatch phase OpenClaw's
   * stuck-session watchdog does not monitor.
   *
   * `ingest` ALSO now calls `transcribeVoiceNoteMedia` (below) synchronously
   * to get the transcript itself before returning, rather than relying
   * solely on the framework's post-hoc patch of `ctx.Body`/`BodyForAgent`
   * landing before the agent's prompt is built. See that param's doc comment
   * for the full rationale: a live production turn returned a bare
   * `NO_REPLY` for a real "hello how are you" voice note even though the
   * transcript displayed correctly in the Control UI's session view
   * afterward, and this makes the agent's actual input deterministic instead
   * of resting on an unproven-safe framework-internal race.
   *
   * Voice replies are no longer sent from here: `deliver` below never calls
   * a voice-synthesis callback directly. Delivery -- text or voice -- now
   * only happens via the agent explicitly calling
   * `send_text_reply_for_whatsapp`/`send_voice_reply_for_whatsapp`
   * (`channel.ts`), which call `lazyMetaClient.sendText`/
   * `sendWhatsappCloudVoiceReply` themselves and mark
   * `reply-delivery-tracker.ts`'s per-sender flag. `deliver` below only
   * ever sends a plain-text FALLBACK (flagged as such) if neither tool
   * fired during the turn.
   */
  downloadVoiceNoteMedia?: (params: { mediaId: string }) => Promise<{ path: string; contentType: string }>;
  /**
   * Synchronous, pre-dispatch transcription of the downloaded voice-note
   * file, wired (see `channel.ts`) to the framework's own
   * `transcribeAudioFile` (`openclaw/plugin-sdk/media-understanding-runtime`)
   * -- the same `mediaUnderstandingProvider`/`deepgram` machinery the turn
   * kernel's `applyMediaUnderstandingIfNeeded` uses internally, exported for
   * plugin use and confirmed against the installed `openclaw` package's
   * `dist/plugin-sdk/media-understanding-runtime.d.ts`.
   *
   * This blends the two approaches investigated across this session's voice
   * bug chain: the plugin still hands the framework native `media` facts
   * (below) purely for session bookkeeping/observability and as a fallback
   * (if this call is not configured, fails, or DEEPGRAM_API_KEY is unset,
   * the framework's own post-hoc `applyMediaUnderstandingIfNeeded` still
   * transcribes the attachment exactly as commit `2bc9f3e` set up) -- but
   * `ingest` now ALSO gets an actual transcript itself, synchronously,
   * before ever building `rawText`/`textForAgent`/`textForCommands`. That
   * removes any dependency on exactly when/whether the framework's own
   * post-hoc patch of `ctx.Body`/`BodyForAgent` lands relative to prompt
   * construction: tracing the installed package's `get-reply-*.js` (line
   * ~4347 `applyMediaUnderstandingIfNeeded`, awaited well before session
   * init at ~4374 and before `resolveReplyDirectives` builds the actual
   * prompt text) did not turn up a proven race, but a live production turn
   * still returned a bare `NO_REPLY` for a real "hello how are you" voice
   * note despite the transcript showing correctly in the Control UI's
   * session view afterward -- so this makes the agent's own input
   * deterministic rather than resting on that unproven-safe framework
   * internal. This does NOT reintroduce the original incident (a custom,
   * un-bounded Deepgram HTTP client called with no outer deadline): this
   * calls the framework's own now-timeout-bounded transcription runtime, and
   * `VOICE_TRANSCRIPTION_TIMEOUT_MS` puts a defense-in-depth outer deadline
   * around it exactly like every other network leg in this plugin.
   */
  transcribeVoiceNoteMedia?: (params: {
    filePath: string;
    contentType?: string;
  }) => Promise<{ text?: string }>;
  /**
   * Inbound image support: downloads the image bytes from Meta and saves
   * them to the sandboxed media directory (see `channel.ts`'s
   * `downloadWhatsappCloudInboundMedia`, the same generic helper voice notes
   * use), handing back a local file path that `ingest` sets on the turn's
   * native `media` attachment facts with `kind: "image"`. Unlike voice notes,
   * there is no separate synchronous "understanding" pass here: OpenClaw's
   * own native image-understanding pipeline handles the `"image"` capability
   * correctly out of the box (its `activeModel` override is honored,
   * confirmed by reading the installed package's `resolveActiveModelEntry`
   * -- unlike the `"audio"` capability's confirmed bug, see
   * `createWhatsappCloudVoiceNoteTranscriber`'s doc comment), so there's
   * nothing here to work around.
   *
   * Any caption Meta sends alongside the image becomes the turn's
   * `rawText`/`textForAgent`/`textForCommands`, exactly like a plain text
   * message -- an image with no caption yields an empty string, same as a
   * voice note with no successful transcript.
   */
  downloadImageMedia?: (params: { mediaId: string }) => Promise<{ path: string; contentType: string }>;
}): Promise<void> {
  const {
    cfg,
    event,
    channelRuntime,
    sendText,
    sendMedia,
    markAsRead,
    sendReaction,
    downloadVoiceNoteMedia,
    transcribeVoiceNoteMedia,
    downloadImageMedia,
  } = params;
  const sender = event.sender;
  const sessionKey = sessionKeyFor(sender);
  const rawText = event.type === "text" ? (event.text ?? "") : "";

  // Control commands (`/reset`, `/new`, etc.) are handled by the framework
  // BEFORE the agent ever runs, producing their own plain-text reply (e.g.
  // "Session reset.") directly -- there is no agent turn, so no opportunity
  // for send_text_reply_for_whatsapp/send_voice_reply_for_whatsapp to ever
  // fire. `deliver` below (same closure) uses this to skip the "no explicit
  // send" fallback wrapper for exactly this case -- wrapping a
  // control-command reply in that warning would be actively wrong, not
  // just unnecessary. Uses the same `hasControlCommand` detection the
  // framework itself relies on (already imported, already used for access
  // control below), rather than a second, potentially-divergent check.
  const isControlCommandTurn = hasControlCommand(rawText, cfg);

  const auth = await resolveWhatsappAccess({ cfg, sender, rawText });

  // This is the real access-control gate: enforce
  // `cfg.channels["whatsapp-cloud"].allowFrom` ourselves before ever handing
  // the event to the turn kernel. Today Meta's WhatsApp Cloud API test tier
  // masks this gap (only pre-approved test recipients can message the number
  // at all), but a production-verified Meta number has no such gate, so
  // relying on Meta to filter senders is not acceptable here.
  if (!auth.senderAccess.allowed) {
    console.warn(
      `[whatsapp-cloud] rejecting sender ${sender}: ${auth.senderAccess.reasonCode} (decision=${auth.senderAccess.decision})`,
    );
    return;
  }

  // Reset before the turn runs: `send_text_reply_for_whatsapp`/
  // `send_voice_reply_for_whatsapp` (`channel.ts`) mark this sender as
  // "replied to" the moment either tool fires during the turn.
  // `deliver()` below checks it once the turn's plain final reply arrives,
  // to decide whether the fallback needs to fire. Resetting here (not after
  // the previous turn's `deliver()`) keeps a stale "already sent" flag from
  // a prior turn from ever suppressing this turn's fallback.
  resetReplySentFlag(sender);

  // Mark the message read and show the "typing…" indicator as soon as we
  // start processing it -- before the (potentially slow) agent turn runs.
  // Meta clears the indicator automatically once we actually send a reply,
  // so there's no corresponding "stop typing" call needed. This is a
  // best-effort UX nicety, not part of the delivery-correctness path: a
  // failure here must never block or fail the actual message dispatch.
  // Voice notes are the slowest path in the plugin (Meta media download +
  // Deepgram STT + full agent turn + Cartesia TTS + Meta upload), so this
  // rationale applies even more strongly to them than to text -- hence
  // `audio` is included here alongside `text`, not just `text`. `image` is
  // included for the same reason: a real production gap, not a hypothetical
  // one -- confirmed live, a real image turn showed neither the read
  // receipt nor any typing indicator at all, since `keepTypingIndicatorAlive`
  // below only refreshes an already-started indicator (its first refresh
  // isn't due for TYPING_INDICATOR_REFRESH_MS), it never sends the first one.
  if (markAsRead && (event.type === "text" || event.type === "audio" || event.type === "image") && event.messageId) {
    try {
      await markAsRead({ messageId: event.messageId, typing: true });
    } catch (error) {
      console.warn(`[whatsapp-cloud] failed to mark message as read for ${sender}`, error);
    }
  }

  // Keep the indicator alive for the FULL dispatch below -- ingest, the
  // agent turn, any tool calls it makes, and delivery -- not just a single
  // reply-synthesis leg. See `keepTypingIndicatorAlive`'s doc comment above
  // for why a single upfront call isn't enough. No-ops if `markAsRead`/
  // `event.messageId` are unavailable, so this is always safe to call.
  const stopTypingRefresh = keepTypingIndicatorAlive({
    markAsRead,
    messageId: event.messageId,
    sender,
  });

  try {
    await withDeadline(
      channelRuntime.inbound.run({
        channel: CHANNEL_ID,
        raw: event,
        adapter: {
        // The real turn kernel `await`s `adapter.ingest(...)` before doing
        // anything else with it (confirmed against the installed
        // `openclaw` package's `kernel-*.js`: `const input = await
        // params.adapter.ingest(params.raw);`), so it's safe for `ingest`
        // itself to be async and do the download+transcribe work here
        // rather than needing some separate pre-dispatch step. The agent
        // never sees that the turn originated as audio -- by the time
        // `resolveTurn` runs, `rawText`/`textForAgent` are already plain
        // transcribed text, identical to a native text message.
        ingest: async (raw: MetaWebhookEvent) => {
          if (raw.type === "text") {
            return {
              id: raw.messageId ?? `${raw.sender}-${Date.now()}`,
              timestamp: Date.now(),
              rawText: raw.text ?? "",
              textForAgent: raw.text ?? "",
              textForCommands: raw.text ?? "",
              raw,
            };
          }

          if (raw.type === "audio" && raw.audioMediaId) {
            // No Deepgram wiring configured (e.g. DEEPGRAM_API_KEY unset) --
            // drop the turn cleanly exactly like the old "audio out of
            // scope" behavior, instead of throwing.
            if (!downloadVoiceNoteMedia) {
              return null;
            }
            // The download-to-sandbox step (already time-bounded, see
            // `meta-client.ts`'s `downloadMedia`) -- the unbounded custom
            // transcription call that caused the original production
            // incident stays removed from this pre-dispatch phase.
            const media = await downloadVoiceNoteMedia({ mediaId: raw.audioMediaId });

            // Transcribe synchronously via the framework's own
            // (timeout-bounded) media-understanding runtime, see
            // `transcribeVoiceNoteMedia`'s doc comment above for why this
            // exists alongside handing the framework native `media` facts.
            // A failure or missing callback here is NOT fatal: it just falls
            // back to the pre-existing behavior of an empty `rawText` and
            // relies on the framework's own post-hoc
            // `applyMediaUnderstandingIfNeeded` to fill in the transcript.
            let transcript = "";
            if (transcribeVoiceNoteMedia) {
              try {
                const result = await withDeadline(
                  transcribeVoiceNoteMedia({ filePath: media.path, contentType: media.contentType }),
                  VOICE_TRANSCRIPTION_TIMEOUT_MS,
                  `WhatsApp Cloud inbound voice-note transcription for ${raw.sender}`,
                );
                transcript = result.text?.trim() ?? "";
              } catch (error) {
                console.warn(
                  `[whatsapp-cloud] inbound voice-note transcription failed for ${raw.sender}, falling back to the framework's own post-hoc media understanding`,
                  error,
                );
              }
            }

            return {
              id: raw.messageId ?? `${raw.sender}-${Date.now()}`,
              timestamp: Date.now(),
              rawText: transcript,
              textForAgent: transcript,
              textForCommands: transcript,
              raw,
              media: [
                {
                  path: media.path,
                  contentType: media.contentType,
                  kind: "audio",
                  messageId: raw.messageId,
                  // Only mark it pre-transcribed when we actually got text --
                  // an empty/failed transcription should still leave the
                  // framework's own fallback path free to try.
                  transcribed: transcript.length > 0,
                },
              ] satisfies InboundMediaFact[],
            };
          }

          if (raw.type === "image" && raw.imageMediaId) {
            // No download wiring configured -- drop the turn cleanly rather
            // than throwing, mirroring the voice-note behavior above.
            if (!downloadImageMedia) {
              return null;
            }
            const media = await downloadImageMedia({ mediaId: raw.imageMediaId });
            const caption = raw.caption ?? "";

            return {
              id: raw.messageId ?? `${raw.sender}-${Date.now()}`,
              timestamp: Date.now(),
              rawText: caption,
              textForAgent: caption,
              textForCommands: caption,
              raw,
              media: [
                {
                  path: media.path,
                  contentType: media.contentType,
                  kind: "image",
                  messageId: raw.messageId,
                },
              ] satisfies InboundMediaFact[],
            };
          }

          // Any other/unrecognized event shape: drop the turn cleanly with
          // reason "ingest-null" instead of crashing or fabricating text.
          return null;
        },
        resolveTurn: async (input: { rawText: string; timestamp: number; media?: InboundMediaFact[] }) => {
          const ctxPayload = channelRuntime.inbound.buildContext({
            channel: CHANNEL_ID,
            timestamp: input.timestamp,
            from: `whatsapp-cloud:${sender}`,
            sender: { id: sender, name: sender },
            conversation: { kind: "direct", id: sender, label: sender },
            route: {
              agentId: AGENT_ID,
              routeSessionKey: sessionKey,
              dispatchSessionKey: sessionKey,
            },
            reply: { to: sender },
            message: {
              rawBody: input.rawText,
              commandBody: input.rawText,
              bodyForAgent: input.rawText,
            },
            // Native attachment fields: passing `InboundMediaFacts[]` here
            // (confirmed against the installed `openclaw` package's
            // `BuildChannelInboundEventContextParams` type, in
            // `dist/kernel-*.d.ts`) is how `buildChannelInboundEventContext`
            // (this is `channelRuntime.inbound.buildContext`, confirmed
            // against `dist/runtime-channel-*.js`) populates the built
            // context's `MediaPath`/`MediaType`/etc fields that the turn
            // kernel's `applyMediaUnderstandingIfNeeded` reads to run
            // transcription automatically -- this is the framework's real,
            // standard mechanism for inbound audio attachments, not a
            // bespoke one.
            media: input.media,
            access: {
              dm: {
                decision: auth.senderAccess.decision === "block" ? "deny" : auth.senderAccess.decision,
                reason: auth.senderAccess.reasonCode,
                allowFrom: [],
              },
              commands: {
                authorized: auth.commandAccess.authorized,
                shouldBlockControlCommand: auth.commandAccess.shouldBlockControlCommand,
                reasonCode: auth.commandAccess.reasonCode,
                useAccessGroups: cfg.commands?.useAccessGroups !== false,
                allowTextCommands: true,
              },
            },
          });
          const storePath = channelRuntime.session.resolveStorePath(cfg.session?.store, {
            agentId: AGENT_ID,
          });

          return {
            cfg,
            channel: CHANNEL_ID,
            agentId: AGENT_ID,
            routeSessionKey: sessionKey,
            storePath,
            ctxPayload,
            recordInboundSession: channelRuntime.session.recordInboundSession,
            dispatchReplyWithBufferedBlockDispatcher:
              channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher,
            delivery: {
              // Delivery is now agent-driven, not automatic: the agent must
              // explicitly call `send_text_reply_for_whatsapp` or
              // `send_voice_reply_for_whatsapp` (`channel.ts`) to actually
              // reach the user -- neither goes through this `durable`/
              // `deliver` pair at all (they call `lazyMetaClient.sendText`/
              // `sendWhatsappCloudVoiceReply` directly and mark
              // `reply-delivery-tracker.ts`'s per-sender flag). This
              // replaces the previous design, where a plain final-text
              // reply was itself the delivery mechanism (auto-converted to
              // voice for audio-originated turns via this same
              // `durable`/`deliver` pair) -- that design gave the agent no
              // way to ever choose text on a voice-originated turn, or
              // voice on a text-originated one.
              //
              // What's left here is ONLY the safety net: if the agent's
              // turn ends without either tool firing, `deliver` below still
              // sends the raw final text, but flagged as a fallback rather
              // than presented as a deliberate reply -- so a forgotten tool
              // call means a visibly-flagged message, not silence.
              //
              // Media payloads (`mediaUrl`/`mediaUrls`) are a DIFFERENT,
              // pre-existing case -- the kernel's own final-reply payload
              // occasionally carries media directly (unrelated to the
              // agent's explicit `message`-tool-based image sends, which
              // already bypass this pair entirely via
              // `message-adapter.ts`). That case is unaffected by this
              // change and still claims the durable path unconditionally.
              durable: (payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] }) => {
                const mediaUrl = payload.mediaUrl ?? payload.mediaUrls?.[0];
                if (mediaUrl) {
                  return { to: sender };
                }
                return false;
              },
              deliver: async (payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] }) => {
                const mediaUrl = payload.mediaUrl ?? payload.mediaUrls?.[0];
                if (mediaUrl) {
                  if (sendMedia) {
                    await sendMedia({ to: sender, mediaUrl, caption: payload.text });
                    markReplySent(sender);
                    return { visibleReplySent: true };
                  }
                  console.warn(
                    `[whatsapp-cloud] dropping media reply for ${sender}: no sendMedia callback configured`,
                  );
                  return { visibleReplySent: false };
                }
                if (payload.text) {
                  if (isControlCommandTurn) {
                    // A control-command reply (e.g. `/reset` -> "Session
                    // reset.") -- the framework handles this BEFORE the
                    // agent ever runs, so there was no opportunity for
                    // send_text_reply_for_whatsapp/
                    // send_voice_reply_for_whatsapp to fire and no "forgot
                    // to reply" failure to flag. Deliver as plain text,
                    // unwrapped.
                    await sendText({ to: sender, text: payload.text });
                    return { visibleReplySent: true };
                  }
                  if (wasReplySentThisTurn(sender)) {
                    // An explicit send_text_reply_for_whatsapp/
                    // send_voice_reply_for_whatsapp call already delivered
                    // this turn's reply -- the plain final text is
                    // leftover wrap-up/scratch content, not a second reply
                    // to send.
                    return { visibleReplySent: true };
                  }
                  // Fallback: a real agent turn ended without an explicit
                  // send. Surfacing the raw text (clearly flagged) beats
                  // leaving the user with silence and no error either.
                  await sendText({
                    to: sender,
                    text: `⚠️ Fallback reply (no explicit send this turn):\n\n${payload.text}`,
                  });
                  return { visibleReplySent: true };
                }
                console.warn(`[whatsapp-cloud] dropping empty reply payload for ${sender}`);
                return { visibleReplySent: false };
              },
            },
          };
        },
        },
      }),
      DISPATCH_DEADLINE_MS,
      `whatsapp-cloud inbound dispatch for ${sender}`,
    );
  } catch (error) {
    console.error(`[whatsapp-cloud] inbound.run failed for sender ${sender}`, error);
    // React with ❌ on the original message first -- a faster, more visible
    // failure signal than waiting for the text reply below. Best-effort,
    // same contract as everything else in this catch block: a failure here
    // must never mask or block the original error.
    if (sendReaction && event.messageId) {
      try {
        await sendReaction({ to: sender, messageId: event.messageId, emoji: "❌" });
      } catch (reactionError) {
        console.warn(`[whatsapp-cloud] failed to send error reaction to ${sender}`, reactionError);
      }
    }
    // Let the sender know something went wrong instead of leaving their
    // message answered by silence. Best-effort: if the error reply itself
    // fails to send, log it but still surface the original error to the
    // caller below -- that's the failure that actually matters.
    try {
      await sendText({
        to: sender,
        text: "Sorry, I ran into an error processing that message. Please try again in a moment.",
      });
    } catch (sendError) {
      console.error(`[whatsapp-cloud] failed to send error reply to ${sender}`, sendError);
    }
    throw error;
  } finally {
    stopTypingRefresh();
  }
}
