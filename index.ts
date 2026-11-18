import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { registerMeshtasticSessionSendRateLimit } from "./src/session-rate-limit.js";

export default defineBundledChannelEntry({
  id: "meshtastic",
  name: "Meshtastic",
  description: "Meshtastic mesh channel plugin via HTTP transport",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "meshtasticPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setMeshtasticRuntime",
  },
  registerFull: registerMeshtasticSessionSendRateLimit,
});
