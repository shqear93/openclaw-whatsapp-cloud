import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createMetaWebhookHandler, parseMetaWebhookPayload } from "./webhook.js";

function fakeReq(
  overrides: Partial<{
    method: string;
    url: string;
    body: Buffer;
    headers: Record<string, string>;
    simulateError: Error;
    chunkSize: number;
  }>,
) {
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  return {
    method: overrides.method ?? "GET",
    url: overrides.url ?? "/whatsapp-cloud/webhook",
    headers: overrides.headers ?? {},
    on: (event: string, cb: (...args: any[]) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);

      if (event === "data" && overrides.body) {
        const chunkSize = overrides.chunkSize ?? overrides.body.length;
        for (let i = 0; i < overrides.body.length; i += chunkSize) {
          cb(overrides.body.subarray(i, i + chunkSize));
        }
      }
      if (event === "end" && !overrides.simulateError) {
        cb();
      }
      if (event === "error" && overrides.simulateError) {
        cb(overrides.simulateError);
      }
    },
    off: (event: string, cb: (...args: any[]) => void) => {
      listeners[event] = (listeners[event] ?? []).filter((l) => l !== cb);
    },
  } as any;
}

function fakeRes() {
  const res: any = { statusCode: 0, body: "" };
  res.writeHead = vi.fn((code: number) => { res.statusCode = code; });
  res.end = vi.fn((body?: string) => { res.body = body ?? ""; });
  return res;
}

describe("createMetaWebhookHandler", () => {
  it("responds with the challenge on a valid verification GET request", async () => {
    const onEvent = vi.fn();
    const handler = createMetaWebhookHandler({ verifyToken: "vt", appSecret: "secret", onEvent });
    const req = fakeReq({
      method: "GET",
      url: "/whatsapp-cloud/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=12345",
    });
    const res = fakeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("12345");
  });

  it("rejects a verification GET request with the wrong token", async () => {
    const onEvent = vi.fn();
    const handler = createMetaWebhookHandler({ verifyToken: "vt", appSecret: "secret", onEvent });
    const req = fakeReq({
      method: "GET",
      url: "/whatsapp-cloud/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345",
    });
    const res = fakeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(403);
  });

  it("rejects a POST with an invalid signature", async () => {
    const onEvent = vi.fn();
    const handler = createMetaWebhookHandler({ verifyToken: "vt", appSecret: "secret", onEvent });
    const body = Buffer.from(JSON.stringify({ entry: [] }));
    const req = fakeReq({
      method: "POST",
      body,
      headers: { "x-hub-signature-256": "sha256=" + "0".repeat(64) },
    });
    const res = fakeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("parses a validly-signed POST and responds 200 with the ok status", async () => {
    const onEvent = vi.fn();
    const secret = "test-app-secret";
    const handler = createMetaWebhookHandler({ verifyToken: "vt", appSecret: secret, onEvent });

    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "15551234567",
                    id: "wamid.abc123",
                    type: "text",
                    text: { body: "hello there" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const body = Buffer.from(JSON.stringify(payload));
    const digest = createHmac("sha256", secret).update(body).digest("hex");

    const req = fakeReq({
      method: "POST",
      body,
      headers: { "x-hub-signature-256": `sha256=${digest}` },
    });
    const res = fakeRes();

    await handler(req, res);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({
      sender: "15551234567",
      type: "text",
      text: "hello there",
      messageId: "wamid.abc123",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"status":"ok"}');
  });

  it("responds 500 if the request stream errors while buffering the body", async () => {
    const onEvent = vi.fn();
    const handler = createMetaWebhookHandler({ verifyToken: "vt", appSecret: "secret", onEvent });
    const req = fakeReq({
      method: "POST",
      simulateError: new Error("connection reset"),
    });
    const res = fakeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("responds 413 if the request body exceeds the maximum allowed size", async () => {
    const onEvent = vi.fn();
    const handler = createMetaWebhookHandler({ verifyToken: "vt", appSecret: "secret", onEvent });
    const oversizedBody = Buffer.alloc(1024 * 1024 + 1, "a");
    const req = fakeReq({
      method: "POST",
      body: oversizedBody,
      chunkSize: 256 * 1024,
    });
    const res = fakeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(413);
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe("parseMetaWebhookPayload", () => {
  it("extracts a text message event from a realistic Meta webhook payload", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "15551234567",
                    id: "wamid.abc123",
                    type: "text",
                    text: { body: "hello there" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const events = parseMetaWebhookPayload(payload);

    expect(events).toEqual([
      {
        sender: "15551234567",
        type: "text",
        text: "hello there",
        messageId: "wamid.abc123",
      },
    ]);
  });

  it("extracts an audio message event", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "15551234567",
                    id: "wamid.audio123",
                    type: "audio",
                    audio: { id: "media-abc" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const events = parseMetaWebhookPayload(payload);

    expect(events).toEqual([
      {
        sender: "15551234567",
        type: "audio",
        audioMediaId: "media-abc",
        messageId: "wamid.audio123",
      },
    ]);
  });

  it("silently drops a message with an unsupported type", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "15551234567",
                    id: "wamid.sticker123",
                    type: "sticker",
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    expect(parseMetaWebhookPayload(payload)).toEqual([]);
  });

  it("silently drops a message missing the from field", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: "wamid.nofield123",
                    type: "text",
                    text: { body: "hi" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    expect(parseMetaWebhookPayload(payload)).toEqual([]);
  });

  it("returns an empty array when entry is missing", () => {
    expect(parseMetaWebhookPayload({})).toEqual([]);
  });

  it("returns an empty array when entry is empty", () => {
    expect(parseMetaWebhookPayload({ entry: [] })).toEqual([]);
  });
});
