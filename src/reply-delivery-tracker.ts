/**
 * Per-sender tracker for whether an explicit reply-delivery tool
 * (`send_text_reply_for_whatsapp`/`send_voice_reply_for_whatsapp`, both in
 * `channel.ts`) already fired during the CURRENT turn.
 *
 * This exists because custom plugin tools have no built-in way to observe
 * each other, and `inbound.ts`'s `deliver()` -- which handles the kernel's
 * plain final-text reply -- needs to know whether an explicit tool call
 * already delivered a reply this turn, for two reasons: (1) skip the plain
 * final-text fallback entirely if a tool already sent something, avoiding a
 * double-send, and (2) if NOTHING was explicitly sent, fall back to sending
 * the raw final text with a caption flagging it as a fallback rather than
 * leaving the turn silent.
 *
 * A separate module (not living in either `channel.ts` or `inbound.ts`)
 * avoids a circular import between the two.
 */
const sentThisTurnBySender = new Map<string, boolean>();

/** Call at the start of a turn (`inbound.ts`'s `ingest`) before any tool can run. */
export function resetReplySentFlag(sender: string): void {
  sentThisTurnBySender.set(sender, false);
}

/** Call from an explicit reply-delivery tool once it has actually sent something. */
export function markReplySent(sender: string): void {
  sentThisTurnBySender.set(sender, true);
}

/** Call from `deliver()` when the kernel's plain final-text reply arrives. */
export function wasReplySentThisTurn(sender: string): boolean {
  return sentThisTurnBySender.get(sender) === true;
}
