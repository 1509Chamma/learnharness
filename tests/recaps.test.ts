/**
 * Modules (fork feature), phase 3: session recaps — which sessions get one,
 * when a recap is stale, that writing one never bumps the session's activity
 * time, and that a module refresh rewrites only the stale ones. The model
 * call is a fake writer; a cheap slot is configured in the isolated
 * LH_DATA_DIR so the real gate passes.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-recaps-"));
process.env.LH_DATA_DIR = TMP_DATA;
fs.writeFileSync(
	path.join(TMP_DATA, "settings.json"),
	JSON.stringify({ version: 1, models: { cheap: { model: { provider: "anthropic", id: "claude-haiku-5-5" } } } }),
);

const { chatStore } = await import("../src/store/chats.ts");
const modules = await import("../src/server/modules.ts");
const { recapEligible, recapPrompt, recapStale, refreshModuleRecaps, writeRecap } = await import("../src/server/recaps.ts");
const { newUserMessage } = await import("../src/core/native-messages.ts");
type LhMessage = import("../src/core/native-messages.ts").LhMessage;

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const assistant = (text: string) =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku-5-5",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
		id: `a_${Math.random().toString(36).slice(2)}`,
	}) as unknown as LhMessage;

function sessionIn(moduleId: string, title: string) {
	const chat = chatStore.createChat(title);
	modules.fileSession(chat.id, moduleId);
	chatStore.saveMessages(chat.id, [newUserMessage(`Teach me ${title}`), assistant(`Here is ${title}.`)]);
	return chat.id;
}

const calls: string[] = [];
const writer = async (prompt: string) => {
	calls.push(prompt);
	return { text: `Covered: ${calls.length}\nStruggled with: nothing notable\nNext: more` };
};

describe("recap eligibility", () => {
	it("needs a module, a real session and at least one exchange", () => {
		const exchange = [{ role: "user" }, { role: "assistant" }] as never[];
		assert.equal(recapEligible({ moduleId: "m", kind: "teach", messages: exchange }), true);
		assert.equal(recapEligible({ moduleId: undefined, kind: "teach", messages: exchange }), false);
		assert.equal(recapEligible({ moduleId: "m", kind: "orchestrator", messages: exchange }), false);
		assert.equal(recapEligible({ moduleId: "m", kind: "teach", messages: [{ role: "user" }] as never[] }), false);
	});

	it("is stale until written for the session's current updatedAt", () => {
		const base = { moduleId: "m", kind: "teach" as const, messages: [{ role: "user" }, { role: "assistant" }] as never[], updatedAt: "t2" };
		assert.equal(recapStale(base), true);
		assert.equal(recapStale({ ...base, recap: { text: "x", forUpdatedAt: "t1" } }), true);
		assert.equal(recapStale({ ...base, recap: { text: "x", forUpdatedAt: "t2" } }), false);
	});

	it("the prompt asks for the three lines and carries the transcript", () => {
		const p = recapPrompt("## You\nhello");
		assert.match(p, /Covered:/);
		assert.match(p, /Struggled with:/);
		assert.match(p, /Next:/);
		assert.ok(p.endsWith("## You\nhello"));
	});
});

describe("writing recaps", () => {
	it("writes one for a stale session without bumping its activity time, then skips it while fresh", async () => {
		const mod = modules.createModule("Linear Algebra");
		const id = sessionIn(mod.id, "Lecture 1");
		const before = chatStore.getChat(id)!.updatedAt;
		assert.equal(await writeRecap(id, writer), true);
		const chat = chatStore.getChat(id)!;
		assert.match(chat.recap!.text, /^Covered:/);
		assert.equal(chat.recap!.forUpdatedAt, before);
		assert.equal(chat.updatedAt, before, "a recap is not conversation activity");
		assert.match(calls.at(-1)!, /Here is Lecture 1\./, "the writer saw the transcript");
		assert.equal(await writeRecap(id, writer), false, "fresh: nothing to do");
		assert.equal(chatStore.listChats().find((c) => c.id === id)?.recap?.text, chat.recap!.text, "the list summary carries it");
	});

	it("a module refresh rewrites only the stale sessions", async () => {
		const mod = modules.createModule("Real Analysis");
		const fresh = sessionIn(mod.id, "Sequences");
		await writeRecap(fresh, writer);
		const stale = sessionIn(mod.id, "Series");
		const unfiled = chatStore.createChat("Elsewhere");
		chatStore.saveMessages(unfiled.id, [newUserMessage("hi"), assistant("hello")]);
		const n = calls.length;
		await refreshModuleRecaps(mod.id, writer);
		assert.equal(calls.length, n + 1, "exactly one recap written");
		assert.ok(chatStore.getChat(stale)!.recap);
		assert.equal(chatStore.getChat(unfiled.id)!.recap, undefined);
	});

	it("an empty model reply writes nothing", async () => {
		const mod = modules.createModule("Probability");
		const id = sessionIn(mod.id, "Bayes");
		assert.equal(await writeRecap(id, async () => ({ text: "   " })), false);
		assert.equal(chatStore.getChat(id)!.recap, undefined);
	});
});
