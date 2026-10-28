/**
 * Anki sync (fork feature): the graph → notes projection (pure) and the
 * diff-and-push pass against an in-memory AnkiConnect. The pins: math
 * reaches MathJax delimiters, every note is keyed by its graph id, reruns
 * are idempotent, text changes update in place, removals suspend (never
 * delete), and learner suspensions are never undone.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GraphNode, GraphSnapshot } from "../src/core/contracts.ts";
import {
	DELETED_TAG,
	DERIVATION_MODEL,
	RECALL_MODEL,
	desiredNotes,
	sessionTag,
	toAnkiHtml,
} from "../src/core/anki-cards.ts";
import { AnkiUnreachableError, pushNotes, type AnkiRequest } from "../src/server/anki.ts";

const node = (id: string, name: string, statement: string, chatId = "c1"): GraphNode => ({
	id,
	name,
	statement,
	aliases: [],
	createdAt: "2026-10-28T00:00:00.000Z",
	provenance: [{ chatId, messageId: "m1" }] as GraphNode["provenance"],
});

type Snap = Pick<GraphSnapshot, "propositions" | "chains" | "sessions" | "fileSources">;
const snapshot = (over: Partial<Snap> = {}): Snap => ({
	propositions: [
		node("n_a", "Heap shape", "A heap of $n$ items has height $\\lfloor \\log_2 n \\rfloor$."),
		node("n_b", "Sift cost", "Sifting down from height $h$ costs $O(h)$."),
		node("n_c", "Linear build", "Building a heap takes $$\\sum_h \\frac{n}{2^{h+1}} O(h) = O(n)$$"),
	],
	chains: [{ id: "arg_1", premises: ["n_a", "n_b"], conclusion: "n_c", provenance: [], createdAt: "2026-10-28T00:00:00.000Z" } as unknown as GraphSnapshot["chains"][number]],
	sessions: { c1: "Heaps & priority queues" },
	fileSources: {},
	...over,
});

describe("toAnkiHtml", () => {
	it("maps inline and display math to MathJax delimiters", () => {
		assert.equal(toAnkiHtml("if $x<1$ then $$y=2$$"), "if \\(x&lt;1\\) then \\[y=2\\]");
		assert.equal(toAnkiHtml("keep \\(a\\) and \\[b\\]"), "keep \\(a\\) and \\[b\\]");
	});
	it("escapes HTML and applies light markdown outside math", () => {
		assert.equal(toAnkiHtml("**bold** `a<b` & *it*\nnext"), "<b>bold</b> <code>a&lt;b</code> &amp; <i>it</i><br>next");
	});
});

describe("desiredNotes", () => {
	it("one recall note per proposition, one derivation per complete chain, tagged by birth session", () => {
		const notes = desiredNotes(snapshot());
		assert.deepEqual(notes.map((n) => [n.model, n.key]), [
			[RECALL_MODEL, "n_a"],
			[RECALL_MODEL, "n_b"],
			[RECALL_MODEL, "n_c"],
			[DERIVATION_MODEL, "arg_1"],
		]);
		assert.deepEqual(notes[0]!.tags, ["LearnHarness", sessionTag("Heaps & priority queues")]);
		assert.equal(sessionTag("Heaps & priority queues"), "LearnHarness::Heaps_&_priority_queues");
		const derivation = notes[3]!.fields as Record<string, string>;
		assert.equal(derivation.ChainId, "arg_1");
		assert.match(derivation.Premises!, /<li>Sifting down/);
		assert.match(derivation.Conclusion!, /Linear build/);
	});
	it("skips a chain with a missing member", () => {
		const notes = desiredNotes(snapshot({ chains: [{ id: "arg_x", premises: ["n_gone"], conclusion: "n_c", provenance: [], createdAt: "2026-10-28T00:00:00.000Z" } as unknown as GraphSnapshot["chains"][number]] }));
		assert.ok(!notes.some((n) => n.key === "arg_x"));
	});
});

// ─── an in-memory AnkiConnect ────────────────────────────────────────────────

interface FakeNote { noteId: number; modelName: string; fields: Record<string, string>; tags: string[]; cards: number[] }

function fakeAnki() {
	const decks = new Set<string>(["Default"]);
	const models = new Map<string, string[]>();
	const notes = new Map<number, FakeNote>();
	const suspended = new Set<number>();
	const calls: string[] = [];
	let nextId = 1;
	const request: AnkiRequest = async (action, params = {}) => {
		calls.push(action);
		const p = params as Record<string, any>;
		switch (action) {
			case "deckNames": return [...decks];
			case "createDeck": decks.add(p.deck); return 1;
			case "modelNames": return [...models.keys()];
			case "createModel": models.set(p.modelName, p.inOrderFields); return {};
			case "findNotes": {
				const model = /"note:(.+)"/.exec(p.query)![1];
				return [...notes.values()].filter((n) => n.modelName === model).map((n) => n.noteId);
			}
			case "notesInfo":
				return (p.notes as number[]).map((id) => {
					const n = notes.get(id)!;
					return { ...n, fields: Object.fromEntries(Object.entries(n.fields).map(([k, v]) => [k, { value: v }])) };
				});
			case "addNotes":
				return (p.notes as any[]).map((n) => {
					const id = nextId++;
					notes.set(id, { noteId: id, modelName: n.modelName, fields: { ...n.fields }, tags: [...n.tags], cards: [id * 100] });
					return id;
				});
			case "updateNoteFields": Object.assign(notes.get(p.note.id)!.fields, p.note.fields); return null;
			case "addTags":
				for (const id of p.notes as number[]) notes.get(id)!.tags.push(...String(p.tags).split(" "));
				return null;
			case "suspend": for (const c of p.cards as number[]) suspended.add(c); return true;
			case "sync": return null;
			default: throw new Error(`unexpected action ${action}`);
		}
	};
	return { request, notes, suspended, calls, decks, models };
}

describe("pushNotes", () => {
	it("first run creates the deck, the note types and every note; a rerun changes nothing", async () => {
		const anki = fakeAnki();
		const first = await pushNotes(desiredNotes(snapshot()), anki.request);
		assert.ok(anki.decks.has("LearnHarness"));
		assert.deepEqual([...anki.models.keys()].sort(), [DERIVATION_MODEL, RECALL_MODEL].sort());
		assert.equal(first.counts.added, 4);
		assert.equal(anki.notes.size, 4);

		anki.calls.length = 0;
		const second = await pushNotes(desiredNotes(snapshot()), anki.request);
		assert.deepEqual(
			{ added: second.counts.added, updated: second.counts.updated, suspended: second.counts.suspended },
			{ added: 0, updated: 0, suspended: 0 },
		);
		assert.ok(!anki.calls.includes("addNotes") && !anki.calls.includes("updateNoteFields"));
		assert.equal(anki.calls.at(-1), "sync");
	});

	it("a changed statement updates the same note in place", async () => {
		const anki = fakeAnki();
		await pushNotes(desiredNotes(snapshot()), anki.request);
		const changed = snapshot();
		changed.propositions[1] = node("n_b", "Sift cost", "Sifting down from height $h$ costs at most $2h$ comparisons.");
		const run = await pushNotes(desiredNotes(changed), anki.request);
		assert.equal(run.counts.updated, 2); // the recall note + the derivation that quotes it
		assert.equal(anki.notes.size, 4);
		const recall = [...anki.notes.values()].find((n) => n.fields.NodeId === "n_b")!;
		assert.match(recall.fields.Statement!, /2h/);
	});

	it("a removed node suspends its card and tags it — once, never deleting", async () => {
		const anki = fakeAnki();
		await pushNotes(desiredNotes(snapshot()), anki.request);
		const fewer = snapshot();
		fewer.propositions = fewer.propositions.filter((n) => n.id !== "n_a");
		const run = await pushNotes(desiredNotes(fewer), anki.request);
		assert.equal(run.counts.suspended, 2); // n_a's recall + the chain that needed it
		assert.equal(anki.notes.size, 4);
		const gone = [...anki.notes.values()].find((n) => n.fields.NodeId === "n_a")!;
		assert.ok(gone.tags.includes(DELETED_TAG));
		assert.ok(anki.suspended.has(gone.cards[0]!));

		const again = await pushNotes(desiredNotes(fewer), anki.request);
		assert.equal(again.counts.suspended, 0);
	});

	it("never unsuspends a card the learner suspended", async () => {
		const anki = fakeAnki();
		await pushNotes(desiredNotes(snapshot()), anki.request);
		const card = [...anki.notes.values()][0]!.cards[0]!;
		anki.suspended.add(card);
		await pushNotes(desiredNotes(snapshot()), anki.request);
		assert.ok(anki.suspended.has(card));
		assert.ok(!anki.calls.includes("unsuspend"));
	});

	it("an AnkiWeb failure still reports the cards as pushed", async () => {
		const anki = fakeAnki();
		const request: AnkiRequest = (action, params) =>
			action === "sync" ? Promise.reject(new Error("not logged in")) : anki.request(action, params);
		const run = await pushNotes(desiredNotes(snapshot()), request);
		assert.equal(run.counts.added, 4);
		assert.match(run.webSync ?? "", /AnkiWeb/);
	});

	it("Anki closed surfaces as unreachable", async () => {
		const request: AnkiRequest = () => Promise.reject(new AnkiUnreachableError("closed"));
		await assert.rejects(pushNotes(desiredNotes(snapshot()), request), AnkiUnreachableError);
	});
});
