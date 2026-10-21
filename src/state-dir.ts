import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the directory that persistent plugin state files live in
 * (inbound durability DB).
 *
 * Under vitest this NEVER resolves to the operator's real
 * `~/.openclaw/state`. Tests are expected to install their own per-test
 * path overrides, but a test that forgets one (or whose teardown fires an
 * async write after the override was cleared) would otherwise write live
 * state. (Ported from meshcore src/state-dir.ts — same guard class as the
 * batch-2 review round 1 finding there.)
 */
export function pluginStateDir(): string {
  if (process.env.VITEST) {
    return join(tmpdir(), "meshtastic-vitest-state");
  }
  return `${process.env.HOME ?? "~"}/.openclaw/state`;
}
