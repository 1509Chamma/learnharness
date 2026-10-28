"use client";
/**
 * Sidebar modules (fork feature): module folders above the unfiled sessions.
 * A module row toggles its sessions open/closed (chevron) and opens the
 * module page (title). The expanded set persists per device. Pure helpers
 * are exported for tests.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRightIcon, FolderIcon, FolderOpenIcon, PlusIcon } from "lucide-react";
import type { ChatListItem, ModuleSummary } from "@/src/core";
import { cn } from "@/lib/utils";

const EXPANDED_KEY = "lh:modules-expanded";

/** The session rows in visual order (what the keyboard walk cycles):
 *  each expanded module's sessions, then the unfiled ones. A session whose
 *  module no longer exists counts as unfiled. */
export function sidebarRows(
	chats: readonly ChatListItem[],
	modules: readonly ModuleSummary[],
	expanded: ReadonlySet<string>,
): { groups: Array<{ module: ModuleSummary; sessions: ChatListItem[] }>; unfiled: ChatListItem[]; rows: ChatListItem[] } {
	const known = new Set(modules.map((m) => m.id));
	const groups = modules.map((module) => ({ module, sessions: chats.filter((c) => c.moduleId === module.id) }));
	const unfiled = chats.filter((c) => !c.moduleId || !known.has(c.moduleId));
	const rows = [...groups.flatMap((g) => (expanded.has(g.module.id) ? g.sessions : [])), ...unfiled];
	return { groups, unfiled, rows };
}

/** The expanded-modules set, persisted in localStorage (best effort). */
export function useExpandedModules(activeModuleId: string | null) {
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	useEffect(() => {
		try {
			const raw = window.localStorage.getItem(EXPANDED_KEY);
			if (raw) setExpanded(new Set(JSON.parse(raw) as string[]));
		} catch {
			/* storage unavailable — start collapsed */
		}
	}, []);
	const persist = (next: Set<string>) => {
		try {
			window.localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
		} catch {
			/* storage unavailable */
		}
	};
	// The open session's module unfolds itself, so the active row is visible.
	useEffect(() => {
		if (!activeModuleId) return;
		setExpanded((prev) => {
			if (prev.has(activeModuleId)) return prev;
			const next = new Set(prev).add(activeModuleId);
			persist(next);
			return next;
		});
	}, [activeModuleId]);
	const toggle = useCallback((id: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			persist(next);
			return next;
		});
	}, []);
	return { expanded, toggle };
}

export function ModuleRow({
	module,
	expanded,
	active,
	onToggle,
	onOpen,
}: {
	module: ModuleSummary;
	expanded: boolean;
	active: boolean;
	onToggle: () => void;
	onOpen: () => void;
}) {
	const Icon = expanded ? FolderOpenIcon : FolderIcon;
	return (
		<div
			data-testid="module-row"
			className={cn("mb-0.5 flex w-full items-center rounded-lg transition-colors hover:bg-accent", active && "bg-accent")}
		>
			<span
				role="button"
				tabIndex={-1}
				aria-label={expanded ? `Collapse ${module.title}` : `Expand ${module.title}`}
				aria-expanded={expanded}
				data-testid="module-toggle"
				onClick={onToggle}
				className="flex size-8 shrink-0 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground"
			>
				<ChevronRightIcon className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
			</span>
			<span
				role="link"
				tabIndex={-1}
				data-testid="module-open"
				onClick={onOpen}
				className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2 pr-3"
			>
				<Icon className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="min-w-0 flex-1 truncate font-prose text-(length:--lh-prose-size)">{module.title}</span>
				<span className="shrink-0 text-xs text-muted-foreground/70">{module.sessionCount}</span>
			</span>
		</div>
	);
}

/** The "+ module" affordance: a header button that swaps to an inline
 *  name input; Enter creates, Esc/blur-empty cancels. */
export function NewModuleInput({ onCreate, onCancel }: { onCreate: (title: string) => void; onCancel: () => void }) {
	const [draft, setDraft] = useState("");
	const ref = useRef<HTMLInputElement | null>(null);
	useEffect(() => ref.current?.focus(), []);
	return (
		<input
			ref={ref}
			value={draft}
			data-testid="new-module-input"
			aria-label="New module name"
			placeholder="Module name, e.g. Linear Algebra"
			onChange={(e) => setDraft(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.stopPropagation();
					onCancel();
				} else if (e.key === "Enter" && draft.trim()) {
					e.preventDefault();
					onCreate(draft.trim());
				}
			}}
			onBlur={() => (draft.trim() ? onCreate(draft.trim()) : onCancel())}
			className="mb-1 w-full rounded-md border border-border bg-background px-2 py-1.5 font-prose text-(length:--lh-prose-size) outline-none"
		/>
	);
}

export function ModulesHeader({ onAdd }: { onAdd: () => void }) {
	return (
		<div className="mb-1 flex items-center justify-between px-1 pt-1">
			<span className="text-xs uppercase tracking-widest text-muted-foreground/70">Modules</span>
			<button
				type="button"
				data-testid="new-module"
				aria-label="New module"
				onClick={onAdd}
				className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<PlusIcon className="size-3.5" />
			</button>
		</div>
	);
}

/** Context-menu block: file the right-clicked session into a module. */
export function MoveToModuleItems({
	modules,
	current,
	onMove,
}: {
	modules: readonly ModuleSummary[];
	current: string | undefined;
	onMove: (moduleId: string | null) => void;
}) {
	const targets = modules.filter((m) => m.id !== current);
	if (targets.length === 0 && !current) return null;
	return (
		<>
			<div className="my-0.5 border-t border-border/60" aria-hidden="true" />
			{targets.length > 0 && <p className="px-2.5 pt-1 text-[11px] uppercase tracking-wider text-muted-foreground/70">Move to</p>}
			{targets.map((m) => (
				<button
					key={m.id}
					type="button"
					data-testid="ctx-move-module"
					onClick={() => onMove(m.id)}
					className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
				>
					<FolderIcon className="size-3 shrink-0 text-muted-foreground" />
					<span className="truncate">{m.title}</span>
				</button>
			))}
			{current && (
				<button
					type="button"
					data-testid="ctx-unfile"
					onClick={() => onMove(null)}
					className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
				>
					Remove from module
				</button>
			)}
		</>
	);
}
