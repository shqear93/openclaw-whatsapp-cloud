import { describe, expect, it } from "vitest";

describe("index (full plugin entry)", () => {
  it("imports without requiring env vars and exposes the defined channel plugin entry", async () => {
    // Regression test: importing index.ts (and thus channel.ts, which builds
    // whatsappCloudPlugin via createChatChannelPlugin) must not throw even
    // when none of the WhatsApp env vars are set -- this is the module
    // OpenClaw's plugin loader imports for the "full" entry, including in
    // contexts like `openclaw doctor` where env vars may be absent.
    const previous = {
      WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
      WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,
      WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,
    };
    for (const key of Object.keys(previous) as Array<keyof typeof previous>) {
      delete process.env[key];
    }

    try {
      const entryModule = await import("./index.js");
      const entry = entryModule.default;
      expect(entry.id).toBe("whatsapp-cloud");
      expect(entry.name).toBe("WhatsApp Cloud");
      expect(entry.channelPlugin.id).toBe("whatsapp-cloud");
      expect(typeof entry.register).toBe("function");
    } finally {
      for (const [key, value] of Object.entries(previous) as Array<
        [keyof typeof previous, string | undefined]
      >) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
