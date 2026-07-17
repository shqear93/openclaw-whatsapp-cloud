import { describe, expect, it } from "vitest";
import { stripMarkdownForSpeech } from "./markdown-strip.js";

describe("stripMarkdownForSpeech", () => {
  it("strips bold and italic emphasis markers", () => {
    expect(stripMarkdownForSpeech("This is **bold** and this is *italic*.")).toBe(
      "This is bold and this is italic.",
    );
    expect(stripMarkdownForSpeech("__also bold__ and _also italic_.")).toBe(
      "also bold and also italic.",
    );
  });

  it("strips markdown headers", () => {
    expect(stripMarkdownForSpeech("### Header\nSome text")).toBe("Header\nSome text");
    expect(stripMarkdownForSpeech("# Title")).toBe("Title");
  });

  it("strips bullet and numbered list markers", () => {
    expect(stripMarkdownForSpeech("- first\n- second")).toBe("first\nsecond");
    expect(stripMarkdownForSpeech("1. first\n2. second")).toBe("first\nsecond");
  });

  it("strips --- dividers", () => {
    expect(stripMarkdownForSpeech("Section one\n---\nSection two")).toBe(
      "Section one\n\nSection two",
    );
  });

  it("strips code fences/backticks and link syntax", () => {
    expect(stripMarkdownForSpeech("Run `npm install` please")).toBe("Run npm install please");
    expect(stripMarkdownForSpeech("See [the docs](https://example.com) for more")).toBe(
      "See the docs for more",
    );
  });

  it("leaves plain text with no markdown unchanged", () => {
    const plain = "Hey, sure! I can help with that. Let me know what you need.";
    expect(stripMarkdownForSpeech(plain)).toBe(plain);
  });
});
