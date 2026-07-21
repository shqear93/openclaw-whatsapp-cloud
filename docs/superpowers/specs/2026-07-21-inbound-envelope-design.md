# WhatsApp Cloud Inbound Message Envelope — Design

## Background

`MetaWebhookEvent` (`webhook.ts`) is the plugin's one internal representation of an inbound WhatsApp message, produced by `parseMetaWebhookPayload` and consumed by `inbound.ts`'s `dispatchWhatsappInboundEvent`. It's currently a `type`-discriminated shape with content fields spread flat across all three message kinds:

```ts
export type MetaWebhookEvent = {
  sender: string;
  type: "text" | "audio" | "image";
  text?: string;
  audioMediaId?: string;
  imageMediaId?: string;
  caption?: string;
  messageId?: string;
  forwarded?: boolean;
  frequentlyForwarded?: boolean;
  quotedMessageId?: string;
  quotedFrom?: string;
};
```

The forwarding/reply provenance fields (`forwarded`/`frequentlyForwarded`/`quotedMessageId`/`quotedFrom`, added in `8c9d004`, released pending PR #5 → v1.3.0) surfaced a structural problem: they sit flat, at the same level as content fields (`text`/`audioMediaId`/`imageMediaId`/`caption`), with nothing distinguishing "what the message contains" from "where it came from." Every consumer (`inbound.ts`'s three `ingest` branches, `buildSupplementalContext`) has to know which flat fields belong to which concern by convention, not by structure. Adding a fourth message kind (video/document/sticker — currently silently dropped by `parseMetaWebhookPayload`, out of scope here, see below) would mean a fifth and sixth batch of type-specific optional fields bolted onto the same flat object.

This spec normalizes the envelope so the shape itself encodes "content" vs. "provenance" as distinct, grouped concerns, regardless of message kind — not a bigger feature, a restructuring of the existing one.

## Goal

One consistent `MetaWebhookEvent` shape:

```ts
export type MetaWebhookEvent = {
  sender: string;
  messageId?: string;
  kind: "text" | "audio" | "image";
  /** Body text for a text message, or caption for an image message. Audio never has one. */
  text?: string;
  /** Present for audio/image only. Which one is determined by `kind`, not a field on `media` itself. */
  media?: { mediaId: string };
  provenance?: {
    forwarded?: boolean;
    frequentlyForwarded?: boolean;
    quotedMessageId?: string;
    quotedFrom?: string;
  };
};
```

Changes from today's shape:
- `type` → `kind` (rename only; still exactly `"text" | "audio" | "image"` — see "Explicitly out of scope").
- `audioMediaId`/`imageMediaId` → unified `media?: { mediaId: string }`. No redundant per-kind field on `media` itself: `event.kind` already disambiguates audio vs. image, so `media.mediaId`'s meaning is never ambiguous.
- `caption` folds into `text`. This isn't just renaming for symmetry — `inbound.ts`'s `ingest` already treats a text body and an image caption identically downstream (`raw.text ?? ""` becomes `rawText`/`textForAgent`/`textForCommands` either way). The two fields encoded the same concept under different names; unifying them removes that duplication at the source.
- The four provenance fields nest under a single `provenance` object, mirroring Meta's own `context` object naming/structure, instead of sitting flat alongside content fields.

## Non-goals (explicitly out of scope)

- **Emitting an `"unsupported"` kind for video/document/sticker/location/contacts/interactive/reaction.** `parseMetaWebhookPayload` continues to silently skip these exactly as it does today — no behavior change here. This was raised and explicitly deferred in the same conversation that produced this spec — a real, separate decision (send an acknowledgment reply instead of silence, matching the download-failure fix's pattern) that this refactor does not make on its own. The normalized shape does make that a smaller follow-up if/when it's decided (one more `kind` value, no new flat fields to invent), but adding it now would be scope creep past what was asked.
- **Adding new media-type support** (video/document/etc.) — a separate feature decision, not a byproduct of restructuring the existing three.
- **Renaming the exported type name.** `MetaWebhookEvent` stays `MetaWebhookEvent` — it still means the same thing (an event parsed from Meta's webhook). Renaming it would force updating every import for no behavioral or structural benefit, pure churn.

## Migration plan

Impact is confined to two source files and their test files (confirmed via `grep -rn` across `src/*.ts` for every field being renamed/moved — `channel.ts`/`meta-client.ts`'s own `caption` usages are unrelated outbound-send parameters, not this type):

1. **`webhook.ts`**
   - Update the `MetaWebhookEvent` type to the new shape.
   - `parseMetaWebhookPayload`: build a single `provenance` object from `msg.context` (as today, just nested under one key instead of spread flat); push `kind`/`media`/`text` per branch per the new shape.
2. **`inbound.ts`**
   - `event.type`/`raw.type` → `event.kind`/`raw.kind` throughout (rawText computation, the `markAsRead` type guard, all three `ingest` branches).
   - `raw.audioMediaId`/`raw.imageMediaId` → `raw.media?.mediaId`.
   - `raw.caption` → `raw.text`.
   - `buildSupplementalContext`: read `event.provenance?.forwarded` etc. instead of flat `event.forwarded` etc. — the function's own logic (mapping onto the SDK's `SupplementalContextFacts`, the `senderAllowed: true` justification, the `frequentlyForwarded` → `untrustedContext` handling) is unchanged, only the input field paths move.
3. **`webhook.test.ts`** and **`inbound.test.ts`**: update every `MetaWebhookEvent` literal and assertion to the new field names/shape. No test *behavior* changes — same scenarios (forwarded, frequently-forwarded, reply/quote, plain message, audio-branch provenance), same assertions, new field paths.
4. Full `npx tsc --noEmit` + `npx vitest run` clean before commit, matching this repo's existing convention for every change so far.
5. Update `ARCHITECTURE.md` §2.1/§2.2 (added in `8c9d004`) to reflect the nested `provenance` shape instead of flat fields.

No runtime/behavioral change for any currently-supported message flow — this is a pure internal restructuring, verified by the existing test suite continuing to assert the same external behavior (same `buildContext` calls, same `supplemental` output, same `ingest` results) through the new field paths.

## Open risks to verify during implementation

- PR #5 (`chore(main): release 1.3.0`) is open but not yet merged as of this spec. If it merges before this refactor lands, the flat provenance shape from `8c9d004` will have shipped in a published npm release (`1.3.0`) — meaning this becomes a breaking-shape change for that field (still pre-1.0-adjacent risk tolerance given this repo's actual usage: single consumer, `claw-infra`'s pinned bootstrap version), not a concern requiring a deprecation path, but worth sequencing: land this refactor before merging PR #5 if avoidable, so `1.3.0` ships with the nested shape directly instead of shipping flat-then-nested across two releases.
