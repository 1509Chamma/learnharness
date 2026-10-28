/**
 * THE ORCHESTRATOR TOOLS (modules, fork feature): what a module's
 * orchestrating agent can do — read the module's state, create sessions
 * filed into the module with a brief, and rewrite the module plan — plus
 * the read-only learner-file set and the research/pdf jobs.
 *
 * The agent layer may not touch the stores, so every module operation is a
 * callback the server composition root (chat-handler) injects.
 * Mechanics-only descriptions; the craft lives in prompts/orchestrator.
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { readTool } from "./read.ts";
import { lsTool } from "./ls.ts";
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";
import { jobTools, type JobToolContext } from "./jobs.ts";
import { healToolRecord } from "./heal.ts";

export interface ModuleSessionInfo {
	id: string;
	title: string;
	kind: "teach" | "practice";
	createdAt: string;
	updatedAt: string;
	/** What the session covered and where the learner struggled (phase 3). */
	recap?: string;
}

export interface ModuleStateView {
	title: string;
	goal: string;
	plan: string;
	sessions: ModuleSessionInfo[];
}

export interface CreatedSession {
	chatId: string;
	title: string;
	kind: "teach" | "practice";
}

export interface OrchestratorToolContext {
	chatId: string;
	/** May refresh stale recaps first, so it can be async. */
	moduleState: () => ModuleStateView | null | Promise<ModuleStateView | null>;
	createSession: (input: { title: string; kind: "teach" | "practice"; brief: string }) => CreatedSession;
	updatePlan: (plan: string) => void;
	/** The research + pdf jobs (absent in tests). */
	jobs?: JobToolContext;
}

export const MAX_PLAN_CHARS = 40_000;

/** module_state's text for the model: header facts, the plan, then one
 *  block per session (oldest first, so the sequence reads in order). */
export function formatModuleState(state: ModuleStateView): string {
	const lines = [`Module: ${state.title}`, `Goal: ${state.goal.trim() || "(none set)"}`, "", "Plan:", state.plan.trim() || "(empty)", ""];
	const sessions = [...state.sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	lines.push(`Sessions (${sessions.length}, oldest first):`);
	if (sessions.length === 0) lines.push("(none yet)");
	for (const s of sessions) {
		lines.push(`- ${s.title} [${s.kind}; started ${s.createdAt.slice(0, 10)}, last active ${s.updatedAt.slice(0, 10)}]`);
		lines.push(`  Recap: ${s.recap?.trim() || "(not written yet)"}`);
	}
	return lines.join("\n");
}

const emptyInput = Type.Object({});

const createSessionInput = Type.Object({
	title: Type.String({ description: "The session's title as the learner will see it in the sidebar" }),
	kind: Type.Union([Type.Literal("teach"), Type.Literal("practice")], {
		description: "teach: a tutoring session (learning or revision). practice: a problem-practice session.",
	}),
	brief: Type.String({
		description: "Instructions for the session's tutor: source and exact scope, mode, relevant history, exclusions. The tutor sees this plus the module's goal and plan.",
	}),
});

const updatePlanInput = Type.Object({
	plan: Type.String({ description: `The complete new module plan in markdown (replaces the old one; max ${MAX_PLAN_CHARS} characters)` }),
});

export function orchestratorTools(ctx: OrchestratorToolContext): Record<string, AgentTool<any>> {
	const moduleStateTool: AgentTool<typeof emptyInput> = {
		name: "module_state",
		label: "module_state",
		description: "Read the module: its title, goal, current plan, and every session in it with dates and recaps.",
		parameters: emptyInput,
		execute: serverExecute("module_state", emptyInput, async () => {
			const state = await ctx.moduleState();
			if (!state) throw new Error("This module no longer exists");
			return formatModuleState(state);
		}),
	};

	const createSessionTool: AgentTool<typeof createSessionInput> = {
		name: "create_session",
		label: "create_session",
		description:
			"Create a new session filed in this module. The session starts with your brief plus the module's goal and plan as its context; " +
			"the learner gets a card with a button to open it. Returns the new session's id and title.",
		parameters: createSessionInput,
		execute: serverExecute("create_session", createSessionInput, (input) => {
			const title = input.title.trim();
			const brief = input.brief.trim();
			if (!title) throw new Error("title must not be empty");
			if (!brief) throw new Error("brief must not be empty");
			return ctx.createSession({ title, kind: input.kind, brief });
		}),
	};

	const updatePlanTool: AgentTool<typeof updatePlanInput> = {
		name: "update_module_plan",
		label: "update_module_plan",
		description: "Replace the module plan with the given markdown. The learner sees it beside this chat.",
		parameters: updatePlanInput,
		execute: serverExecute("update_module_plan", updatePlanInput, (input) => {
			if (input.plan.length > MAX_PLAN_CHARS) throw new Error(`plan is longer than ${MAX_PLAN_CHARS} characters`);
			ctx.updatePlan(input.plan);
			return "Plan updated.";
		}),
	};

	// Research + pdf only (the practice agent's set): demos and visuals are
	// teaching artifacts — the orchestrator never teaches.
	const jobs = ctx.jobs ? jobTools(ctx.jobs) : null;
	return healToolRecord({
		module_state: moduleStateTool,
		create_session: createSessionTool,
		update_module_plan: updatePlanTool,
		read: readTool,
		ls: lsTool,
		find: findTool,
		grep: grepTool,
		...(jobs?.research ? { research: jobs.research } : {}),
		...(jobs?.pdf ? { pdf: jobs.pdf } : {}),
	});
}
