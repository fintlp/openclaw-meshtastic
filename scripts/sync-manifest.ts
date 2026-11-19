import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMeshtasticManifest } from "./manifest-builder.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "openclaw.plugin.json");
const packageJsonPath = path.join(repoRoot, "package.json");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

const updatedManifest = buildMeshtasticManifest(manifest, packageJson);
fs.writeFileSync(manifestPath, JSON.stringify(updatedManifest, null, 2) + "\n");
console.log("synced channelConfigs.meshtastic in openclaw.plugin.json");
