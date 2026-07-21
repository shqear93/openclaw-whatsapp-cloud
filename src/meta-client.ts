// Meta bumps its Graph API version periodically and eventually sunsets old
// ones -- defaulting to the last-confirmed-working version while letting a
// deployer override it (`WHATSAPP_GRAPH_API_VERSION`, see channel.ts) means
// picking up a new version doesn't require a code change/release here.
const DEFAULT_GRAPH_API_VERSION = "v21.0";

// Meta caps WhatsApp voice notes at 16MB; 20MB matches the generous headroom
// used for image downloads (see message-adapter.ts's MAX_REMOTE_MEDIA_BYTES),
// applying the same content-length-then-actual-length defense-in-depth here
// since content-length can be absent or wrong. Overridable
// (`WHATSAPP_MAX_MEDIA_DOWNLOAD_BYTES`, see channel.ts) since Meta's own caps
// vary by media type/account tier and a deployer may need to raise this --
// confirmed live: a real 41MB voice note was silently unprocessable under a
// fixed 20MB cap with no way to admit it without a code change.
const DEFAULT_MAX_MEDIA_DOWNLOAD_BYTES = 20 * 1024 * 1024;

type FetchImpl = typeof fetch;

export type MetaClientOptions = {
  accessToken: string;
  phoneNumberId: string;
  fetchImpl?: FetchImpl;
  graphApiVersion?: string;
  maxMediaDownloadBytes?: number;
};

export type SendTextParams = {
  to: string;
  text: string;
};

export type SendAudioParams = {
  to: string;
  mediaId: string;
};

export type SendImageParams = {
  to: string;
  imageBytes: Uint8Array;
  mimeType: string;
  caption?: string;
};

export type SendAudioBytesParams = {
  to: string;
  audioBytes: Uint8Array;
  mimeType: string;
};

export type SendReactionParams = {
  to: string;
  messageId: string;
  emoji: string;
};

export type SendResult = {
  messageId: string;
};

export type DownloadedMedia = {
  bytes: Uint8Array;
  mimeType: string;
};

export type MarkAsReadParams = {
  messageId: string;
  /**
   * When true, also show the "typing…" indicator to the sender. Meta clears
   * it automatically after ~25s or as soon as a reply message is sent to the
   * same recipient -- whichever comes first -- so callers don't need a
   * separate "stop typing" call.
   */
  typing?: boolean;
};

const DEFAULT_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

// Cartesia's `/tts/bytes` endpoint always returns `audio/mpeg` bytes when
// requested with `output_format.container: "mp3"` (see `cartesia.ts`'s
// `synthesize`), so this only needs the one entry -- unlike images, TTS
// output is never anything but mp3 here.
const DEFAULT_AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/mpeg": "mp3",
};

function extensionForMimeType(mimeType: string, knownExtensions: Record<string, string> = DEFAULT_IMAGE_EXTENSIONS): string {
  const known = knownExtensions[mimeType];
  if (known) return known;
  const subtype = mimeType.split("/")[1];
  return subtype && /^[a-z0-9]+$/i.test(subtype) ? subtype : "bin";
}

export function createMetaClient(options: MetaClientOptions) {
  const { accessToken, phoneNumberId } = options;
  const fetchImpl: FetchImpl = options.fetchImpl ?? fetch;
  const graphApiVersion = options.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;
  const maxMediaDownloadBytes = options.maxMediaDownloadBytes ?? DEFAULT_MAX_MEDIA_DOWNLOAD_BYTES;
  const messagesUrl = `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`;
  const mediaUrl = `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/media`;

  async function post(payload: Record<string, unknown>, description: string): Promise<SendResult> {
    const to = payload.to;
    let response: Response;
    try {
      response = await fetchImpl(messagesUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const original = error instanceof Error ? error : new Error(String(error));
      throw new Error(
        `WhatsApp API request failed (${description} to ${to}): ${original.message}`,
        { cause: original },
      );
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `WhatsApp API rejected ${description} to ${payload.to}: status=${response.status} body=${bodyText}`,
      );
    }

    const data = (await response.json()) as { messages?: Array<{ id?: string }> };
    const messageId = data.messages?.[0]?.id;
    if (!messageId) {
      throw new Error(`WhatsApp API response for ${description} did not include a message id`);
    }
    return { messageId };
  }

  async function uploadMedia(
    bytes: Uint8Array,
    mimeType: string,
    filename: string,
    to: string,
  ): Promise<string> {
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", mimeType);
    const bytesCopy = new Uint8Array(bytes);
    form.set("file", new File([bytesCopy], filename, { type: mimeType }));

    let response: Response;
    try {
      response = await fetchImpl(mediaUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const original = error instanceof Error ? error : new Error(String(error));
      throw new Error(
        `WhatsApp API request failed (media upload to ${to}): ${original.message}`,
        { cause: original },
      );
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `WhatsApp API rejected media upload: status=${response.status} body=${bodyText}`,
      );
    }

    const data = (await response.json()) as { id?: string };
    if (!data.id) {
      throw new Error("WhatsApp API media upload response did not include an id");
    }
    return data.id;
  }

  /**
   * Downloads inbound media (e.g. a voice note) given its Meta media id.
   * Two-step Graph API flow, ported from the proven
   * `whatsapp-bridge/media_client.py`'s `download_media`: (1) `GET
   * /{media-id}` to resolve a short-lived signed download `url` + the
   * media's `mime_type`, then (2) `GET` that URL, again with the bearer
   * token attached (Meta's temp media URLs still require the app's access
   * token, unlike a truly public pre-signed URL).
   */
  async function downloadMedia(mediaId: string): Promise<DownloadedMedia> {
    let metaResponse: Response;
    try {
      metaResponse = await fetchImpl(`https://graph.facebook.com/${graphApiVersion}/${mediaId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const original = error instanceof Error ? error : new Error(String(error));
      throw new Error(
        `WhatsApp API request failed (resolving media url for ${mediaId}): ${original.message}`,
        { cause: original },
      );
    }

    if (!metaResponse.ok) {
      const bodyText = await metaResponse.text().catch(() => "");
      throw new Error(
        `WhatsApp API rejected media lookup for ${mediaId}: status=${metaResponse.status} body=${bodyText}`,
      );
    }

    const meta = (await metaResponse.json()) as { url?: string; mime_type?: string };
    if (!meta.url) {
      throw new Error(`WhatsApp API media lookup for ${mediaId} did not include a download url`);
    }

    let dataResponse: Response;
    try {
      dataResponse = await fetchImpl(meta.url, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const original = error instanceof Error ? error : new Error(String(error));
      throw new Error(
        `WhatsApp API request failed (downloading media ${mediaId}): ${original.message}`,
        { cause: original },
      );
    }

    if (!dataResponse.ok) {
      const bodyText = await dataResponse.text().catch(() => "");
      throw new Error(
        `WhatsApp API rejected media download for ${mediaId}: status=${dataResponse.status} body=${bodyText}`,
      );
    }

    const contentLength = Number(dataResponse.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxMediaDownloadBytes) {
      throw new Error(
        `Media download for ${mediaId} exceeds maximum allowed size: ${contentLength} > ${maxMediaDownloadBytes} bytes`,
      );
    }

    const arrayBuffer = await dataResponse.arrayBuffer();
    if (arrayBuffer.byteLength > maxMediaDownloadBytes) {
      throw new Error(
        `Media download for ${mediaId} exceeds maximum allowed size: ${arrayBuffer.byteLength} > ${maxMediaDownloadBytes} bytes`,
      );
    }

    return {
      bytes: new Uint8Array(arrayBuffer),
      mimeType: meta.mime_type ?? "application/octet-stream",
    };
  }

  async function markAsRead({ messageId, typing = false }: MarkAsReadParams): Promise<void> {
    const payload: Record<string, unknown> = {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    };
    if (typing) {
      payload.typing_indicator = { type: "text" };
    }

    let response: Response;
    try {
      response = await fetchImpl(messagesUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const original = error instanceof Error ? error : new Error(String(error));
      throw new Error(
        `WhatsApp API request failed (mark as read for message ${messageId}): ${original.message}`,
        { cause: original },
      );
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `WhatsApp API rejected mark-as-read for message ${messageId}: status=${response.status} body=${bodyText}`,
      );
    }
  }

  return {
    markAsRead,
    downloadMedia,

    async sendText({ to, text }: SendTextParams): Promise<SendResult> {
      return post(
        {
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: text },
        },
        "text message",
      );
    },

    async sendAudio({ to, mediaId }: SendAudioParams): Promise<SendResult> {
      return post(
        {
          messaging_product: "whatsapp",
          to,
          type: "audio",
          audio: { id: mediaId },
        },
        "voice note",
      );
    },

    async sendImage({ to, imageBytes, mimeType, caption }: SendImageParams): Promise<SendResult> {
      const filename = `reply.${extensionForMimeType(mimeType)}`;
      const mediaId = await uploadMedia(imageBytes, mimeType, filename, to);

      const image: Record<string, unknown> = { id: mediaId };
      if (caption !== undefined) {
        image.caption = caption;
      }

      return post(
        {
          messaging_product: "whatsapp",
          to,
          type: "image",
          image,
        },
        "image message",
      );
    },

    /**
     * Uploads synthesized TTS audio bytes then sends them as a voice note --
     * the same upload-then-reference two-step flow as `sendImage`, mirroring
     * the old bridge's `media_client.upload_media()` +
     * `whatsapp_client.send_audio()` pair (`whatsapp-bridge/media_client.py`,
     * `whatsapp-bridge/whatsapp_client.py`).
     */
    async sendAudioBytes({ to, audioBytes, mimeType }: SendAudioBytesParams): Promise<SendResult> {
      const filename = `reply.${extensionForMimeType(mimeType, DEFAULT_AUDIO_EXTENSIONS)}`;
      const mediaId = await uploadMedia(audioBytes, mimeType, filename, to);
      return post(
        {
          messaging_product: "whatsapp",
          to,
          type: "audio",
          audio: { id: mediaId },
        },
        "voice note",
      );
    },

    /**
     * Reacts to an existing message with an emoji (Meta's `type: "reaction"`
     * message kind -- same `/messages` endpoint and `{messages:[{id}]}`
     * response shape as every other send, so this reuses `post()` directly).
     * Used for a fast, visible error signal (see `inbound.ts`'s catch block)
     * alongside the text error reply, not as a replacement for it.
     */
    async sendReaction({ to, messageId, emoji }: SendReactionParams): Promise<SendResult> {
      return post(
        {
          messaging_product: "whatsapp",
          to,
          type: "reaction",
          reaction: { message_id: messageId, emoji },
        },
        "reaction",
      );
    },
  };
}

export type MetaClient = ReturnType<typeof createMetaClient>;
