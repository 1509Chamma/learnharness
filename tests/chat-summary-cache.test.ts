/**
 * listChats' summary memo: every list read used to re-parse every full
 * transcript, so the store now memoizes each chat's summary by file mtime +
 * size. These pins hold the invariant that the memo is invisible — store
 * writes, out-of-band file edits and deletes all show up on the next list —
 * plus the practice "Problem waiting" meta the projection now sets. Runs
 * under an isolated LH_DATA_DIR (set before any config-loading import).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-summary-cache-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { newUserMessage, PRACTICE_PROBLEM_TOOL } = await import("../src/core/native-messages.ts");
type LhMessage = import("../src/core/native-messages.ts").LhMessage;

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const listed = (id: string) => chatStore.listChats().find((c) => c.id === id);

function problemPose(callId: string): LhMessage[] {
	const assistant: LhMessage & AssistantMessage = {
		id: `msg_a_${callId}`,
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: PRACTICE_PROBLEM_TOOL, arguments: { statement: "Show that…", mode: "recall", modelSolution: "…" } }],
		timestamp: 1,
		api: "faux",
		provider: "test",
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
	};
	const ack: LhMessage & ToolResultMessage = {
		id: `msg_r_${callId}`,
		role: "toolResult",
		toolCallId: callId,
		toolName: PRACTICE_PROBLEM_TOOL,
		content: [{ type: "text", text: "Problem posed — the turn ends here." }],
		details: null,
		isError: false,
		timestamp: 2,
	};
	return [assistant, ack];
}

describe("listChats summary memo", () => {
	it("store writes are visible on the next list", () => {
		const chat = chatStore.createChat("first title");
		assert.equal(listed(chat.id)?.messageCount, 0);
		chatStore.saveMessages(chat.id, [newUserMessage("hello")]);
		assert.equal(listed(chat.id)?.messageCount, 1);
		chatStore.renameChat(chat.id, "second title");
		assert.equal(listed(chat.id)?.title, "second title");
	});

	it("an out-of-band edit to the file is visible on the next list", () => {
		const chat = chatStore.createChat("external");
		assert.equal(listed(chat.id)?.title, "external");
		const file = path.join(TMP_DATA, "chats", `${chat.id}.json`);
		const record = JSON.parse(fs.readFileSync(file, "utf-8"));
		fs.writeFileSync(file, JSON.stringify({ ...record, title: "edited outside the app" }, null, "\t"));
		assert.equal(listed(chat.id)?.title, "edited outside the app");
	});

	it("a deleted chat leaves the list", () => {
		const chat = chatStore.createChat("doomed");
		assert.ok(listed(chat.id));
		chatStore.deleteChat(chat.id);
		assert.equal(listed(chat.id), undefined);
	});

	it("returned summaries are copies — mutating one never leaks into the next list", () => {
		const chat = chatStore.createChat("immutable");
		listed(chat.id)!.title = "mutated by a caller";
		assert.equal(listed(chat.id)?.title, "immutable");
	});
});

describe("pendingProblem (the sidebar's Problem waiting meta)", () => {
	it("a practice session with a posed, unconcluded problem lists pendingProblem", () => {
		const chat = chatStore.createChat("practice", "practice");
		assert.equal(listed(chat.id)?.pendingProblem, false);
		chatStore.saveMessages(chat.id, problemPose("call_p1"));
		assert.equal(listed(chat.id)?.pendingProblem, true);
	});

	it("teaching sessions never list pendingProblem", () => {
		const chat = chatStore.createChat("teach");
		chatStore.saveMessages(chat.id, problemPose("call_p2"));
		assert.equal(listed(chat.id)?.pendingProblem, false);
	});
});
