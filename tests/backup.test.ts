/**
 * Backups (fork feature): a snapshot copies the data folder (never the
 * credentials or debug dumps), marks itself last, prunes only its own
 * marked snapshots down to KEEP, refuses a folder inside the data folder,
 * and is due once a day. Plus the storage settings section.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "lh-backup-"));
process.env.LH_DATA_DIR = path.join(ROOT, "data");

const { KEEP, listSnapshots, snapshot, snapshotDue } = await import("../src/server/backup.ts");
const { parseStorageSettingsBody } = await import("../src/server/settings-body.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function makeData(): string {
	const data = path.join(ROOT, `data-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(path.join(data, "chats"), { recursive: true });
	fs.mkdirSync(path.join(data, "graph"), { recursive: true });
	fs.mkdirSync(path.join(data, "debug"), { recursive: true });
	fs.writeFileSync(path.join(data, "chats", "chat_a.json"), "{}");
	fs.writeFileSync(path.join(data, "graph", "nodes.jsonl"), "{}\n");
	fs.writeFileSync(path.join(data, "settings.json"), "{}");
	fs.writeFileSync(path.join(data, "auth.json"), '{"ANTHROPIC_API_KEY":"secret"}');
	fs.writeFileSync(path.join(data, "debug", "events.jsonl"), "x");
	return data;
}

describe("snapshot", () => {
	it("copies the data folder, skipping credentials and debug dumps, and marks itself", () => {
		const data = makeData();
		const folder = path.join(ROOT, "drive-1");
		const snap = snapshot(folder, data, new Date(2026, 9, 28, 9, 5));
		assert.equal(snap.name, "learnharness-2026-10-28_0905");
		const copied = path.join(folder, snap.name, "data");
		assert.ok(fs.existsSync(path.join(copied, "chats", "chat_a.json")));
		assert.ok(fs.existsSync(path.join(copied, "graph", "nodes.jsonl")));
		assert.ok(fs.existsSync(path.join(copied, "settings.json")));
		assert.ok(!fs.existsSync(path.join(copied, "auth.json")), "keys never leave");
		assert.ok(!fs.existsSync(path.join(copied, "debug")));
		assert.deepEqual(listSnapshots(folder).map((s) => s.name), [snap.name]);
	});

	it("never overwrites: a second snapshot in the same minute gets a suffix", () => {
		const data = makeData();
		const folder = path.join(ROOT, "drive-2");
		const when = new Date(2026, 9, 28, 9, 5);
		snapshot(folder, data, when);
		const second = snapshot(folder, data, when);
		assert.equal(second.name, "learnharness-2026-10-28_0905-2");
	});

	it("prunes to the newest KEEP marked snapshots and leaves everything else alone", () => {
		const data = makeData();
		const folder = path.join(ROOT, "drive-3");
		fs.mkdirSync(path.join(folder, "my-notes"), { recursive: true });
		fs.mkdirSync(path.join(folder, "learnharness-2020-01-01_0000"), { recursive: true }); // unmarked: not ours to prune
		for (let i = 0; i < KEEP + 3; i++) snapshot(folder, data, new Date(2026, 0, 1 + i, 12, 0));
		const kept = listSnapshots(folder);
		assert.equal(kept.length, KEEP);
		assert.equal(kept[0]!.name, `learnharness-2026-02-02_1200`, "the newest survives");
		assert.ok(!kept.some((s) => s.name.startsWith("learnharness-2026-01-01")), "the oldest went");
		assert.ok(fs.existsSync(path.join(folder, "my-notes")));
		assert.ok(fs.existsSync(path.join(folder, "learnharness-2020-01-01_0000")));
	});

	it("refuses a folder inside the data folder, or one that contains it", () => {
		const data = makeData();
		assert.throws(() => snapshot(path.join(data, "backups"), data), /outside the app's data folder/);
		assert.throws(() => snapshot(path.dirname(data), data), /outside the app's data folder/);
		assert.throws(() => snapshot("relative/folder", data), /absolute path/);
	});

	it("is due when none exists or the newest is a day old", () => {
		const data = makeData();
		const folder = path.join(ROOT, "drive-4");
		assert.equal(snapshotDue(folder), true);
		const now = new Date(2026, 9, 28, 9, 0);
		snapshot(folder, data, now);
		assert.equal(snapshotDue(folder, new Date(now.getTime() + 23 * 3600_000)), false);
		assert.equal(snapshotDue(folder, new Date(now.getTime() + 24 * 3600_000)), true);
	});
});

describe("storage settings", () => {
	it("accepts absolute folders, clears on empty, rejects relative paths and non-strings", () => {
		const abs = path.join(ROOT, "drive");
		const ok = parseStorageSettingsBody({ backupFolder: ` ${abs} `, obsidianFolder: "" });
		assert.ok(ok.ok);
		assert.deepEqual(ok.settings, { backupFolder: abs });
		assert.equal(parseStorageSettingsBody({ backupFolder: "relative" }).ok, false);
		assert.equal(parseStorageSettingsBody({ backupFolder: 3 }).ok, false);
	});

	it("survives the read side", () => {
		const record = sanitizeUserSettings({ version: 1, storage: { backupFolder: "G:\\My Drive\\LH", junk: 1 } })!;
		assert.deepEqual(record.storage, { backupFolder: "G:\\My Drive\\LH" });
	});
});
