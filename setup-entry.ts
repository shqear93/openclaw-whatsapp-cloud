import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { whatsappCloudPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(whatsappCloudPlugin);
