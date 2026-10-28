/**
 * SESSION RECAPS (modules, fork feature): a short recap of each session in
 * a module — what it covered, where the learner struggled, what comes next —
 * written by the cheap slot. The module panel shows them; the orchestrator
 * reads them (module_state) and passes them on in new sessions' briefings.
 *
 * When: RECAP_IDLE_MS after a module session's turn settles (debounced per
 * session, so a live conversation writes one recap once it goes quiet), and
 * on demand when the orchestrator reads its module — any stale recap is
 * refreshed first. Stale = missing, or written for an older updatedAt.
 * Each call takes a permit from the shared background-LLM pool.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { ChatRecord } from "../core/contracts.ts";
import { subscribe } from "../core/events.ts";
import { sessionMarkdown } from "../core/session-markdown.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { runSubagent } from "../agent/subagents/pi-run.ts";
import { withBgLlmSlot } from "../agent/subagents/bg-llm-semaphore.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

export const RECAP_IDLE_MS = 10 * 60_000;
/** The transcript tail a recap reads (characters) — long sessions keep
 *  their recent end, which is where struggles and next steps live. */
const TRANSCRIPT_CHARS = 60_000;

const RECAP_SYSTEM_PROMPT =
	"You write short recaps of tutoring sessions for the learner's module planner. Output only the recap — no preamble, no headings.";

export function recapPrompt(transcript: string): string {
	return [
		"Recap this session in at most 120 words, as exactly three lines:",
		"Covered: what the session actually went through (topics, results, sources).",
		"Struggled with: the specific concepts or steps the learner got wrong, hesitated on or asked to revisit — or \"nothing notable\".",
		"Next: what the following session should pick up.",
		"",
		"Transcript:",
		transcript,
	].join("\n");
}

/** A session worth recapping: a real session (not an orchestrator chat) in
 *  a module, with at least one exchange. */
export function recapEligible(chat: Pick<ChatRecord, "kind" | "moduleId" | "messages">): boolean {
	if (!chat.moduleId || chat.kind === "orchestrator") return false;
	const roles = new Set(chat.messages.map((m) => (m as { role?: string }).role));
	return roles.has("user") && roles.has("assistant");
}

export function recapStale(chat: Pick<ChatRecord, "kind" | "moduleId" | "messages" | "recap" | "updatedAt">): boolean {
	return recapEligible(chat) && chat.recap?.forUpdatedAt !== chat.updatedAt;
}

export type RecapWriter = (prompt: string, engine: PiEngine) => Promise<{ text: string; usage?: Usage }>;

const defaultWriter: RecapWriter = async (prompt, engine) => {
	const { text } = await runSubagent([], {
		// One-shot text job on an explicit engine; the role label is inert
		// (the compaction summarizer's precedent).
		role: "researcher" as never,
		prompt,
		engine,
		systemPrompt: RECAP_SYSTEM_PROMPT,
		maxTurns: 1,
	});
	return { text };
};

/** Write one session's recap now. False when skipped (ineligible, fresh,
 *  mid-turn, no cheap model) or failed — recaps are best effort. */
export async function writeRecap(chatId: string, writer: RecapWriter = defaultWriter): Promise<boolean> {
	const chat = stores.chatStore.getChat(chatId);
	if (!chat || !recapStale(chat) || isTurnRunning(chatId)) return false;
	const cheap = effectiveSettings().models.cheap;
	if (!cheap) return false;
	const forUpdatedAt = chat.updatedAt;
	const transcript = sessionMarkdown(chat.messages, { title: chat.title, anchors: false }).slice(-TRANSCRIPT_CHARS);
	try {
		const { text } = await withBgLlmSlot(undefined, () => writer(recapPrompt(transcript), piEngineForSpec(cheap)));
		const recap = text.trim();
		if (!recap) return false;
		stores.chatStore.saveRecap(chatId, { text: recap, forUpdatedAt });
		return true;
	} catch (err) {
		console.error(`recap failed for ${chatId}:`, err);
		return false;
	}
}

/** Refresh every stale recap in a module (in parallel, bounded by the
 *  shared pool). Never throws. */
export async function refreshModuleRecaps(moduleId: string, writer?: RecapWriter): Promise<void> {
	const stale = stores.chatStore
		.listChats()
		.filter((c) => c.moduleId === moduleId && c.kind !== "orchestrator")
		.map((c) => stores.chatStore.getChat(c.id))
		.filter((c): c is ChatRecord => c !== null && recapStale(c));
	await Promise.all(stale.map((c) => writeRecap(c.id, writer)));
}

// ─── the idle trigger (process-wide, globalThis like the event bus) ─────────

interface RecapGlobal {
	__lhRecaps?: { timers: Map<string, ReturnType<typeof setTimeout>>; subscribed: boolean };
}

function recapRunner() {
	const g = globalThis as RecapGlobal;
	g.__lhRecaps ??= { timers: new Map(), subscribed: false };
	return g.__lhRecaps;
}

/** (Re)arm a session's idle timer: the recap is written once the session
 *  has been quiet for RECAP_IDLE_MS. */
export function scheduleRecap(chatId: string, delayMs = RECAP_IDLE_MS): void {
	const r = recapRunner();
	const existing = r.timers.get(chatId);
	if (existing) clearTimeout(existing);
	const timer = setTimeout(() => {
		r.timers.delete(chatId);
		void writeRecap(chatId);
	}, delayMs);
	timer.unref?.();
	r.timers.set(chatId, timer);
}

/** Idempotent boot: every settled turn in a module session arms its timer.
 *  Never under the test runner or during the production build. */
export function startRecapTrigger(): void {
	const r = recapRunner();
	if (r.subscribed || process.env.NODE_ENV === "test" || process.env.NEXT_PHASE === "phase-production-build") return;
	r.subscribed = true;
	subscribe((event) => {
		if (event.type !== "turn-settled") return;
		const chatId = (event as { chatId?: string }).chatId;
		if (!chatId) return;
		const chat = stores.chatStore.getChat(chatId);
		if (chat && recapEligible(chat)) scheduleRecap(chatId);
	});
}

startRecapTrigger();
