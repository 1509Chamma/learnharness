/**
 * Modules (fork feature), phase 1: the module store, filing sessions into
 * modules (and the unfiling a module deletion does), the sidebar's grouping
 * helper, and the learner profile setting that rides into every agent's
 * system prompt. Runs under an isolated LH_DATA_DIR.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-modules-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { createModule, deleteModule, fileSession, getModule, listModuleSummaries, updateModule } = await import(
	"../src/server/modules.ts"
);
const { sidebarRows } = await import("../components/sidebar-modules.tsx");
const { parseAgentSettingsBody } = await import("../src/server/settings-body.ts");
const { sanitizeUserSettings, LEARNER_PROFILE_MAX } = await import("../src/core/settings.ts");
const { resolveSettings } = await import("../src/core/settings-resolution.ts");
const { withLearnerProfile } = await import("../src/agent/teacher-agent.ts");
type ChatListItem = import("../src/core/contracts.ts").ChatListItem;

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

describe("module store", () => {
	it("creates, lists alphabetically, updates and counts sessions", () => {
		const real = createModule("Real Analysis");
		const linear = createModule("  Linear Algebra ", "MIT 18.06, then LADR");
		assert.equal(linear.title, "Linear Algebra");
		assert.equal(linear.goal, "MIT 18.06, then LADR");
		assert.match(linear.id, /^mod_/);

		const a = chatStore.createChat("Lectures 1-3");
		fileSession(a.id, linear.id);
		const listed = listModuleSummaries();
		assert.deepEqual(listed.map((m) => [m.title, m.sessionCount]), [["Linear Algebra", 1], ["Real Analysis", 0]]);

		const updated = updateModule(linear.id, { plan: "- [x] Lecture 1", title: "" });
		assert.equal(updated.plan, "- [x] Lecture 1");
		assert.equal(updated.title, "Linear Algebra", "an empty title keeps the old one");
		assert.equal(getModule(real.id)?.title, "Real Analysis");
	});

	it("files and unfiles a session without touching its activity time", () => {
		const mod = createModule("Multivariable Calculus");
		const chat = chatStore.createChat("Partial derivatives");
		const before = chatStore.getChat(chat.id)!.updatedAt;
		fileSession(chat.id, mod.id);
		assert.equal(chatStore.getChat(chat.id)?.moduleId, mod.id);
		assert.equal(chatStore.listChats().find((c) => c.id === chat.id)?.moduleId, mod.id, "the list summary carries it");
		assert.equal(chatStore.getChat(chat.id)?.updatedAt, before);
		fileSession(chat.id, null);
		assert.equal(chatStore.getChat(chat.id)?.moduleId, undefined);
	});

	it("refuses an unknown module", () => {
		const chat = chatStore.createChat("Stray");
		assert.throws(() => fileSession(chat.id, "mod_nope"), /Module not found/);
	});

	it("deleting a module unfiles its sessions and keeps them", () => {
		const mod = createModule("Probability");
		const chat = chatStore.createChat("Bayes");
		fileSession(chat.id, mod.id);
		assert.equal(deleteModule(mod.id), true);
		assert.equal(getModule(mod.id), null);
		const kept = chatStore.getChat(chat.id);
		assert.ok(kept, "the session survives");
		assert.equal(kept.moduleId, undefined);
		assert.equal(deleteModule(mod.id), false);
	});
});

describe("sidebarRows", () => {
	const row = (id: string, moduleId?: string) => ({ id, title: id, moduleId }) as unknown as ChatListItem;
	const mod = (id: string) => ({ id, title: id, goal: "", plan: "", createdAt: "", updatedAt: "", sessionCount: 0 });

	it("orders expanded modules' sessions first, then unfiled; collapsed modules hide theirs", () => {
		const chats = [row("a", "m1"), row("b"), row("c", "m2"), row("d", "m1")];
		const out = sidebarRows(chats, [mod("m1"), mod("m2")], new Set(["m1"]));
		assert.deepEqual(out.groups.map((g) => [g.module.id, g.sessions.map((s) => s.id)]), [["m1", ["a", "d"]], ["m2", ["c"]]]);
		assert.deepEqual(out.unfiled.map((s) => s.id), ["b"]);
		assert.deepEqual(out.rows.map((s) => s.id), ["a", "d", "b"]);
	});

	it("treats a session filed in a vanished module as unfiled", () => {
		const out = sidebarRows([row("a", "gone")], [], new Set());
		assert.deepEqual(out.unfiled.map((s) => s.id), ["a"]);
	});
});

describe("learner profile", () => {
	it("the write side accepts a string within the cap and rejects the rest", () => {
		const ok = parseAgentSettingsBody({ learnerProfile: "Aiming at ML + maths, with finance." });
		assert.ok(ok.ok && ok.settings.learnerProfile === "Aiming at ML + maths, with finance.");
		assert.equal(parseAgentSettingsBody({ learnerProfile: 42 }).ok, false);
		assert.equal(parseAgentSettingsBody({ learnerProfile: "x".repeat(LEARNER_PROFILE_MAX + 1) }).ok, false);
		const blank = parseAgentSettingsBody({ learnerProfile: "   " });
		assert.ok(blank.ok && blank.settings.learnerProfile === undefined, "blank clears it");
	});

	it("survives the read side and resolves to a string", () => {
		const record = sanitizeUserSettings({ version: 1, agent: { learnerProfile: "Geometric learner" } })!;
		assert.equal(record.agent?.learnerProfile, "Geometric learner");
		assert.equal(resolveSettings(record).agent.learnerProfile, "Geometric learner");
		assert.equal(resolveSettings(null).agent.learnerProfile, "");
	});

	it("appends as the system prompt's closing section, only when set", () => {
		assert.equal(withLearnerProfile("BASE", ""), "BASE");
		assert.equal(withLearnerProfile("BASE", undefined), "BASE");
		const out = withLearnerProfile("BASE", " Geometric learner ");
		assert.ok(out.startsWith("BASE\n\n---\n\n## The learner, in their own words\n\n"));
		assert.ok(out.endsWith("Geometric learner"));
	});
});
