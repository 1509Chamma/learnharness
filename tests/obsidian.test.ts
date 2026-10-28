/**
 * The Obsidian export (fork feature): the vault it builds (concept notes
 * with chain links, session notes with recap + transcript, module notes,
 * the index; vault-qualified links; unique names) and the write rules —
 * only marked notes are ever overwritten or deleted, unchanged notes are
 * not rewritten, the learner's own notes are never touched.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "lh-obsidian-"));
process.env.LH_DATA_DIR = path.join(ROOT, "data");

const { buildVault, findVaultRoot, safeName, writeVault } = await import("../src/server/obsidian.ts");
type GraphNode = import("../src/core/contracts.ts").GraphNode;
type ChatSummary = import("../src/core/contracts.ts").ChatSummary;

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const node = (id: string, name: string, statement: string, chatId = "chat_1"): GraphNode =>
	({ id, name, statement, aliases: [], createdAt: "", provenance: [{ chatId, messageId: "m" }] }) as unknown as GraphNode;
const session = (id: string, title: string, moduleId?: string, recap?: string): ChatSummary =>
	({
		id,
		title,
		kind: "teach",
		moduleId,
		createdAt: "2026-10-28T10:00:00Z",
		updatedAt: "2026-10-28T11:00:00Z",
		...(recap ? { recap: { text: recap, forUpdatedAt: "x" } } : {}),
	}) as unknown as ChatSummary;

const input = {
	nodes: [
		node("n_row", "Row picture", "Each equation is a line; the solution is where they meet."),
		node("n_col", "Column picture", "Ax=b asks which combination of A's columns gives b."),
		node("n_eq", "Row/column equivalence", "Both pictures describe the same solutions."),
		node("n_dup", "Row picture", "A duplicate name from elsewhere.", "src_notes"),
	],
	chains: [{ id: "arg_1", premises: ["n_row", "n_col"], conclusion: "n_eq", provenance: [], createdAt: "" }] as never,
	sessions: [session("chat_1", "Lectures 1-3: revision", "mod_la", "Covered: both pictures."), session("chat_2", "Stray question")],
	modules: [{ id: "mod_la", title: "Linear Algebra", goal: "MIT 18.06", plan: "- [x] L1", createdAt: "", updatedAt: "" }],
	fileSources: { src_notes: "C:/notes/la.md" },
	transcriptOf: (id: string) => `## You\n\nTranscript of ${id}`,
};

describe("buildVault", () => {
	const files = buildVault(input, "LearnHarness/");

	it("writes concepts, sessions by module, modules and the index", () => {
		assert.deepEqual([...files.keys()].sort(), [
			"Concepts/Column picture.md",
			"Concepts/Row picture (n_dup).md",
			"Concepts/Row picture (n_row).md",
			"Concepts/Row column equivalence.md",
			"LearnHarness.md",
			"Modules/Linear Algebra.md",
			"Sessions/Linear Algebra/Lectures 1-3 revision.md",
			"Sessions/Unfiled/Stray question.md",
		].sort());
	});

	it("links a concept to what it follows from, with vault-qualified links", () => {
		const eq = files.get("Concepts/Row column equivalence.md")!;
		assert.ok(eq.startsWith("---\nlh_generated: true\n"));
		assert.match(eq, /## Follows from\n\n- \[\[LearnHarness\/Concepts\/Row picture \(n_row\)\|Row picture\]\] \+ \[\[LearnHarness\/Concepts\/Column picture\|Column picture\]\]/);
		assert.match(eq, /tags: \["learnharness", "learnharness\/linear-algebra"\]/);
		const col = files.get("Concepts/Column picture.md")!;
		assert.match(col, /## Leads to\n\n- \[\[LearnHarness\/Concepts\/Row column equivalence\|Row\/column equivalence\]\] \(together with/);
		assert.match(col, /## Learned in\n\n- \[\[LearnHarness\/Sessions\/Linear Algebra\/Lectures 1-3 revision\|Lectures 1-3: revision\]\]/);
		assert.match(files.get("Concepts/Row picture (n_dup).md")!, /Imported notes: C:\/notes\/la\.md/);
	});

	it("puts the recap, concepts and full transcript in the session note", () => {
		const s = files.get("Sessions/Linear Algebra/Lectures 1-3 revision.md")!;
		assert.ok(s.indexOf("## Recap") < s.indexOf("## Concepts"));
		assert.ok(s.indexOf("## Concepts") < s.indexOf("## Transcript"));
		assert.match(s, /Transcript of chat_1/);
		assert.match(s, /module \[\[LearnHarness\/Modules\/Linear Algebra\|Linear Algebra\]\]/);
	});

	it("gives the module its goal, plan and sessions", () => {
		const m = files.get("Modules/Linear Algebra.md")!;
		assert.match(m, /## Goal\n\nMIT 18\.06/);
		assert.match(m, /## Plan\n\n- \[x\] L1/);
		assert.match(m, /- \[\[LearnHarness\/Sessions\/Linear Algebra\/Lectures 1-3 revision\|Lectures 1-3: revision\]\]/);
	});
});

describe("safeName and the vault root", () => {
	it("strips characters Windows or wiki-links reject", () => {
		assert.equal(safeName('A/B: "C"? [D] #e|f.'), "A B C D e f");
		assert.equal(safeName("   "), "Untitled");
	});

	it("finds the nearest folder holding .obsidian", () => {
		const vault = path.join(ROOT, "vault");
		fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
		assert.equal(findVaultRoot(path.join(vault, "LearnHarness")), vault);
		assert.equal(findVaultRoot(path.join(os.tmpdir(), "no-vault-here-xyz")), null);
	});
});

describe("writeVault", () => {
	it("writes changed notes only, never touches the learner's own notes, and deletes stale generated ones", () => {
		const folder = path.join(ROOT, "export");
		fs.mkdirSync(path.join(folder, "Concepts"), { recursive: true });
		fs.writeFileSync(path.join(folder, "Concepts", "Column picture.md"), "# My own note\n"); // same name, unmarked
		fs.writeFileSync(path.join(folder, "Mine.md"), "# Untouched\n");
		fs.writeFileSync(path.join(folder, "Concepts", "Gone.md"), "---\nlh_generated: true\n---\nold");

		const files = buildVault(input, "");
		const first = writeVault(folder, files);
		assert.deepEqual(first.skipped, ["Concepts/Column picture.md"]);
		assert.equal(fs.readFileSync(path.join(folder, "Concepts", "Column picture.md"), "utf-8"), "# My own note\n");
		assert.ok(fs.existsSync(path.join(folder, "Mine.md")));
		assert.ok(!fs.existsSync(path.join(folder, "Concepts", "Gone.md")), "a stale generated note is removed");
		assert.equal(first.deleted, 1);
		assert.equal(first.written, files.size - 1);

		const second = writeVault(folder, files);
		assert.equal(second.written, 0, "nothing changed, nothing rewritten");
		assert.equal(second.deleted, 0);
	});
});
