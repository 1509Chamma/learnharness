"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRightIcon, ChevronRightIcon, DumbbellIcon, FolderIcon } from "lucide-react";
import type { ArtifactPartProps } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * Module cards (modules, fork feature).
 *
 * ModuleContextCard — message[0] of a session the orchestrator created: the
 * brief it was set up with, in the graph-context card's minimal, collapsed
 * style. The model reads the marker's full text (goal, plan, recaps); the
 * card shows the learner the brief.
 *
 * CreatedSessionCard — the orchestrator's create_session tool part: the new
 * session with a button that opens it. The session's title rides as the
 * opening prompt, so its first turn starts on arrival.
 */

export interface ModuleContextData {
	moduleId: string;
	moduleTitle: string;
	brief: string;
}

export function ModuleContextCard({ data }: { data: ModuleContextData }) {
	const [open, setOpen] = useState(false);
	return (
		<div data-testid="module-context-card" className="my-1">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
				<FolderIcon aria-hidden="true" className="size-3.5 shrink-0" />
				<span className="font-medium">{data?.moduleTitle ?? "Module"}</span>
				<span className="min-w-0 flex-1 truncate">session brief</span>
			</button>
			{open && (
				<div className="mt-1 whitespace-pre-wrap rounded-lg border border-dashed border-border/70 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
					{data?.brief}
				</div>
			)}
		</div>
	);
}

interface CreatedOutput {
	chatId?: string;
	title?: string;
	kind?: "teach" | "practice";
}

export function CreatedSessionCard({ part }: ArtifactPartProps) {
	const input = (part.input ?? {}) as { title?: string; kind?: string };
	const output = (part.output ?? null) as CreatedOutput | null;
	const title = output?.title ?? input.title ?? "New session";
	const practice = (output?.kind ?? input.kind) === "practice";
	if (part.state !== "output-available" || !output?.chatId) {
		return (
			<div data-testid="created-session-card" className="my-2 rounded-lg border border-border/60 px-4 py-3 text-xs text-muted-foreground">
				{part.state === "output-error" ? `Couldn’t create “${title}”.` : `Creating “${title}”…`}
			</div>
		);
	}
	const href = `/chat/${output.chatId}?prompt=${encodeURIComponent(title)}`;
	return (
		<div data-testid="created-session-card" className="my-2 flex items-center gap-3 rounded-lg border border-border px-4 py-3">
			{practice ? (
				<DumbbellIcon className="size-4 shrink-0 text-muted-foreground" aria-label="Practice session" />
			) : (
				<FolderIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
			)}
			<span className="min-w-0 flex-1">
				<span className="block truncate font-prose text-(length:--lh-prose-size)">{title}</span>
				<span className="block text-xs text-muted-foreground">{practice ? "Practice session" : "Teaching session"} · ready</span>
			</span>
			<Link
				href={href}
				data-testid="open-created-session"
				className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs transition-colors hover:bg-accent"
			>
				Open session <ArrowRightIcon className="size-3" />
			</Link>
		</div>
	);
}
