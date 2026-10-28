/**
 * ANKI SYNC (fork feature, 2026-10-28): pushes the graph into Anki desktop
 * through the AnkiConnect add-on (http://127.0.0.1:8765), then asks Anki to
 * sync to AnkiWeb so the cards reach the phone.
 *
 * Stateless by design: every note carries its graph id in its first field,
 * so each run reads the notes back from Anki and diffs — nothing is written
 * to the data folder. The rules:
 *   - a node/chain without a note → add it;
 *   - a note whose text differs from the graph → update the fields (Anki
 *     keeps the review history — scheduling lives on the cards);
 *   - a note whose node/chain left the graph → suspend its cards and tag it
 *     LearnHarness::deleted (never deleted — the history stays);
 *   - suspension is the learner's: the sync never unsuspends anything.
 *
 * When it runs: on boot, after the graph changes (an extraction settles,
 * a session or node is deleted — debounced, and only once no extraction is
 * in flight), and on demand (POST /api/anki). Anki closed is a normal state:
 * the run reports "unreachable" and the next trigger tries again.
 */

import {
	ANKI_DECK,
	DELETED_TAG,
	MODEL_DEFINITIONS,
	desiredNotes,
	keyField,
	type DesiredNote,
} from "../core/anki-cards.ts";
import type { AnkiStatus, AnkiSyncCounts } from "../core/anki-status.ts";
import { subscribe } from "../core/events.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { graphRevision, graphView } from "./graph.ts";
import { moduleStore } from "../store/modules.ts";
import { stores } from "./stores.ts";

const ANKI_URL = process.env.LH_ANKI_URL ?? "http://127.0.0.1:8765";
const DEBOUNCE_MS = 5_000;

/** One AnkiConnect call. Injectable for tests. */
export type AnkiRequest = (action: string, params?: Record<string, unknown>) => Promise<unknown>;

export class AnkiUnreachableError extends Error {}

export const ankiConnect: AnkiRequest = async (action, params = {}) => {
	let res: Response;
	try {
		res = await fetch(ANKI_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action, version: 6, params }),
			signal: AbortSignal.timeout(action === "sync" ? 60_000 : 10_000),
		});
	} catch {
		throw new AnkiUnreachableError("Anki is not running, or the AnkiConnect add-on is not installed");
	}
	const body = (await res.json()) as { result: unknown; error: string | null };
	if (body.error) throw new Error(`AnkiConnect ${action}: ${body.error}`);
	return body.result;
};

interface NoteInfo {
	noteId: number;
	modelName: string;
	tags: string[];
	fields: Record<string, { value: string }>;
	cards: number[];
}

/** One diff-and-push pass. Pure over its inputs: the graph's notes and an
 *  AnkiConnect transport. Returns the counts plus the AnkiWeb outcome. */
export async function pushNotes(
	desired: DesiredNote[],
	request: AnkiRequest,
): Promise<{ counts: AnkiSyncCounts; webSync: string | null }> {
	const decks = (await request("deckNames")) as string[];
	if (!decks.includes(ANKI_DECK)) await request("createDeck", { deck: ANKI_DECK });
	const models = (await request("modelNames")) as string[];
	for (const def of MODEL_DEFINITIONS) {
		if (!models.includes(def.modelName)) await request("createModel", { ...def, isCloze: false });
	}

	const counts: AnkiSyncCounts = {
		recall: desired.filter((n) => keyField(n.model) === "NodeId").length,
		derivation: desired.filter((n) => keyField(n.model) === "ChainId").length,
		added: 0,
		updated: 0,
		suspended: 0,
	};

	const existing = new Map<string, NoteInfo>();
	for (const def of MODEL_DEFINITIONS) {
		const ids = (await request("findNotes", { query: `"note:${def.modelName}"` })) as number[];
		if (ids.length === 0) continue;
		const infos = (await request("notesInfo", { notes: ids })) as NoteInfo[];
		const field = keyField(def.modelName);
		for (const info of infos) {
			const key = info.fields[field]?.value;
			if (key) existing.set(`${def.modelName}\n${key}`, info);
		}
	}

	const toAdd: DesiredNote[] = [];
	const wanted = new Set<string>();
	for (const note of desired) {
		const id = `${note.model}\n${note.key}`;
		wanted.add(id);
		const info = existing.get(id);
		if (!info) {
			toAdd.push(note);
			continue;
		}
		const fields = note.fields as Record<string, string>;
		if (Object.entries(fields).some(([k, v]) => info.fields[k]?.value !== v)) {
			await request("updateNoteFields", { note: { id: info.noteId, fields } });
			counts.updated++;
		}
		const missingTags = note.tags.filter((t) => !info.tags.includes(t));
		if (missingTags.length > 0) await request("addTags", { notes: [info.noteId], tags: missingTags.join(" ") });
		// A session that moved into (or out of) a module re-tags its cards:
		// our own LearnHarness:: tags that no longer apply come off. The
		// learner's own tags and the deleted marker are never touched.
		const staleTags = info.tags.filter((t) => t.startsWith(`${ANKI_DECK}::`) && t !== DELETED_TAG && !note.tags.includes(t));
		if (staleTags.length > 0) await request("removeTags", { notes: [info.noteId], tags: staleTags.join(" ") });
	}

	const payload = (note: DesiredNote) => ({
		deckName: ANKI_DECK,
		modelName: note.model,
		fields: note.fields,
		tags: note.tags,
		options: { allowDuplicate: false, duplicateScope: "deck" },
	});
	for (let i = 0; i < toAdd.length; i += 50) {
		const batch = toAdd.slice(i, i + 50);
		try {
			const ids = (await request("addNotes", { notes: batch.map(payload) })) as Array<number | null>;
			counts.added += ids.filter((id) => id !== null).length;
		} catch (err) {
			if (err instanceof AnkiUnreachableError) throw err;
			// Newer AnkiConnect rejects the whole batch when one note fails —
			// fall back to one at a time so a single bad note skips alone.
			for (const note of batch) {
				try {
					await request("addNote", { note: payload(note) });
					counts.added++;
				} catch (inner) {
					if (inner instanceof AnkiUnreachableError) throw inner;
				}
			}
		}
	}

	const gone = [...existing].filter(([id, info]) => !wanted.has(id) && !info.tags.includes(DELETED_TAG));
	if (gone.length > 0) {
		await request("suspend", { cards: gone.flatMap(([, info]) => info.cards) });
		await request("addTags", { notes: gone.map(([, info]) => info.noteId), tags: DELETED_TAG });
		counts.suspended = gone.length;
	}

	let webSync: string | null = null;
	try {
		await request("sync");
	} catch (err) {
		if (err instanceof AnkiUnreachableError) throw err;
		webSync = "Cards are in Anki, but the AnkiWeb sync failed — sign in to AnkiWeb in Anki desktop";
	}
	return { counts, webSync };
}

/** Birth session id → its module's title (modules): the Anki tag nests the
 *  session under its module. */
function moduleTitleLookup(): (sessionId: string) => string | null {
	const titles = new Map(moduleStore.listModules().map((m) => [m.id, m.title]));
	const moduleOf = new Map(
		stores.chatStore.listChats().flatMap((c) => (c.moduleId ? [[c.id, c.moduleId] as const] : [])),
	);
	return (sessionId) => {
		const moduleId = moduleOf.get(sessionId);
		return moduleId ? (titles.get(moduleId) ?? null) : null;
	};
}

/** Everything a sync's output depends on: the graph's revision, and which
 *  module (and module title) each session sits in — filing a session moves
 *  its cards' tags without touching the graph. */
function syncSignature(): string {
	const modules = moduleStore.listModules().map((m) => `${m.id}=${m.title}`).join(",");
	const filed = stores.chatStore
		.listChats()
		.flatMap((c) => (c.moduleId ? [`${c.id}>${c.moduleId}`] : []))
		.sort()
		.join(",");
	return `${graphRevision()}|${modules}|${filed}`;
}

// ─── the process-wide runner ──────────────────────────────────────────────────
// globalThis, not module state: dev compiles routes as separate module
// instances (the event-bus rationale, src/core/events.ts).

interface AnkiGlobal {
	__lhAnki?: {
		status: AnkiStatus;
		running: Promise<AnkiStatus> | null;
		timer: ReturnType<typeof setTimeout> | null;
		/** What the last successful run synced: the graph revision plus the
		 *  module membership that shapes the tags (syncSignature). */
		syncedSignature: string | null;
		subscribed: boolean;
	};
}

function runner() {
	const g = globalThis as AnkiGlobal;
	g.__lhAnki ??= {
		status: { state: "never", lastSyncAt: null, counts: null, message: null },
		running: null,
		timer: null,
		syncedSignature: null,
		subscribed: false,
	};
	return g.__lhAnki;
}

export function ankiStatus(): AnkiStatus {
	return runner().status;
}

/** Run one sync now (single-flight: a call during a run joins it). */
export function syncAnki(request: AnkiRequest = ankiConnect): Promise<AnkiStatus> {
	const r = runner();
	r.running ??= (async () => {
		const signature = syncSignature();
		r.status = { ...r.status, state: "syncing" };
		try {
			const { counts, webSync } = await pushNotes(desiredNotes(graphView(), moduleTitleLookup()), request);
			r.syncedSignature = signature;
			r.status = { state: "ok", lastSyncAt: new Date().toISOString(), counts, message: webSync };
		} catch (err) {
			const unreachable = err instanceof AnkiUnreachableError;
			r.status = {
				...r.status,
				state: unreachable ? "unreachable" : "error",
				message: err instanceof Error ? err.message : String(err),
			};
		} finally {
			r.running = null;
		}
		return r.status;
	})();
	return r.running;
}

/** Debounced background trigger: skips while an extraction is mid-flight
 *  (its settle fires activity-changed again) and when nothing changed
 *  since the last successful run. */
export function scheduleAnkiSync(): void {
	const r = runner();
	if (r.timer) clearTimeout(r.timer);
	r.timer = setTimeout(() => {
		r.timer = null;
		if (extractionStatuses().length > 0) return;
		if (r.status.state === "ok" && r.syncedSignature === syncSignature()) return;
		void syncAnki();
	}, DEBOUNCE_MS);
	r.timer.unref?.();
}

/** Idempotent boot: listen for graph-changing events, sync once. Runs on
 *  first import of the server barrel; never under the test runner. */
export function startAnkiSync(): void {
	const r = runner();
	if (r.subscribed || process.env.NODE_ENV === "test" || process.env.NEXT_PHASE === "phase-production-build") return;
	r.subscribed = true;
	subscribe((event) => {
		if (event.type === "activity-changed" || event.type === "chats-changed") scheduleAnkiSync();
	});
	scheduleAnkiSync();
}

startAnkiSync();
