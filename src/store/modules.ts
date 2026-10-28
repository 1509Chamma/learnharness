/**
 * ModuleStore — the fs JSON adapter for modules (fork feature): one file per
 * module in data/modules/, the chat store's idioms (sync fs, id-guarded
 * filenames, tab-indented JSON). Session membership lives on the chat
 * records (ChatRecord.moduleId), not here.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { ModuleRecord } from "../core/contracts.ts";

function moduleFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid module id: ${id}`);
	return path.join(PATHS.modules, `${id}.json`);
}

function write(record: ModuleRecord): void {
	fs.mkdirSync(PATHS.modules, { recursive: true });
	fs.writeFileSync(moduleFile(record.id), JSON.stringify(record, null, "\t"), "utf-8");
}

function createModule(title: string, goal: string): ModuleRecord {
	const now = new Date().toISOString();
	const record: ModuleRecord = {
		id: `mod_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		title: title.trim() || "Untitled module",
		goal: goal.trim(),
		plan: "",
		createdAt: now,
		updatedAt: now,
	};
	write(record);
	return record;
}

function getModule(id: string): ModuleRecord | null {
	try {
		return JSON.parse(fs.readFileSync(moduleFile(id), "utf-8")) as ModuleRecord;
	} catch {
		return null;
	}
}

/** All modules, alphabetical by title (a stable sidebar order). */
function listModules(): ModuleRecord[] {
	try {
		fs.mkdirSync(PATHS.modules, { recursive: true });
		return fs
			.readdirSync(PATHS.modules)
			.filter((f) => f.endsWith(".json"))
			.map((f) => getModule(f.slice(0, -5)))
			.filter((m): m is ModuleRecord => m !== null)
			.sort((a, b) => a.title.localeCompare(b.title));
	} catch {
		return [];
	}
}

function updateModule(id: string, patch: Partial<Pick<ModuleRecord, "title" | "goal" | "plan">>): ModuleRecord {
	const record = getModule(id);
	if (!record) throw new Error(`Module not found: ${id}`);
	const next: ModuleRecord = {
		...record,
		...(patch.title !== undefined ? { title: patch.title.trim() || record.title } : {}),
		...(patch.goal !== undefined ? { goal: patch.goal.trim() } : {}),
		...(patch.plan !== undefined ? { plan: patch.plan } : {}),
		updatedAt: new Date().toISOString(),
	};
	write(next);
	return next;
}

function deleteModule(id: string): boolean {
	try {
		fs.unlinkSync(moduleFile(id));
		return true;
	} catch {
		return false;
	}
}

export const moduleStore = { createModule, getModule, listModules, updateModule, deleteModule };
export type ModuleStore = typeof moduleStore;
