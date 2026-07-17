import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { whatsappCloudPlugin, registerFull } from "./src/channel.js";

export default defineChannelPluginEntry({
  id: "whatsapp-cloud",
  name: "WhatsApp Cloud",
  description: "Meta WhatsApp Business Cloud API channel plugin.",
  plugin: whatsappCloudPlugin,
  registerFull,
});
