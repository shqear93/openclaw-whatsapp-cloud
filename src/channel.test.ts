import { describe, expect, it, vi } from "vitest";

const generateImageForWhatsappMock = vi.fn();
vi.mock("./image-tool.js", () => ({
  generateImageForWhatsapp: (...args: unknown[]) => generateImageForWhatsappMock(...args),
}));

const saveMediaBufferMock = vi.fn();
vi.mock("openclaw/plugin-sdk/media-store", () => ({
  saveMediaBuffer: (...args: unknown[]) => saveMediaBufferMock(...args),
}));

describe("channel", () => {
  it("assembles whatsappCloudPlugin without requiring env vars at import time", async () => {
    // Regression test for the lazy-client wiring: importing channel.ts (and
    // thus building whatsappCloudPlugin via createChatChannelPlugin) must not
    // throw even when none of the WhatsApp env vars are set, because the real
    // MetaClient is only constructed lazily on first send.
    const previous = {
      WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
    };
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;

    try {
      const { whatsappCloudPlugin } = await import("./channel.js");
      expect(whatsappCloudPlugin.id).toBe("whatsapp-cloud");
      expect(whatsappCloudPlugin.message).toBeDefined();
    } finally {
      if (previous.WHATSAPP_ACCESS_TOKEN === undefined) {
        delete process.env.WHATSAPP_ACCESS_TOKEN;
      } else {
        process.env.WHATSAPP_ACCESS_TOKEN = previous.WHATSAPP_ACCESS_TOKEN;
      }
      if (previous.WHATSAPP_PHONE_NUMBER_ID === undefined) {
        delete process.env.WHATSAPP_PHONE_NUMBER_ID;
      } else {
        process.env.WHATSAPP_PHONE_NUMBER_ID = previous.WHATSAPP_PHONE_NUMBER_ID;
      }
    }
  });

  it("isConfigured() returns false when only WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID are set", async () => {
    // Regression test: isConfigured() must agree with unconfiguredReason()/
    // registerFull(), which all require four env vars (WHATSAPP_ACCESS_TOKEN,
    // WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN).
    // Previously isConfigured() only checked the first two, so a
    // half-configured deployment would misleadingly report itself as
    // configured even though registerFull() would still throw.
    const previous = {
      WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
      WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,
      WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,
    };
    process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "test-phone-id";
    delete process.env.WHATSAPP_APP_SECRET;
    delete process.env.WHATSAPP_VERIFY_TOKEN;

    try {
      const { whatsappCloudPlugin } = await import("./channel.js");
      const account = whatsappCloudPlugin.config.resolveAccount({} as never, undefined);
      const result = await whatsappCloudPlugin.config.isConfigured?.(account, {} as never);
      expect(result).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("registerFull throws a clear error when a required env var is missing", async () => {
    const { registerFull } = await import("./channel.js");
    const previous = process.env.WHATSAPP_VERIFY_TOKEN;
    delete process.env.WHATSAPP_VERIFY_TOKEN;

    try {
      const fakeApi = {
        config: {},
        runtime: { channel: {} },
        logger: { info: vi.fn(), error: vi.fn() },
        registerTool: vi.fn(),
      };
      expect(() => registerFull(fakeApi)).toThrow(
        "Missing required environment variable: WHATSAPP_VERIFY_TOKEN",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.WHATSAPP_VERIFY_TOKEN;
      } else {
        process.env.WHATSAPP_VERIFY_TOKEN = previous;
      }
    }
  });

  it("registerFull registers the webhook route via api.registerHttpRoute, not the standalone SDK helper", async () => {
    // Regression test: `registerPluginHttpRoute` (the standalone helper from
    // `openclaw/plugin-sdk/webhook-ingress`) resolves its target registry
    // from an AsyncLocalStorage-scoped "active" plugin registry pointer that
    // is not yet wired to this plugin's own registry during `registerFull`
    // -- routes registered that way silently vanish from the gateway's real
    // HTTP dispatch table. `api.registerHttpRoute(...)` is the correct API
    // for routes registered synchronously inside `register(api)`.
    const previous = {
      WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
      WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,
      WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,
    };
    process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "test-phone-id";
    process.env.WHATSAPP_APP_SECRET = "test-app-secret";
    process.env.WHATSAPP_VERIFY_TOKEN = "test-verify-token";

    try {
      const { registerFull } = await import("./channel.js");
      const registerHttpRoute = vi.fn();
      const registerTool = vi.fn();
      const fakeApi = {
        config: {},
        runtime: { channel: {} },
        logger: { info: vi.fn(), error: vi.fn() },
        registerTool,
        registerHttpRoute,
      };

      registerFull(fakeApi);

      expect(registerHttpRoute).toHaveBeenCalledTimes(1);
      expect(registerHttpRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/whatsapp-cloud/webhook",
          auth: "plugin",
          handler: expect.any(Function),
        }),
      );
      expect(registerTool).toHaveBeenCalledTimes(3);
      expect(registerTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: "generate_image_for_whatsapp" }),
      );
      expect(registerTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: "send_text_reply_for_whatsapp" }),
      );
      expect(registerTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: "send_voice_reply_for_whatsapp" }),
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("generate_image_for_whatsapp saves the generated image via saveMediaBuffer and returns a path, never raw base64", async () => {
    // Regression test for the "hallucinated base64" production bug: the tool
    // used to return `imageBase64`/`contentType` directly in `details`,
    // requiring the agent to reproduce tens of thousands of base64
    // characters verbatim in a follow-up `message` tool call -- which
    // degraded into a hallucinated ~200-byte placeholder PNG under retry
    // pressure. It must now write the bytes to the sandboxed managed media
    // directory via `saveMediaBuffer` (subdir prefixed with `tool-` so it
    // passes `isManagedMediaPathUnderRoot`) and hand back only a short path.
    const previous = {
      WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
      WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,
      WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,
      LITELLM_BASE_URL: process.env.LITELLM_BASE_URL,
      LITELLM_API_KEY: process.env.LITELLM_API_KEY,
    };
    process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "test-phone-id";
    process.env.WHATSAPP_APP_SECRET = "test-app-secret";
    process.env.WHATSAPP_VERIFY_TOKEN = "test-verify-token";
    process.env.LITELLM_BASE_URL = "http://litellm:4000";
    process.env.LITELLM_API_KEY = "test-litellm-key";

    try {
      generateImageForWhatsappMock.mockResolvedValue({
        imageBase64: "aGVsbG8gd29ybGQ=",
        contentType: "image/jpeg",
      });
      saveMediaBufferMock.mockResolvedValue({
        id: "abc---uuid.jpg",
        path: "/config/media/tool-whatsapp-image-generation/abc---uuid.jpg",
        size: 11,
        contentType: "image/jpeg",
      });

      const { registerFull } = await import("./channel.js");
      const registerTool = vi.fn();
      const fakeApi = {
        config: {},
        runtime: { channel: {} },
        logger: { info: vi.fn(), error: vi.fn() },
        registerTool,
        registerHttpRoute: vi.fn(),
      };

      registerFull(fakeApi);

      const registeredTool = registerTool.mock.calls[0][0];
      const result = await registeredTool.execute("call-1", { prompt: "a red panda" });

      expect(saveMediaBufferMock).toHaveBeenCalledTimes(1);
      const [bufferArg, contentTypeArg, subdirArg] = saveMediaBufferMock.mock.calls[0];
      expect(Buffer.isBuffer(bufferArg)).toBe(true);
      expect(bufferArg.toString("base64")).toBe("aGVsbG8gd29ybGQ=");
      expect(contentTypeArg).toBe("image/jpeg");
      // Must start with "tool-" (or be the literal "outbound") to pass
      // isManagedMediaPathUnderRoot / MANAGED_MEDIA_SUBDIRS in
      // sandbox-paths-*.js -- any other subdir name is silently rejected by
      // the message tool's path resolution.
      expect(subdirArg.startsWith("tool-")).toBe(true);

      expect(result.details.path).toBe(
        "/config/media/tool-whatsapp-image-generation/abc---uuid.jpg",
      );
      expect(result.details).not.toHaveProperty("imageBase64");
      expect(result.details).not.toHaveProperty("buffer");
      expect(JSON.stringify(result)).not.toContain("aGVsbG8gd29ybGQ=");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("generate_image_for_whatsapp defaults to pollinations-image, but honors WHATSAPP_IMAGE_GENERATION_MODEL when set", async () => {
    const previous = {
      WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
      WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,
      WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,
      LITELLM_BASE_URL: process.env.LITELLM_BASE_URL,
      LITELLM_API_KEY: process.env.LITELLM_API_KEY,
      WHATSAPP_IMAGE_GENERATION_MODEL: process.env.WHATSAPP_IMAGE_GENERATION_MODEL,
    };
    process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "test-phone-id";
    process.env.WHATSAPP_APP_SECRET = "test-app-secret";
    process.env.WHATSAPP_VERIFY_TOKEN = "test-verify-token";
    process.env.LITELLM_BASE_URL = "http://litellm:4000";
    process.env.LITELLM_API_KEY = "test-litellm-key";
    delete process.env.WHATSAPP_IMAGE_GENERATION_MODEL;

    try {
      generateImageForWhatsappMock.mockResolvedValue({
        imageBase64: "aGVsbG8gd29ybGQ=",
        contentType: "image/jpeg",
      });
      saveMediaBufferMock.mockResolvedValue({
        id: "abc---uuid.jpg",
        path: "/config/media/tool-whatsapp-image-generation/abc---uuid.jpg",
        size: 11,
        contentType: "image/jpeg",
      });

      const { registerFull } = await import("./channel.js");
      const registerTool = vi.fn();
      const fakeApi = {
        config: {},
        runtime: { channel: {} },
        logger: { info: vi.fn(), error: vi.fn() },
        registerTool,
        registerHttpRoute: vi.fn(),
      };
      registerFull(fakeApi);
      const registeredTool = registerTool.mock.calls[0][0];

      await registeredTool.execute("call-1", { prompt: "a red panda" });
      expect(generateImageForWhatsappMock).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ model: "pollinations-image" }),
      );

      process.env.WHATSAPP_IMAGE_GENERATION_MODEL = "custom-image-model";
      await registeredTool.execute("call-2", { prompt: "a red panda" });
      expect(generateImageForWhatsappMock).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ model: "custom-image-model" }),
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
