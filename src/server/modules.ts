/**
 * Modules on the server (fork feature): the operations behind /api/modules.
 * Every list-shape change announces chats-changed — the sidebar refetches
 * sessions and modules together on it, so modules need no event of their own.
 * Deleting a module unfiles its sessions; it never deletes them.
 */

import type { ModuleRecord, ModuleSummary } from "../core/contracts.ts";
import { emit } from "../core/events.ts";
import { moduleStore } from "../store/modules.ts";
import { stores } from "./stores.ts";

export const MODULE_TITLE_MAX = 120;
export const MODULE_GOAL_MAX = 2_000;
export const MODULE_PLAN_MAX = 40_000;

export function listModuleSummaries(): ModuleSummary[] {
	const counts = new Map<string, number>();
	for (const chat of stores.chatStore.listChats()) {
		if (chat.moduleId) counts.set(chat.moduleId, (counts.get(chat.moduleId) ?? 0) + 1);
	}
	return moduleStore.listModules().map((m) => ({ ...m, sessionCount: counts.get(m.id) ?? 0 }));
}

export function getModule(id: string): ModuleRecord | null {
	return moduleStore.getModule(id);
}

export function createModule(title: string, goal = ""): ModuleRecord {
	const record = moduleStore.createModule(title.slice(0, MODULE_TITLE_MAX), goal.slice(0, MODULE_GOAL_MAX));
	emit("chats-changed", {});
	return record;
}

export function updateModule(id: string, patch: { title?: string; goal?: string; plan?: string }): ModuleRecord {
	const record = moduleStore.updateModule(id, {
		...(patch.title !== undefined ? { title: patch.title.slice(0, MODULE_TITLE_MAX) } : {}),
		...(patch.goal !== undefined ? { goal: patch.goal.slice(0, MODULE_GOAL_MAX) } : {}),
		...(patch.plan !== undefined ? { plan: patch.plan.slice(0, MODULE_PLAN_MAX) } : {}),
	});
	emit("chats-changed", {});
	return record;
}

/** Unfile every session, then remove the module. False when unknown. */
export function deleteModule(id: string): boolean {
	if (!moduleStore.getModule(id)) return false;
	for (const chat of stores.chatStore.listChats()) {
		if (chat.moduleId === id) stores.chatStore.setModule(chat.id, null);
	}
	const removed = moduleStore.deleteModule(id);
	emit("chats-changed", {});
	return removed;
}

/** File a session into a module (null = unfile). Throws on unknown ids. */
export function fileSession(chatId: string, moduleId: string | null): void {
	if (moduleId !== null && !moduleStore.getModule(moduleId)) throw new Error(`Module not found: ${moduleId}`);
	stores.chatStore.setModule(chatId, moduleId);
}
