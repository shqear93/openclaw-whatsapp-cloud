import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyMetaSignature(
  body: Buffer,
  headerValue: string | undefined,
  appSecret: string,
): boolean {
  if (!headerValue || !headerValue.startsWith("sha256=")) {
    return false;
  }

  const expected = createHmac("sha256", appSecret).update(body).digest("hex");
  const provided = headerValue.slice("sha256=".length);

  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, providedBuf);
}
