// The `npm test` entry: one cross-platform launcher instead of a POSIX
// `NODE_ENV=test tsx --test tests/*.test.ts` line (cmd.exe neither sets
// inline env vars nor expands globs, so that never ran on Windows).
//
// Isolation: several suites use the stores' default paths, which resolve to
// the repo's real data/ and auth.json when LH_DATA_DIR / LH_AUTH_FILE are
// unset — so a plain test run wrote scratch chats and jobs into the
// developer's own sessions. Unless the caller sets them, both point into a
// throwaway temp dir that is removed afterwards. Suites that need their own
// dirs still set them before importing, as before.
//
// Extra arguments replace the default globs: `npm test -- tests/foo.test.ts`.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-test-run-"));
const env = { ...process.env, NODE_ENV: "test" };
env.LH_DATA_DIR ??= path.join(scratch, "data");
if (!env.LH_AUTH_FILE) {
	env.LH_AUTH_FILE = path.join(scratch, "auth.json");
	fs.writeFileSync(env.LH_AUTH_FILE, "{}");
}

const targets = process.argv.slice(2);
const globs = targets.length > 0 ? targets : ["tests/*.test.ts", "tests/*.test.tsx"];
// Node's test runner expands the globs itself, identically on every OS.
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...globs], { stdio: "inherit", env });

fs.rmSync(scratch, { recursive: true, force: true });
process.exit(result.status ?? 1);
