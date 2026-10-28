"use client";
/**
 * The module page (modules, fork feature): the module's goal, its plan and
 * its sessions, plus the doors to start a new session filed into it.
 * Goal and plan save on blur / Done. The page refetches on chats-changed
 * and turn-settled, so sessions moved in or out elsewhere show up live.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DumbbellIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { ChatSummary, ModuleRecord } from "@/src/core";
import { MessageResponse } from "@/components/ai-elements/message";
import { TopBar } from "@/components/top-bar";
import { useServerEvent } from "@/components/server-events";
import { timeAgo } from "@/components/sidebar";
import { Button } from "@/components/ui/button";

const PLAN_PLACEHOLDER = [
	"Resources, lecture checklist, progress — markdown.",
	"",
	"- [x] Lecture 1: The geometry of linear equations",
	"- [ ] Lecture 2: Elimination with matrices",
].join("\n");

export function ModulePage({
	initialModule,
	initialSessions,
}: {
	initialModule: ModuleRecord;
	initialSessions: ChatSummary[];
}) {
	const router = useRouter();
	const [mod, setMod] = useState(initialModule);
	const [sessions, setSessions] = useState(initialSessions);
	const [title, setTitle] = useState(initialModule.title);
	const [goal, setGoal] = useState(initialModule.goal);
	const [plan, setPlan] = useState(initialModule.plan);
	const [editingPlan, setEditingPlan] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);

	const refetch = useCallback(async () => {
		const res = await fetch(`/api/modules/${mod.id}`, { cache: "no-store" });
		if (res.status === 404) {
			router.push("/");
			return;
		}
		if (!res.ok) return;
		const d = (await res.json()) as { module: ModuleRecord; sessions: ChatSummary[] };
		setMod(d.module);
		setSessions(d.sessions);
	}, [mod.id, router]);
	useServerEvent("chats-changed", () => void refetch());
	useServerEvent("turn-settled", () => void refetch());
	// Server-side plan edits (the orchestrator) land through the refetch;
	// the local draft follows unless it is mid-edit.
	useEffect(() => {
		if (!editingPlan) setPlan(mod.plan);
	}, [mod.plan, editingPlan]);

	const save = async (patch: Partial<Pick<ModuleRecord, "title" | "goal" | "plan">>) => {
		const res = await fetch(`/api/modules/${mod.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(patch),
		});
		if (res.ok) setMod((await res.json()) as ModuleRecord);
	};

	const remove = async () => {
		const res = await fetch(`/api/modules/${mod.id}`, { method: "DELETE" });
		if (res.ok) router.push("/");
	};

	return (
		<div className="flex h-full min-w-0 flex-1 flex-col">
			<TopBar>
				<input
					value={title}
					aria-label="Module name"
					data-testid="module-title"
					onChange={(e) => setTitle(e.target.value)}
					onBlur={() => {
						const t = title.trim();
						if (!t) setTitle(mod.title);
						else if (t !== mod.title) void save({ title: t });
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") e.currentTarget.blur();
					}}
					className="min-w-0 flex-1 bg-transparent font-prose text-lg outline-none"
				/>
			</TopBar>
			<div className="flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-6">
					<section>
						<h2 className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">Goal</h2>
						<textarea
							value={goal}
							data-testid="module-goal"
							aria-label="Module goal"
							placeholder="What you're aiming for, e.g. MIT 18.06 lecture by lecture, then Linear Algebra Done Right"
							onChange={(e) => setGoal(e.target.value)}
							onBlur={() => {
								if (goal !== mod.goal) void save({ goal });
							}}
							className="h-20 w-full resize-y rounded-md border border-border bg-background p-3 font-prose text-(length:--lh-prose-size) outline-none"
						/>
					</section>

					<section>
						<div className="mb-2 flex items-center justify-between">
							<h2 className="text-xs uppercase tracking-widest text-muted-foreground">Sessions</h2>
							<div className="flex gap-2">
								<Button
									size="xs"
									variant="outline"
									className="cursor-pointer"
									data-testid="module-new-teach"
									onClick={() => router.push(`/chat/new?module=${mod.id}`)}
								>
									<PlusIcon className="size-3" /> Teaching
								</Button>
								<Button
									size="xs"
									variant="outline"
									className="cursor-pointer"
									data-testid="module-new-practice"
									onClick={() => router.push(`/chat/new?mode=practice&module=${mod.id}`)}
								>
									<DumbbellIcon className="size-3" /> Practice
								</Button>
							</div>
						</div>
						{sessions.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								No sessions yet. Start one here, or move an existing session in from the sidebar (right-click, Move to).
							</p>
						) : (
							<ul className="flex flex-col gap-1" data-testid="module-sessions">
								{sessions.map((s) => (
									<li key={s.id}>
										<button
											type="button"
											onClick={() => router.push(`/chat/${s.id}`)}
											className="flex w-full items-center gap-3 rounded-lg border border-border/60 px-3 py-2 text-left transition-colors hover:bg-accent"
										>
											<span className="min-w-0 flex-1 truncate font-prose text-(length:--lh-prose-size)">{s.title}</span>
											{s.kind === "practice" && (
												<DumbbellIcon className="size-3.5 text-muted-foreground/70" aria-label="Practice session" />
											)}
											<span className="shrink-0 text-xs text-muted-foreground">{timeAgo(s.updatedAt)}</span>
										</button>
									</li>
								))}
							</ul>
						)}
					</section>

					<section>
						<div className="mb-2 flex items-center justify-between">
							<h2 className="text-xs uppercase tracking-widest text-muted-foreground">Plan</h2>
							<button
								type="button"
								data-testid="module-plan-edit"
								onClick={() => {
									if (editingPlan && plan !== mod.plan) void save({ plan });
									setEditingPlan(!editingPlan);
								}}
								className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
							>
								{editingPlan ? "Done" : "Edit"}
							</button>
						</div>
						{editingPlan ? (
							<textarea
								value={plan}
								data-testid="module-plan"
								aria-label="Module plan"
								placeholder={PLAN_PLACEHOLDER}
								onChange={(e) => setPlan(e.target.value)}
								className="h-72 w-full resize-y rounded-md border border-border bg-background p-3 font-ui text-xs outline-none"
							/>
						) : plan.trim() ? (
							<div className="rounded-md border border-border/60 p-4">
								<MessageResponse>{plan}</MessageResponse>
							</div>
						) : (
							<p className="text-sm text-muted-foreground">No plan yet. Add resources and a lecture checklist with Edit.</p>
						)}
					</section>

					<section className="border-t border-border/60 pt-4">
						{confirmDelete ? (
							<div className="flex items-center gap-3 text-sm">
								<span>Delete this module? Its sessions stay, unfiled.</span>
								<Button
									size="xs"
									variant="destructive"
									className="cursor-pointer"
									data-testid="module-delete-confirm"
									onClick={() => void remove()}
								>
									Delete
								</Button>
								<Button size="xs" variant="outline" className="cursor-pointer" onClick={() => setConfirmDelete(false)}>
									Cancel
								</Button>
							</div>
						) : (
							<button
								type="button"
								data-testid="module-delete"
								onClick={() => setConfirmDelete(true)}
								className="flex items-center gap-1.5 text-xs text-muted-foreground/80 hover:text-foreground"
							>
								<Trash2Icon className="size-3" /> Delete module…
							</button>
						)}
					</section>
				</div>
			</div>
		</div>
	);
}
