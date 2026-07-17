import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import packageManifest from "./package.json" with { type: "json" };

const dirname = path.dirname(fileURLToPath(import.meta.url));

describe("package.json openclaw.setupEntry", () => {
  it("declares a setupEntry that OpenClaw's plugin loader can discover on disk", () => {
    // Regression test: OpenClaw's resolvePackageSetupSource() reads
    // packageManifest.openclaw.setupEntry (not a filename convention) to
    // find the setup-only entry point. Without this field, setup-entry.ts
    // is dead code -- never loaded in setup-only/disabled-channel mode.
    const setupEntry = packageManifest.openclaw?.setupEntry;
    expect(setupEntry).toBe("./setup-entry.ts");
    expect(existsSync(path.join(dirname, setupEntry as string))).toBe(true);
  });
});

describe("setup-entry (setup-only plugin entry)", () => {
  it("imports without requiring env vars and never calls registerFull", async () => {
    // Regression test: setup-entry.ts is loaded even when the channel is
    // disabled (e.g. for setup/configuration UI), so importing it must not
    // trigger any env-var-dependent code. Only whatsappCloudPlugin (already
    // proven lazy-safe) is referenced -- registerFull is never imported or
    // invoked here.
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
      const entryModule = await import("./setup-entry.js");
      const entry = entryModule.default;
      expect(entry.plugin.id).toBe("whatsapp-cloud");
      // The setup entry helper's return shape is `{ plugin }` only -- it must
      // not expose a `register`/`registerFull` hook of its own.
      expect(Object.keys(entry)).toEqual(["plugin"]);
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
