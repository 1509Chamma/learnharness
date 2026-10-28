/**
 * BACKUP (fork feature, 2026-10-28): dated snapshots of the data folder in
 * a folder of the learner's choosing (settings storage.backupFolder —
 * typically inside Google Drive for desktop, which syncs it off the
 * machine). The app keeps working from its local data folder; a snapshot
 * is a plain folder copy, so restoring is copying one back.
 *
 * Snapshots are folders named `learnharness-YYYY-MM-DD_HHMM` holding a
 * `lh-backup.json` marker. Only marked folders are ever pruned (the newest
 * KEEP survive) — nothing else in the backup folder is touched. Secrets
 * never leave: auth files are skipped by name at any depth, and the debug
 * recordings are skipped too.
 *
 * When: once a day — checked shortly after boot and hourly while running
 * (a snapshot is due when the newest one is 24h old) — and on demand
 * (POST /api/backup).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { BackupStatus, Snapshot } from "../core/storage-status.ts";
import { readSettings } from "../store/settings.ts";

export const KEEP = 30;
const DAY_MS = 24 * 60 * 60_000;
const SNAPSHOT_RE = /^learnharness-\d{4}-\d{2}-\d{2}_\d{4}(-\d+)?$/;
const MARKER = "lh-backup.json";
/** Never copied: credentials (by file name, at any depth) and debug dumps. */
const SKIP_NAMES = new Set(["auth.json", "chatgpt-credentials.json", "debug"]);


export function backupFolder(): string | null {
	return readSettings()?.storage?.backupFolder?.trim() || null;
}

function stamp(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Marked snapshots in a folder, newest first. Unreadable folder = none. */
export function listSnapshots(folder: string): Snapshot[] {
	let names: string[];
	try {
		names = fs.readdirSync(folder);
	} catch {
		return [];
	}
	const out: Snapshot[] = [];
	for (const name of names) {
		if (!SNAPSHOT_RE.test(name)) continue;
		try {
			const marker = JSON.parse(fs.readFileSync(path.join(folder, name, MARKER), "utf-8")) as { createdAt?: string };
			if (typeof marker.createdAt === "string") out.push({ name, createdAt: marker.createdAt });
		} catch {
			/* no marker — not ours, never listed or pruned */
		}
	}
	return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Refuse folders that would copy the data folder into itself (or vice versa). */
function assertOutsideData(folder: string, dataDir: string): void {
	const rel = path.relative(path.resolve(dataDir), path.resolve(folder));
	const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
	const relBack = path.relative(path.resolve(folder), path.resolve(dataDir));
	const contains = !relBack.startsWith("..") && !path.isAbsolute(relBack);
	if (inside || contains) throw new Error("The backup folder must be outside the app's data folder");
}

/**
 * Write one snapshot of `dataDir` into `folder`, then prune to KEEP.
 * Returns the new snapshot. Throws when the folder is unusable.
 */
export function snapshot(folder: string, dataDir: string = PATHS.data, now = new Date()): Snapshot {
	if (!path.isAbsolute(folder)) throw new Error("The backup folder must be an absolute path");
	assertOutsideData(folder, dataDir);
	fs.mkdirSync(folder, { recursive: true });
	let name = `learnharness-${stamp(now)}`;
	for (let i = 2; fs.existsSync(path.join(folder, name)); i++) name = `learnharness-${stamp(now)}-${i}`;
	const target = path.join(folder, name);
	fs.mkdirSync(target, { recursive: true });
	if (fs.existsSync(dataDir)) {
		fs.cpSync(dataDir, path.join(target, "data"), {
			recursive: true,
			filter: (src) => !SKIP_NAMES.has(path.basename(src)),
		});
	}
	const createdAt = now.toISOString();
	// The marker goes last: a snapshot interrupted mid-copy has none, so it
	// is never listed as good (and never pruned either — left for the learner).
	fs.writeFileSync(path.join(target, MARKER), JSON.stringify({ createdAt, source: dataDir }, null, "\t"), "utf-8");
	for (const old of listSnapshots(folder).slice(KEEP)) {
		fs.rmSync(path.join(folder, old.name), { recursive: true, force: true });
	}
	return { name, createdAt };
}

/** Whether a snapshot is due: none yet, or the newest is a day old. */
export function snapshotDue(folder: string, now = new Date()): boolean {
	const newest = listSnapshots(folder)[0];
	return !newest || now.getTime() - Date.parse(newest.createdAt) >= DAY_MS;
}

// ─── the process-wide runner ─────────────────────────────────────────────────

interface BackupGlobal {
	__lhBackup?: { running: boolean; lastError: string | null; started: boolean };
}

function runner() {
	const g = globalThis as BackupGlobal;
	g.__lhBackup ??= { running: false, lastError: null, started: false };
	return g.__lhBackup;
}

export function backupStatus(): BackupStatus {
	const r = runner();
	const folder = backupFolder();
	return { folder, running: r.running, snapshots: folder ? listSnapshots(folder) : [], lastError: r.lastError };
}

/** Take a snapshot now (if a folder is configured). */
export function backUpNow(): BackupStatus {
	const r = runner();
	const folder = backupFolder();
	if (!folder) {
		r.lastError = "No backup folder is set";
		return backupStatus();
	}
	if (r.running) return backupStatus();
	r.running = true;
	try {
		snapshot(folder);
		r.lastError = null;
	} catch (err) {
		r.lastError = err instanceof Error ? err.message : String(err);
	} finally {
		r.running = false;
	}
	return backupStatus();
}

function backUpIfDue(): void {
	const folder = backupFolder();
	if (folder && snapshotDue(folder)) backUpNow();
}

/** Idempotent boot: a first check a minute after start, then hourly.
 *  Never under the test runner or during the production build. */
export function startBackupSchedule(): void {
	const r = runner();
	if (r.started || process.env.NODE_ENV === "test" || process.env.NEXT_PHASE === "phase-production-build") return;
	r.started = true;
	setTimeout(backUpIfDue, 60_000).unref?.();
	setInterval(backUpIfDue, 60 * 60_000).unref?.();
}

startBackupSchedule();
