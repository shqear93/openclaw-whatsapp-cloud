# Inbound Message Envelope Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `MetaWebhookEvent` (the plugin's one internal shape for an inbound WhatsApp message) so content fields and forwarding/reply provenance are grouped as distinct concerns, instead of sitting flat at the same level — no behavior change for any currently-supported message flow.

**Architecture:** `type` → `kind` (rename), `audioMediaId`/`imageMediaId` → unified `media?: { mediaId: string }` (kind already disambiguates which), `caption` folds into `text` (they were already treated identically downstream), and the four provenance fields nest under one `provenance` object. Full rationale: `docs/superpowers/specs/2026-07-21-inbound-envelope-design.md`.

**Tech Stack:** TypeScript, Vitest, the `openclaw` plugin SDK's `SupplementalContextFacts`.

---

## Before you start

- Read `docs/superpowers/specs/2026-07-21-inbound-envelope-design.md` in full — this plan implements it, doesn't re-derive it.
- Check `gh pr view 5 --repo shqear93/openclaw-whatsapp-cloud --json state -q .state`. If it says `MERGED`, stop and re-read the spec's "Open risks" section before proceeding — the flat provenance shape will already be published as v1.3.0 and the sequencing assumption changed. If `OPEN`, proceed as planned (land this before merging that PR, so 1.3.0 ships the nested shape directly).
- Every task ends with `npx tsc --noEmit` and `npx vitest run` both clean, before committing. This repo has zero tolerance for either being red at a commit boundary — every prior change in this repo's history followed that rule, don't be the first to break it.

---

### Task 1: `webhook.ts` — new type shape + parser

**Files:**
- Modify: `src/webhook.ts:5-26` (the `MetaWebhookEvent` type), `src/webhook.ts:151-205` (`parseMetaWebhookPayload`)
- Modify: `src/webhook.test.ts:178-387` (the `describe("parseMetaWebhookPayload", ...)` block — all `toEqual` assertions)

- [ ] **Step 1: Update `MetaWebhookEvent`'s type definition**

Replace `src/webhook.ts:5-26` with:

```ts
export type MetaWebhookEvent = {
  sender: string;
  messageId?: string;
  kind: "text" | "audio" | "image";
  /**
   * Body text for a text message, or caption for an image message.
   * Audio messages never have one. Unified because `inbound.ts`'s `ingest`
   * already treats a text body and an image caption identically downstream
   * (`raw.text ?? ""` becomes `rawText`/`textForAgent`/`textForCommands`
   * either way) -- this was two names for the same concept.
   */
  text?: string;
  /**
   * Present for audio/image only. Which one it refers to is determined by
   * `kind`, not a field on `media` itself -- no redundant per-kind id field.
   */
  media?: { mediaId: string };
  /**
   * Meta's per-message `context` object carries forwarding/reply metadata
   * uniformly across all message types (text/audio/image), parsed once in
   * `parseMetaWebhookPayload` rather than duplicated per branch there. Meta
   * does NOT expose the *content* of a forwarded/quoted message via the
   * webhook -- only that forwarding happened, or a reference (id/sender) to
   * the quoted message -- there is no Cloud API endpoint to fetch an
   * arbitrary historical message's content by id.
   */
  provenance?: {
    forwarded?: boolean;
    frequentlyForwarded?: boolean;
    quotedMessageId?: string;
    quotedFrom?: string;
  };
};
```

- [ ] **Step 2: Update `parseMetaWebhookPayload`**

Replace `src/webhook.ts:151-205` with:

```ts
export function parseMetaWebhookPayload(payload: unknown): MetaWebhookEvent[] {
  const events: MetaWebhookEvent[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes ?? [];
    for (const change of changes) {
      const messages = (change as { value?: { messages?: unknown[] } })?.value?.messages ?? [];
      for (const message of messages) {
        const msg = message as {
          from?: string;
          id?: string;
          type?: string;
          text?: { body?: string };
          audio?: { id?: string };
          image?: { id?: string; caption?: string };
          context?: { from?: string; id?: string; forwarded?: boolean; frequently_forwarded?: boolean };
        };
        if (!msg.from) continue;
        // Forwarding/reply provenance is orthogonal to message type -- Meta
        // attaches `context` the same way to a forwarded/replied-to text,
        // audio, or image message, so extract it once here instead of
        // duplicating this per branch below.
        const provenanceFields = msg.context
          ? {
              ...(msg.context.forwarded ? { forwarded: true } : {}),
              ...(msg.context.frequently_forwarded ? { frequentlyForwarded: true } : {}),
              ...(msg.context.id ? { quotedMessageId: msg.context.id } : {}),
              ...(msg.context.from ? { quotedFrom: msg.context.from } : {}),
            }
          : {};
        const provenance = Object.keys(provenanceFields).length > 0 ? { provenance: provenanceFields } : {};
        if (msg.type === "text" && msg.text?.body) {
          events.push({ sender: msg.from, kind: "text", text: msg.text.body, messageId: msg.id, ...provenance });
        } else if (msg.type === "audio" && msg.audio?.id) {
          events.push({
            sender: msg.from,
            kind: "audio",
            media: { mediaId: msg.audio.id },
            messageId: msg.id,
            ...provenance,
          });
        } else if (msg.type === "image" && msg.image?.id) {
          events.push({
            sender: msg.from,
            kind: "image",
            media: { mediaId: msg.image.id },
            ...(msg.image.caption ? { text: msg.image.caption } : {}),
            messageId: msg.id,
            ...provenance,
          });
        }
      }
    }
  }
  return events;
}
```

Note the one behavioral wrinkle vs. the old flat version: previously each provenance field was spread individually (`...provenance` where `provenance` was `{}` or `{forwarded: true, ...}`), so an event with no `context` got no extra keys at all. Now `provenance` (the nested object) is only added as a key (`{ provenance: {...} }`) when `provenanceFields` is non-empty -- preserving the same "no provenance → no extra key on the event" behavior, just one level deeper. This is exactly what Task 1's Step 3 tests below assert.

- [ ] **Step 3: Update `webhook.test.ts`'s `parseMetaWebhookPayload` assertions**

Replace `src/webhook.test.ts:178-387` (every `toEqual` block in the `describe("parseMetaWebhookPayload", ...)` suite up through the end of "extracts an image message event with a caption") with the new expected shapes. The `payload` (input) objects are UNCHANGED in every case -- only the `expect(events).toEqual([...])` blocks change:

```ts
  it("extracts a text message event from a realistic Meta webhook payload", () => {
    // ... payload unchanged ...
    const events = parseMetaWebhookPayload(payload);

    expect(events).toEqual([
      {
        sender: "15551234567",
        kind: "text",
        text: "hello there",
        messageId: "wamid.abc123",
      },
    ]);
  });

  it("extracts forwarded/frequently_forwarded flags from a text message's context object", () => {
    // ... payload unchanged ...
    const events = parseMetaWebhookPayload(payload);

    expect(events).toEqual([
      {
        sender: "15551234567",
        kind: "text",
        text: "look at this",
        messageId: "wamid.fwd",
        provenance: { forwarded: true, frequentlyForwarded: true },
      },
    ]);
  });

  it("extracts a reply's quoted message id/sender from context.id/context.from, without forwarded flags", () => {
    // ... payload unchanged ...
    const events = parseMetaWebhookPayload(payload);

    expect(events).toEqual([
      {
        sender: "15551234567",
        kind: "text",
        text: "yes exactly",
        messageId: "wamid.reply",
        provenance: { quotedMessageId: "wamid.original", quotedFrom: "15551234567" },
      },
    ]);
  });

  it("does not add forwarding/reply fields when context is absent (no regression on plain messages)", () => {
    // ... payload unchanged ...
    const events = parseMetaWebhookPayload(payload);

    expect(events).toEqual([
      {
        sender: "15551234567",
        kind: "text",
        text: "hi",
        messageId: "wamid.plain",
      },
    ]);
  });

  it("extracts an audio message event", () => {
    // ... payload unchanged ...
    const events = parseMetaWebhookPayload(payload);

    expect(events).toEqual([
      {
        sender: "15551234567",
        kind: "audio",
        media: { mediaId: "media-abc" },
        messageId: "wamid.audio123",
      },
    ]);
  });

  it("extracts an image message event with a caption", () => {
    // ... payload unchanged ...
    const events = parseMetaWebhookPayload(payload);

    expect(events).toEqual([
      {
        sender: "15551234567",
        kind: "image",
        media: { mediaId: "media-img-abc" },
        text: "check this out",
        messageId: "wamid.image123",
      },
    ]);
  });
```

Continue past this point in the file: the remaining `parseMetaWebhookPayload` tests ("extracts an image message event with no caption", "silently drops a message with an unsupported type", "silently drops a message missing the from field", "returns an empty array when entry is missing", "returns an empty array when entry is empty") also assert `events`/`toEqual`. Apply the same mechanical mapping to each (`type` → `kind`, `imageMediaId`/`audioMediaId` → `media: { mediaId }`, `caption` → `text`) -- none of them exercise `context`/provenance, so none need a `provenance` key added.

- [ ] **Step 4: Verify and commit**

```bash
npx tsc --noEmit
```
Expected: clean (0 errors). If `webhook.ts` and `webhook.test.ts` are fully updated per Steps 1-3, this file pair alone type-checks -- but the REPO-WIDE `tsc --noEmit` will still show errors from `inbound.ts`/`inbound.test.ts` (Task 2, not done yet), since they still reference the old flat field names against the now-changed `MetaWebhookEvent` type. That's expected at this checkpoint -- do not attempt to silence those errors here.

```bash
npx vitest run src/webhook.test.ts
```
Expected: all tests in this file pass (this repo's suite runner scopes cleanly to one file's tests).

```bash
git add src/webhook.ts src/webhook.test.ts
git commit -m "refactor(webhook): normalize MetaWebhookEvent into kind/text/media/provenance"
```

---

### Task 2: `inbound.ts` — update every consumer of the old shape

**Files:**
- Modify: `src/inbound.ts` (multiple locations: rawText computation, `markAsRead` guard, `buildSupplementalContext`, all three `ingest` branches)
- Modify: `src/inbound.test.ts` (every `MetaWebhookEvent` literal in the file)

- [ ] **Step 1: Update the rawText computation and `markAsRead` type guard**

At `src/inbound.ts:396`, replace:
```ts
  const rawText = event.type === "text" ? (event.text ?? "") : "";
```
with:
```ts
  const rawText = event.kind === "text" ? (event.text ?? "") : "";
```

At `src/inbound.ts:449`, replace:
```ts
  if (markAsRead && (event.type === "text" || event.type === "audio" || event.type === "image") && event.messageId) {
```
with:
```ts
  if (markAsRead && (event.kind === "text" || event.kind === "audio" || event.kind === "image") && event.messageId) {
```

- [ ] **Step 2: Update `buildSupplementalContext` to read the nested `provenance` object**

Replace `src/inbound.ts:190-223` (the whole `buildSupplementalContext` function body, keeping its doc comment above at `169-189` unchanged) with:

```ts
function buildSupplementalContext(event: MetaWebhookEvent):
  | {
      forwarded?: { senderAllowed: boolean };
      quote?: { id: string; sender?: string; senderAllowed: boolean; isQuote: boolean };
      untrustedContext?: Array<{ label: string; type?: string; payload: unknown }>;
    }
  | undefined {
  const provenance = event.provenance;
  const forwarded = provenance?.forwarded ? { senderAllowed: true } : undefined;
  const quote = provenance?.quotedMessageId
    ? {
        id: provenance.quotedMessageId,
        ...(provenance.quotedFrom ? { sender: provenance.quotedFrom } : {}),
        senderAllowed: true,
        isQuote: true,
      }
    : undefined;
  const untrustedContext = provenance?.frequentlyForwarded
    ? [
        {
          label: "WhatsApp forwarding signal",
          type: "frequently_forwarded",
          payload: { frequentlyForwarded: true },
        },
      ]
    : undefined;
  if (!forwarded && !quote && !untrustedContext) {
    return undefined;
  }
  return {
    ...(forwarded ? { forwarded } : {}),
    ...(quote ? { quote } : {}),
    ...(untrustedContext ? { untrustedContext } : {}),
  };
}
```

- [ ] **Step 3: Update the three `ingest` branches**

Replace `src/inbound.ts:483-598` (the full body from `ingest: async (raw: MetaWebhookEvent) => {` through the end of the image branch, i.e. up to but not including the final `// Any other/unrecognized event shape` comment and `return null;`) with:

```ts
        ingest: async (raw: MetaWebhookEvent) => {
          if (raw.kind === "text") {
            return {
              id: raw.messageId ?? `${raw.sender}-${Date.now()}`,
              timestamp: Date.now(),
              rawText: raw.text ?? "",
              textForAgent: raw.text ?? "",
              textForCommands: raw.text ?? "",
              raw,
            };
          }

          if (raw.kind === "audio" && raw.media) {
            // No Deepgram wiring configured (e.g. DEEPGRAM_API_KEY unset) --
            // drop the turn cleanly exactly like the old "audio out of
            // scope" behavior, instead of throwing.
            if (!downloadVoiceNoteMedia) {
              return null;
            }
            const audioMediaId = raw.media.mediaId;
            // The download-to-sandbox step (already time-bounded, see
            // `meta-client.ts`'s `downloadMedia`) -- the unbounded custom
            // transcription call that caused the original production
            // incident stays removed from this pre-dispatch phase.
            const media = await downloadInboundMediaOrNotifyFailure({
              download: () => downloadVoiceNoteMedia({ mediaId: audioMediaId }),
              sender: raw.sender,
              sendText,
              kind: "voice note",
            });
            if (!media) {
              return null;
            }

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

          if (raw.kind === "image" && raw.media) {
            // No download wiring configured -- drop the turn cleanly rather
            // than throwing, mirroring the voice-note behavior above.
            if (!downloadImageMedia) {
              return null;
            }
            const imageMediaId = raw.media.mediaId;
            const media = await downloadInboundMediaOrNotifyFailure({
              download: () => downloadImageMedia({ mediaId: imageMediaId }),
              sender: raw.sender,
              sendText,
              kind: "image",
            });
            if (!media) {
              return null;
            }
            const caption = raw.text ?? "";

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
```

(The `// Any other/unrecognized event shape...` comment and `return null;` immediately after stay exactly as they are -- not part of this replacement.)

- [ ] **Step 4: Update `inbound.test.ts` -- compiler-driven, not manual line-hunting**

`inbound.test.ts` is ~1580 lines with dozens of `MetaWebhookEvent` object literals scattered across many `describe`/`it` blocks (voice notes, image handling, forwarding/reply provenance, access control, delivery). Do NOT try to manually locate every one by reading the whole file first -- `kind` is now a required field, so TypeScript will name every single literal that still uses the old shape as a compile error. Use the compiler as the worklist:

```bash
npx tsc --noEmit 2>&1 | grep "src/inbound.test.ts"
```

This prints one error per line needing a fix, each with a file:line:column. For each reported location, apply this exact mapping (these are the ONLY four transformations needed anywhere in this file):

| Old field | New field |
|---|---|
| `type: "text"` / `type: "audio"` / `type: "image"` | `kind: "text"` / `kind: "audio"` / `kind: "image"` |
| `audioMediaId: "<id>"` | `media: { mediaId: "<id>" }` |
| `imageMediaId: "<id>"` | `media: { mediaId: "<id>" }` (if a `caption` is also present on the same literal, merge it: see next row) |
| `caption: "<text>"` (alongside `imageMediaId`) | remove `caption`, add sibling `text: "<text>"` on the same object |
| `forwarded: true` and/or `frequentlyForwarded: true` and/or `quotedMessageId: "<id>"` and/or `quotedFrom: "<id>"` (as flat siblings of `sender`/`messageId`/etc.) | nest them together into `provenance: { forwarded: true, frequentlyForwarded: true, quotedMessageId: "<id>", quotedFrom: "<id>" }` -- keep only whichever of the four sub-fields were actually present |

Worked example, from the `"passes supplemental.quote ..."` test added when the provenance feature originally shipped:

```ts
// Before:
const event: MetaWebhookEvent = {
  sender: ALLOWED_SENDER,
  type: "text",
  text: "yes, that one",
  messageId: "wamid.reply",
  quotedMessageId: "wamid.original",
  quotedFrom: ALLOWED_SENDER,
};

// After:
const event: MetaWebhookEvent = {
  sender: ALLOWED_SENDER,
  kind: "text",
  text: "yes, that one",
  messageId: "wamid.reply",
  provenance: { quotedMessageId: "wamid.original", quotedFrom: ALLOWED_SENDER },
};
```

And the corresponding assertion in that same test (`buildContextCall.supplemental`) does NOT change -- `buildSupplementalContext`'s OUTPUT shape (`{ quote: { id, sender, senderAllowed, isQuote } }`) is unchanged by this refactor; only its INPUT (`event.provenance.quotedMessageId` instead of flat `event.quotedMessageId`) moved. Do not touch `buildContextCall.supplemental`/`.forwarded`/`.quote`/`.untrustedContext` assertions anywhere in this file -- if `tsc` or a test failure points you at one, the bug is in Task 2 Step 2's implementation, not the test.

Repeat `npx tsc --noEmit 2>&1 | grep "src/inbound.test.ts"` after each fix until it prints nothing.

- [ ] **Step 5: Verify and commit**

```bash
npx tsc --noEmit
```
Expected: clean (0 errors) -- this is the first point in the plan where the REPO-WIDE check must be clean, since both `webhook.ts`/`webhook.test.ts` (Task 1) and `inbound.ts`/`inbound.test.ts` (this task) are now updated.

```bash
npx vitest run
```
Expected: `Test Files 16 passed (16)`, `Tests 167 passed (167)` -- the exact same counts as before this refactor (see the design spec's "No runtime/behavioral change" note). If the count differs, a test was accidentally dropped or duplicated while editing -- find and fix it before proceeding, don't commit a changed test count without knowing why.

```bash
git add src/inbound.ts src/inbound.test.ts
git commit -m "refactor(inbound): consume the normalized MetaWebhookEvent shape"
```

---

### Task 3: `ARCHITECTURE.md` -- update the two spots that show the old flat shape

**Files:**
- Modify: `ARCHITECTURE.md` (§2.2's "Forwarding/reply provenance → `supplemental`" prose, added in commit `8c9d004`)

- [ ] **Step 1: Update the field-name bullets**

Find the bullet list in §2.2 (search for `supplemental.forwarded = { senderAllowed: true }`). Replace the three bullets:

```markdown
- `event.forwarded` → `supplemental.forwarded = { senderAllowed: true }`.
- `event.quotedMessageId` → `supplemental.quote = { id, sender?, senderAllowed: true, isQuote: true }` —
  id/sender only, since Meta never gives the quoted message's actual body.
- `event.frequentlyForwarded` → an `untrustedContext` entry (`label:
  "WhatsApp forwarding signal"`), since `SupplementalContextFacts.forwarded`
  has no dedicated frequency field — that shape describes *who* forwarded
  it, not *how often*.
```

with:

```markdown
- `event.provenance?.forwarded` → `supplemental.forwarded = { senderAllowed: true }`.
- `event.provenance?.quotedMessageId` → `supplemental.quote = { id, sender?, senderAllowed: true, isQuote: true }` —
  id/sender only, since Meta never gives the quoted message's actual body.
- `event.provenance?.frequentlyForwarded` → an `untrustedContext` entry (`label:
  "WhatsApp forwarding signal"`), since `SupplementalContextFacts.forwarded`
  has no dedicated frequency field — that shape describes *who* forwarded
  it, not *how often*.
```

Also update the sentence just above the bullets that reads `mapping the forwarded/frequentlyForwarded/quotedMessageId/quotedFrom fields parsed in §2.1` to `mapping the provenance fields (forwarded/frequentlyForwarded/quotedMessageId/quotedFrom, now nested under event.provenance) parsed in §2.1`.

- [ ] **Step 2: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs(architecture): reflect the nested provenance field in the envelope refactor"
```

---

### Task 4: Final full verification and push

- [ ] **Step 1: Full clean run from a fresh state**

```bash
npx tsc --noEmit && npx vitest run
```
Expected: both clean, `167 passed (167)`.

- [ ] **Step 2: Check PR #5's state again before pushing**

```bash
gh pr view 5 --repo shqear93/openclaw-whatsapp-cloud --json state -q .state
```
If still `OPEN`: push is safe, this refactor lands in `main` before the release PR merges, so v1.3.0 (once merged) ships the nested shape directly.
If now `MERGED`: stop and flag this to the user before pushing -- don't silently push past the sequencing assumption the spec called out as an open risk.

- [ ] **Step 3: Push**

```bash
git push origin main
```

Do not merge PR #5 or bump `claw-infra`'s pinned `openclaw-whatsapp-cloud` version as part of this plan -- those are separate, explicit-confirmation steps per this repo's established workflow (every prior release in this session's history was pushed/merged/deployed only after an explicit go-ahead, never automatically).
