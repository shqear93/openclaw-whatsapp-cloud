/**
 * Strips common markdown syntax from agent reply text before it's handed to
 * Cartesia TTS for a WhatsApp voice reply (see `channel.ts`'s
 * `sendWhatsappCloudVoiceReply`).
 *
 * The agent's raw reply text is written for a chat surface that renders
 * markdown (or, on WhatsApp specifically, WhatsApp-native markdown -- see
 * `openclaw/workspace-whatsapp/AGENTS.md`'s "Formatting" bullet), not for a
 * TTS engine reading it character-by-character. Left unstripped, a TTS
 * engine reads literal syntax out loud: Cartesia pronounces stray asterisks,
 * reads "hash hash hash" for a markdown header, and reads a numbered list's
 * "1." as "one dot" before every item. This is a deterministic, code-level
 * defense alongside the prompt-level instruction added to
 * `workspace-whatsapp/AGENTS.md` telling the agent to reply in plain spoken
 * prose for voice-originated turns in the first place -- this function is
 * the backstop for whatever markdown slips through anyway (e.g. the model
 * ignoring the instruction, or reusing markdown habits from the general
 * WhatsApp-formatting guidance).
 *
 * This is intentionally NOT a full markdown parser/AST -- just a small set
 * of regex replacements for the syntax patterns actually observed in this
 * plugin's production voice-reply output: `**bold**`/`*italic*`/`_italic_`,
 * `### headers`, `- `/`* `/numbered (`1. `) list markers, `---` horizontal
 * rules, code fences/inline backticks, and `[text](url)` links.
 */
export function stripMarkdownForSpeech(text: string): string {
  let result = text;

  // Code fences (```lang\ncode\n```) -- drop the fence markers but keep the
  // enclosed text, since the content itself may still be relevant to speak.
  result = result.replace(/```[a-zA-Z0-9_-]*\n?/g, "");

  // Inline code / stray backticks: `code` -> code
  result = result.replace(/`([^`]+)`/g, "$1");

  // Links: [text](url) -> text
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Headers: leading '#'*1-6 followed by a space, at the start of a line.
  // `[ \t]` not `\s` -- see the bullet-marker comment below for why using
  // `\s` here would risk eating a following blank line's newline too.
  result = result.replace(/^#{1,6}[ \t]+/gm, "");

  // Horizontal rules / dividers: a line consisting only of 3+ of -, *, or _
  // (with optional surrounding horizontal whitespace), e.g. "---", "***",
  // "___". `[ \t]` not `\s` for the same reason as the other patterns here.
  result = result.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, "");

  // Bold/italic emphasis markers: **bold**, __bold__, *italic*, _italic_.
  // Order matters -- strip the doubled markers before the single ones so
  // "**bold**" doesn't leave stray single asterisks behind.
  result = result.replace(/\*\*([^*]+)\*\*/g, "$1");
  result = result.replace(/__([^_]+)__/g, "$1");
  result = result.replace(/\*([^*]+)\*/g, "$1");
  result = result.replace(/_([^_]+)_/g, "$1");

  // Bullet list markers: leading '-', '*', or '+' followed by a space, at
  // the start of a line (after the emphasis pass above so a line that was
  // "*bold item*" doesn't get its now-bare leading text mistaken for one).
  // Uses `[ \t]` rather than `\s` for the surrounding whitespace: `\s`
  // matches newlines too, so `^\s*` on a bullet line immediately after a
  // blank line (e.g. after the horizontal-rule pass above stripped a `---`
  // divider down to an empty line) would greedily consume that blank line's
  // newline as part of the match, silently collapsing it away.
  result = result.replace(/^[ \t]*[-*+][ \t]+/gm, "");

  // Numbered list markers: leading "1. ", "2) ", etc, at the start of a
  // line. Same `[ \t]`-not-`\s` reasoning as the bullet pattern above.
  result = result.replace(/^[ \t]*\d+[.)][ \t]+/gm, "");

  // Collapse the run of blank lines left behind by stripped header/divider
  // lines, and trim leading/trailing whitespace, so TTS doesn't get long
  // silences from empty lines.
  result = result.replace(/\n{3,}/g, "\n\n").trim();

  return result;
}
