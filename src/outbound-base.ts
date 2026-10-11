import { sanitizeForPlainText } from "openclaw/plugin-sdk/channel-outbound";
import { chunkTextForOutbound } from "./channel-api.js";

export const meshtasticOutboundBaseAdapter = {
  deliveryMode: "direct" as const,
  chunker: chunkTextForOutbound,
  chunkerMode: "text" as const,
  textChunkLimit: 200,
  sanitizeText: ({ text }: { text: string }) => sanitizeForPlainText(text),
};
