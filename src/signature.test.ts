import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyMetaSignature } from "./signature.js";

describe("verifyMetaSignature", () => {
  it("accepts a valid signature", () => {
    const secret = "test-app-secret";
    const body = Buffer.from('{"hello":"world"}');
    const digest = createHmac("sha256", secret).update(body).digest("hex");
    const header = `sha256=${digest}`;

    expect(verifyMetaSignature(body, header, secret)).toBe(true);
  });

  it("rejects a wrong signature", () => {
    const secret = "test-app-secret";
    const body = Buffer.from('{"hello":"world"}');
    const header = `sha256=${"0".repeat(64)}`;

    expect(verifyMetaSignature(body, header, secret)).toBe(false);
  });

  it("rejects a missing header", () => {
    const secret = "test-app-secret";
    const body = Buffer.from('{"hello":"world"}');

    expect(verifyMetaSignature(body, undefined, secret)).toBe(false);
  });

  it("rejects a header without the sha256= prefix", () => {
    const secret = "test-app-secret";
    const body = Buffer.from('{"hello":"world"}');

    expect(verifyMetaSignature(body, "not-a-real-header", secret)).toBe(false);
  });
});
