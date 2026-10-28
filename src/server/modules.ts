/**
 * Modules on the server (fork feature): the operations behind /api/modules.
 * Every list-shape change announces chats-changed — the sidebar refetches
 * sessions and modules together on it, so modules need no event of their own.
 * Deleting a module unfiles its sessions; it never deletes them.
 */

import type { ChatSummary, ModuleRecord, ModuleSummary } from "../core/contracts.ts";
import { emit } from "../core/events.ts";
import { newModuleContextMessage } from "../core/native-messages.ts";
import type { CreatedSession, ModuleStateView } from "../agent/tools/orchestrator.ts";
import { moduleStore } from "../store/modules.ts";
import { readSettings } from "../store/settings.ts";
import { stores } from "./stores.ts";

export const MODULE_TITLE_MAX = 120;
export const MODULE_GOAL_MAX = 2_000;
export const MODULE_PLAN_MAX = 40_000;

/** Learner-facing sessions only: a module's orchestrator chat is never a
 *  session (not listed, not counted, not extracted). */
export function isSession(chat: Pick<ChatSummary, "kind">): boolean {
	return chat.kind !== "orchestrator";
}

/** A module's sessions, newest activity first. */
export function moduleSessions(moduleId: string): ChatSummary[] {
	return stores.chatStore.listChats().filter((c) => c.moduleId === moduleId && isSession(c));
}

export function listModuleSummaries(): ModuleSummary[] {
	const counts = new Map<string, number>();
	for (const chat of stores.chatStore.listChats()) {
		if (chat.moduleId && isSession(chat)) counts.set(chat.moduleId, (counts.get(chat.moduleId) ?? 0) + 1);
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
	if (patch.title !== undefined) {
		const orchestrator = stores.chatStore.listChats().find((c) => c.moduleId === id && c.kind === "orchestrator");
		if (orchestrator && orchestrator.title !== record.title) stores.chatStore.renameChat(orchestrator.id, record.title);
	}
	emit("chats-changed", {});
	return record;
}

/** Unfile every session, delete the orchestrator chat, then remove the
 *  module. False when unknown. */
export function deleteModule(id: string): boolean {
	if (!moduleStore.getModule(id)) return false;
	for (const chat of stores.chatStore.listChats()) {
		if (chat.moduleId !== id) continue;
		if (isSession(chat)) stores.chatStore.setModule(chat.id, null);
		else stores.chatStore.deleteChat(chat.id);
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

/** Stamp the strong slot onto a new chat, exactly as POST /api/chats does:
 *  a session owns its model from birth. No slot configured = no stamp. */
function stampStrongSlot(chatId: string): void {
	const strong = readSettings()?.models?.strong;
	if (strong?.model) {
		stores.chatStore.saveSettings(chatId, {
			model: { provider: strong.model.provider, id: strong.model.id },
			thinkingLevel: strong.thinkingLevel,
		});
	}
}

/** The module's orchestrator chat, created on first use. */
export function ensureOrchestratorChat(moduleId: string): string {
	const mod = moduleStore.getModule(moduleId);
	if (!mod) throw new Error(`Module not found: ${moduleId}`);
	const existing = stores.chatStore.listChats().find((c) => c.moduleId === moduleId && c.kind === "orchestrator");
	if (existing) return existing.id;
	const chat = stores.chatStore.createChat(mod.title, "orchestrator");
	stores.chatStore.setModule(chat.id, moduleId);
	stampStrongSlot(chat.id);
	return chat.id;
}

/** The orchestrator's view of its module (module_state). */
export function moduleStateView(moduleId: string): ModuleStateView | null {
	const mod = moduleStore.getModule(moduleId);
	if (!mod) return null;
	return {
		title: mod.title,
		goal: mod.goal,
		plan: mod.plan,
		sessions: moduleSessions(moduleId).map((s) => ({
			id: s.id,
			title: s.title,
			kind: s.kind === "practice" ? "practice" : "teach",
			createdAt: s.createdAt,
			updatedAt: s.updatedAt,
			...(s.recap?.text ? { recap: s.recap.text } : {}),
		})),
	};
}

/** A session the orchestrator creates: filed into the module, stamped with
 *  the strong slot, and opening with the module briefing marker. */
export function createModuleSession(
	moduleId: string,
	input: { title: string; kind: "teach" | "practice"; brief: string },
): CreatedSession {
	const mod = moduleStore.getModule(moduleId);
	if (!mod) throw new Error(`Module not found: ${moduleId}`);
	const recaps = moduleSessions(moduleId)
		.map((s) => ({ title: s.title, recap: s.recap?.text ?? "", createdAt: s.createdAt }))
		.filter((r) => r.recap)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
		.map(({ title, recap }) => ({ title, recap }));
	const chat = stores.chatStore.createChat(input.title, input.kind === "practice" ? "practice" : undefined);
	stores.chatStore.setModule(chat.id, moduleId);
	stampStrongSlot(chat.id);
	stores.chatStore.saveMessages(chat.id, [
		newModuleContextMessage({ moduleId, moduleTitle: mod.title, goal: mod.goal, plan: mod.plan, brief: input.brief, recaps }),
	]);
	return { chatId: chat.id, title: chat.title, kind: input.kind };
}
