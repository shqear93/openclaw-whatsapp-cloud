import {
  defineChannelMessageAdapter,
  createMessageReceiptFromOutboundResults,
} from "openclaw/plugin-sdk/channel-outbound";
import type { MetaClient, SendResult } from "./meta-client.js";

const EXTENSION_MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

const DEFAULT_IMAGE_MIME_TYPE = "image/jpeg";
const REMOTE_MEDIA_FETCH_TIMEOUT_MS = 30_000;
const MAX_REMOTE_MEDIA_BYTES = 20 * 1024 * 1024; // 20MB, generous for WhatsApp's own media limits

function mimeTypeFromExtension(filePath: string): string {
  const match = /\.([a-zA-Z0-9]+)$/.exec(filePath);
  const extension = match?.[1]?.toLowerCase();
  return (extension && EXTENSION_MIME_TYPES[extension]) || DEFAULT_IMAGE_MIME_TYPE;
}

function resolveFetchSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(REMOTE_MEDIA_FETCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export async function resolveImageBytesAndMimeType(ctx: {
  mediaUrl: string;
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  signal?: AbortSignal;
}): Promise<{ imageBytes: Uint8Array; mimeType: string }> {
  if (ctx.mediaReadFile) {
    const buffer = await ctx.mediaReadFile(ctx.mediaUrl);
    return { imageBytes: new Uint8Array(buffer), mimeType: mimeTypeFromExtension(ctx.mediaUrl) };
  }

  const response = await fetch(ctx.mediaUrl, { signal: resolveFetchSignal(ctx.signal) });
  if (!response.ok) {
    throw new Error(`Failed to fetch media from ${ctx.mediaUrl}: ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REMOTE_MEDIA_BYTES) {
    throw new Error(
      `Media at ${ctx.mediaUrl} exceeds maximum allowed size: ${contentLength} > ${MAX_REMOTE_MEDIA_BYTES} bytes`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_REMOTE_MEDIA_BYTES) {
    throw new Error(
      `Media at ${ctx.mediaUrl} exceeds maximum allowed size: ${arrayBuffer.byteLength} > ${MAX_REMOTE_MEDIA_BYTES} bytes`,
    );
  }
  const mimeType = response.headers.get("content-type") || DEFAULT_IMAGE_MIME_TYPE;
  return { imageBytes: new Uint8Array(arrayBuffer), mimeType };
}

function buildReceipt(params: {
  kind: "text" | "media";
  to: string;
  result: SendResult;
  threadId?: string | number | null;
  replyToId?: string | null;
}) {
  return createMessageReceiptFromOutboundResults({
    results: [{ channel: "whatsapp-cloud", messageId: params.result.messageId, conversationId: params.to }],
    kind: params.kind,
    threadId: params.threadId == null ? undefined : String(params.threadId),
    replyToId: params.replyToId ?? undefined,
  });
}

export function createWhatsappMessageAdapter(metaClient: MetaClient) {
  return defineChannelMessageAdapter({
    id: "whatsapp-cloud",
    durableFinal: {
      capabilities: {
        text: true,
        media: true,
        messageSendingHooks: true,
      },
    },
    send: {
      text: async (ctx) => {
        const result = await metaClient.sendText({ to: ctx.to, text: ctx.text });
        return {
          receipt: buildReceipt({
            kind: "text",
            to: ctx.to,
            result,
            threadId: ctx.threadId,
            replyToId: ctx.replyToId,
          }),
          messageId: result.messageId,
        };
      },
      media: async (ctx) => {
        const { imageBytes, mimeType } = await resolveImageBytesAndMimeType(ctx);
        const result = await metaClient.sendImage({
          to: ctx.to,
          imageBytes,
          mimeType,
          caption: ctx.text || undefined,
        });
        return {
          receipt: buildReceipt({
            kind: "media",
            to: ctx.to,
            result,
            threadId: ctx.threadId,
            replyToId: ctx.replyToId,
          }),
          messageId: result.messageId,
        };
      },
    },
  });
}
