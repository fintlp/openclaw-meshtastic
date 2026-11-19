import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

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
});
