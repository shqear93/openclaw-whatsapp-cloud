/**
 * Wraps `promise` with an explicit outer deadline so a hang anywhere inside
 * it (including a hang *between* otherwise time-bounded network calls, or in
 * code that doesn't honor `AbortSignal` at all) can never block forever.
 *
 * This exists because of a confirmed production incident: the old inbound
 * voice-note path (`await transcribeVoiceNote(...)` in `inbound.ts`) hung
 * silently for hours with no error and no timeout firing. Every individual
 * network call it made (`meta-client.ts`'s `downloadMedia`, `speech.ts`'s
 * `transcribe`) already had its own `AbortSignal.timeout(...)`, but nothing
 * bounded the *composition* of those calls, and the hang happened in
 * `ingest` -- a pre-dispatch phase OpenClaw's built-in stuck-session
 * watchdog does not monitor (it only watches the phase after an agent's
 * embedded model-call run registers itself as active). `withDeadline` is the
 * generic fix for that class of bug: any `await` sequence wrapped in it gets
 * an outer ceiling regardless of what's inside it.
 */
export function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Never let this pending timer keep the process alive on its own (it
    // will always be cleared below once `promise` settles first in the
    // common case) -- mirrors the same rationale as other background timers
    // in this codebase. `unref` is only available on Node's timer handle,
    // not the DOM one, hence the optional call.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
