/**
 * Modules (fork feature), phase 2: the module orchestrator — its prompt
 * group, its tools, the orchestrator chat's lifecycle (created once, never
 * a session, renamed with its module, deleted with it), and the briefed
 * sessions it creates (filed, opening with the module-context marker that
 * the view projects as a card). Runs under an isolated LH_DATA_DIR.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-orchestrator-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const modules = await import("../src/server/modules.ts");
const { orchestratorTools, formatModuleState } = await import("../src/agent/tools/orchestrator.ts");
const { composeInstructions } = await import("../src/agent/teacher-agent.ts");
const { listSourceSegments } = await import("../src/agent/prompt-segments.ts");
const { newModuleContextMessage, nativeInputCause } = await import("../src/core/native-messages.ts");
const { projectView } = await import("../src/core/view.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

type Tool = { execute: (id: string, input: unknown) => Promise<{ content: Array<{ text: string }>; details: unknown }> };
const run = async (tool: unknown, input: unknown) => (tool as Tool).execute("call_1", input);

describe("the orchestrator's prompt", () => {
	it("composes its own base plus the voice, accuracy, files and formatting fragments — never the teaching base", () => {
		const paths = listSourceSegments("orchestrator").map((s) => s.path);
		assert.deepEqual(paths, [
			"orchestrator/00-base.md",
			"shared/10-voice.md",
			"shared/15-accuracy.md",
			"shared/30-learner-files.md",
			"shared/40-formatting.md",
		]);
		const text = composeInstructions("orchestrator");
		assert.match(text, /# The module orchestrator/);
		assert.match(text, /create_session/);
	});
});

describe("orchestrator tools", () => {
	const calls: unknown[] = [];
	const tools = orchestratorTools({
		chatId: "chat_x",
		moduleState: () => ({
			title: "Linear Algebra",
			goal: "MIT 18.06",
			plan: "- [x] Lecture 1",
			sessions: [
				{ id: "b", title: "Lectures 2-3", kind: "teach", createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z" },
				{ id: "a", title: "Lecture 1", kind: "teach", createdAt: "2026-10-26T00:00:00Z", updatedAt: "2026-10-26T00:00:00Z", recap: "Row and column pictures; shaky on the column picture." },
			],
		}),
		createSession: (input) => {
			calls.push(input);
			return { chatId: "chat_new", title: input.title, kind: input.kind };
		},
		updatePlan: (plan) => calls.push({ plan }),
	});

	it("registers the module tools and the read-only file set, never teaching tools", () => {
		assert.deepEqual(Object.keys(tools).sort(), ["create_session", "find", "grep", "ls", "module_state", "read", "update_module_plan"]);
	});

	it("module_state lists sessions oldest first with their recaps", async () => {
		const text = (await run(tools.module_state, {})).content[0]!.text;
		assert.ok(text.indexOf("Lecture 1 [teach") < text.indexOf("Lectures 2-3 [teach"));
		assert.match(text, /Recap: Row and column pictures/);
		assert.match(text, /Recap: \(not written yet\)/);
		assert.match(text, /Goal: MIT 18.06/);
	});

	it("create_session passes the trimmed request through and returns the new session", async () => {
		const result = await run(tools.create_session, { title: " 18.06 · Lectures 1–3 ", kind: "teach", brief: " Revision summary of lectures 1–3. " });
		assert.deepEqual(calls.at(-1), { title: "18.06 · Lectures 1–3", kind: "teach", brief: "Revision summary of lectures 1–3." });
		assert.deepEqual(result.details, { chatId: "chat_new", title: "18.06 · Lectures 1–3", kind: "teach" });
	});

	it("update_module_plan replaces the plan", async () => {
		await run(tools.update_module_plan, { plan: "- [x] Lecture 1\n- [ ] Lecture 2" });
		assert.deepEqual(calls.at(-1), { plan: "- [x] Lecture 1\n- [ ] Lecture 2" });
	});

	it("formatModuleState says so when nothing exists yet", () => {
		const text = formatModuleState({ title: "Real Analysis", goal: "", plan: "", sessions: [] });
		assert.match(text, /Goal: \(none set\)/);
		assert.match(text, /\(none yet\)/);
	});
});

describe("the orchestrator chat and briefed sessions", () => {
	it("creates the orchestrator chat once, filed in the module but never counted as a session", () => {
		const mod = modules.createModule("Linear Algebra", "MIT 18.06");
		const id = modules.ensureOrchestratorChat(mod.id);
		assert.equal(modules.ensureOrchestratorChat(mod.id), id, "idempotent");
		const chat = chatStore.getChat(id)!;
		assert.equal(chat.kind, "orchestrator");
		assert.equal(chat.moduleId, mod.id);
		assert.deepEqual(modules.moduleSessions(mod.id), []);
		assert.equal(modules.listModuleSummaries().find((m) => m.id === mod.id)?.sessionCount, 0);
		assert.equal(modules.isSession({ kind: "orchestrator" }), false);
	});

	it("a briefed session is filed, carries the brief, goal, plan and earlier recaps, and projects as a card", () => {
		const mod = modules.createModule("Multivariable Calculus", "MIT 18.02");
		modules.updateModule(mod.id, { plan: "- [x] Vectors" });
		const earlier = chatStore.createChat("Vectors and dot products");
		modules.fileSession(earlier.id, mod.id);
		const record = chatStore.getChat(earlier.id)!;
		fs.writeFileSync(
			path.join(TMP_DATA, "chats", `${earlier.id}.json`),
			JSON.stringify({ ...record, recap: { text: "Dot product as projection; solid.", forUpdatedAt: record.updatedAt } }),
		);

		const created = modules.createModuleSession(mod.id, { title: "Lectures 2-3", kind: "practice", brief: "Problems on cross products." });
		const chat = chatStore.getChat(created.chatId)!;
		assert.equal(chat.moduleId, mod.id);
		assert.equal(chat.kind, "practice");
		assert.equal(chat.messages.length, 1);
		const marker = chat.messages[0] as { role: string; customType: string; content: string };
		assert.equal(marker.customType, "module-context");
		assert.match(marker.content, /^\[Session context\]/);
		assert.match(marker.content, /Problems on cross products\./);
		assert.match(marker.content, /Module goal:\nMIT 18\.02/);
		assert.match(marker.content, /- \[x\] Vectors/);
		assert.match(marker.content, /Vectors and dot products: Dot product as projection; solid\./);

		const view = projectView(chat.messages);
		assert.equal(view[0]?.parts[0]?.type, "data-module-context");
		assert.equal(nativeInputCause(chat.messages[0] as never, chat.messages as never), "neutral");
		assert.ok(modules.moduleSessions(mod.id).some((s) => s.id === created.chatId));
	});

	it("renaming a module renames its orchestrator chat; deleting it removes the chat and unfiles sessions", () => {
		const mod = modules.createModule("Probability");
		const orchestratorId = modules.ensureOrchestratorChat(mod.id);
		modules.updateModule(mod.id, { title: "Probability Theory" });
		assert.equal(chatStore.getChat(orchestratorId)?.title, "Probability Theory");

		const created = modules.createModuleSession(mod.id, { title: "Bayes", kind: "teach", brief: "Bayes' rule." });
		modules.deleteModule(mod.id);
		assert.equal(chatStore.getChat(orchestratorId), null, "the orchestrator chat goes with its module");
		assert.equal(chatStore.getChat(created.chatId)?.moduleId, undefined, "sessions survive, unfiled");
	});

	it("the module-context marker without goal, plan or recaps is just the brief", () => {
		const m = newModuleContextMessage({ moduleId: "mod_1", moduleTitle: "Real Analysis", goal: "", plan: "", brief: "Start with Abbott ch. 1." });
		assert.equal(m.content.split("\n").length, 3);
		assert.deepEqual(m.details, { moduleId: "mod_1", moduleTitle: "Real Analysis", brief: "Start with Abbott ch. 1." });
	});
});
