import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { verifyMetaSignature } from "./signature.js";

export type MetaWebhookEvent = {
  sender: string;
  type: "text" | "audio" | "image";
  text?: string;
  audioMediaId?: string;
  imageMediaId?: string;
  caption?: string;
  messageId?: string;
  /**
   * Meta's per-message `context` object carries forwarding/reply metadata
   * uniformly across all message types (text/audio/image), parsed once in
   * `parseMetaWebhookPayload` rather than duplicated per branch there. Meta
   * does NOT expose the *content* of a forwarded/quoted message via the
   * webhook -- only that forwarding happened, or a reference (id/sender) to
   * the quoted message -- there is no Cloud API endpoint to fetch an
   * arbitrary historical message's content by id.
   */
  forwarded?: boolean;
  frequentlyForwarded?: boolean;
  quotedMessageId?: string;
  quotedFrom?: string;
};

const MAX_BODY_BYTES = 1024 * 1024; // 1MB, generous for WhatsApp webhook JSON payloads

class PayloadTooLargeError extends Error {}

function constantTimeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    const onData = (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        cleanup();
        reject(new PayloadTooLargeError("request body exceeds maximum allowed size"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

export function createMetaWebhookHandler(params: {
  verifyToken: string;
  appSecret: string;
  onEvent: (event: MetaWebhookEvent) => void;
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method === "GET") {
      let url: URL;
      try {
        url = new URL(req.url ?? "", "http://localhost");
      } catch {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("bad request");
        return;
      }
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge") ?? "";

      if (mode === "subscribe" && token !== null && constantTimeStringEqual(token, params.verifyToken)) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(challenge);
        return;
      }

      res.writeHead(403, { "content-type": "text/plain" });
      res.end("verification failed");
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    let body: Buffer;
    try {
      body = await readRequestBody(req);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        res.writeHead(413, { "content-type": "text/plain" });
        res.end("payload too large");
        return;
      }
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error");
      return;
    }

    const signature = req.headers["x-hub-signature-256"];
    const signatureHeader = Array.isArray(signature) ? signature[0] : signature;
    if (!verifyMetaSignature(body, signatureHeader, params.appSecret)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("invalid signature");
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("invalid json");
      return;
    }

    for (const event of parseMetaWebhookPayload(payload)) {
      params.onEvent(event);
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"status":"ok"}');
  };
}

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
        const provenance = msg.context
          ? {
              ...(msg.context.forwarded ? { forwarded: true } : {}),
              ...(msg.context.frequently_forwarded ? { frequentlyForwarded: true } : {}),
              ...(msg.context.id ? { quotedMessageId: msg.context.id } : {}),
              ...(msg.context.from ? { quotedFrom: msg.context.from } : {}),
            }
          : {};
        if (msg.type === "text" && msg.text?.body) {
          events.push({ sender: msg.from, type: "text", text: msg.text.body, messageId: msg.id, ...provenance });
        } else if (msg.type === "audio" && msg.audio?.id) {
          events.push({
            sender: msg.from,
            type: "audio",
            audioMediaId: msg.audio.id,
            messageId: msg.id,
            ...provenance,
          });
        } else if (msg.type === "image" && msg.image?.id) {
          events.push({
            sender: msg.from,
            type: "image",
            imageMediaId: msg.image.id,
            ...(msg.image.caption ? { caption: msg.image.caption } : {}),
            messageId: msg.id,
            ...provenance,
          });
        }
      }
    }
  }
  return events;
}
