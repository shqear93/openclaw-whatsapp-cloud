import { beforeEach, describe, expect, it } from "vitest";
import { markReplySent, resetReplySentFlag, wasReplySentThisTurn } from "./reply-delivery-tracker.js";

describe("reply-delivery-tracker", () => {
  const SENDER = "15551234567";

  beforeEach(() => {
    resetReplySentFlag(SENDER);
  });

  it("reports false for a sender that has never been marked", () => {
    expect(wasReplySentThisTurn("never-seen-sender")).toBe(false);
  });

  it("reports false immediately after reset", () => {
    markReplySent(SENDER);
    resetReplySentFlag(SENDER);
    expect(wasReplySentThisTurn(SENDER)).toBe(false);
  });

  it("reports true after markReplySent", () => {
    markReplySent(SENDER);
    expect(wasReplySentThisTurn(SENDER)).toBe(true);
  });

  it("tracks each sender independently", () => {
    const otherSender = "15559876543";
    resetReplySentFlag(otherSender);

    markReplySent(SENDER);

    expect(wasReplySentThisTurn(SENDER)).toBe(true);
    expect(wasReplySentThisTurn(otherSender)).toBe(false);
  });
});
