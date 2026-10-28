/**
 * OBSIDIAN EXPORT (fork feature, 2026-10-28): the learner's knowledge as
 * linked notes in a folder inside an Obsidian vault (settings
 * storage.obsidianFolder). One-way: the app regenerates the notes; edits
 * made inside the folder are overwritten.
 *
 *   Concepts/<name>.md          one per graph node: statement, "Follows
 *                               from" / "Leads to" wiki-links (the chains),
 *                               the session(s) it was learned in
 *   Sessions/<module>/<title>.md one per session: recap, the concepts it
 *                               produced, then the full transcript
 *   Modules/<title>.md          one per module: goal, plan, sessions
 *   LearnHarness.md             the index
 *
 * Safety: every generated note carries `lh_generated: true` in its front
 * matter. Only marked notes inside the export folder are ever overwritten
 * or deleted — anything else there (or anywhere in the vault) is left
 * alone. Files are rewritten only when their content changed, so a synced
 * vault (Google Drive) doesn't churn.
 *
 * Links are vault-path-qualified ([[LearnHarness/Concepts/X|X]]) when the
 * vault root (the ancestor holding .obsidian) is found, so they never
 * resolve to the learner's own notes of the same name.
 *
 * When: after the graph, sessions or modules change (debounced, skipped
 * when nothing changed), and on demand (POST /api/obsidian).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatSummary, GraphChain, GraphNode, ModuleRecord } from "../core/contracts.ts";
import { subscribe } from "../core/events.ts";
import { birthSessionOf } from "../core/session-clusters.ts";
import { sessionMarkdown } from "../core/session-markdown.ts";
import type { ObsidianStatus } from "../core/storage-status.ts";
import { moduleStore } from "../store/modules.ts";
import { readSettings } from "../store/settings.ts";
import { graphRevision, graphView } from "./graph.ts";
import { stores } from "./stores.ts";

const MARKER = "lh_generated: true";
const DEBOUNCE_MS = 30_000;

/** A file name Obsidian and Windows both accept, and a wiki-link can hold. */
export function safeName(text: string): string {
	const cleaned = text
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[. ]+$/, "")
		.slice(0, 100)
		.trim();
	return cleaned || "Untitled";
}

/** The vault root: the nearest ancestor (or the folder itself) holding .obsidian. */
export function findVaultRoot(folder: string): string | null {
	let dir = path.resolve(folder);
	for (;;) {
		if (fs.existsSync(path.join(dir, ".obsidian"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export interface VaultInput {
	nodes: GraphNode[];
	chains: GraphChain[];
	/** Learner-facing sessions (orchestrator chats excluded by the caller). */
	sessions: ChatSummary[];
	modules: ModuleRecord[];
	fileSources: Record<string, string>;
	/** A session's transcript as markdown (lazy: only built for exported sessions). */
	transcriptOf: (sessionId: string) => string;
}

/** Every note the export should contain: relative path → content. Pure. */
export function buildVault(input: VaultInput, linkPrefix: string): Map<string, string> {
	const files = new Map<string, string>();
	const link = (rel: string, label: string) => `[[${linkPrefix}${rel.replace(/\.md$/, "")}|${label}]]`;
	const moduleById = new Map(input.modules.map((m) => [m.id, m]));

	// Unique file names: a clash gets the record's id appended.
	const uniqueNames = <T>(items: T[], name: (t: T) => string, id: (t: T) => string) => {
		const counts = new Map<string, number>();
		for (const t of items) counts.set(name(t).toLowerCase(), (counts.get(name(t).toLowerCase()) ?? 0) + 1);
		return new Map(items.map((t) => [id(t), (counts.get(name(t).toLowerCase()) ?? 0) > 1 ? `${name(t)} (${id(t).slice(-6)})` : name(t)]));
	};

	const moduleFile = new Map(
		[...uniqueNames(input.modules, (m) => safeName(m.title), (m) => m.id)].map(([id, n]) => [id, `Modules/${n}.md`]),
	);
	const sessionFolder = (s: ChatSummary) => {
		const mod = s.moduleId ? moduleById.get(s.moduleId) : undefined;
		return mod ? safeName(mod.title) : "Unfiled";
	};
	const sessionNames = uniqueNames(input.sessions, (s) => `${sessionFolder(s)}/${safeName(s.title)}`, (s) => s.id);
	const sessionFile = new Map(input.sessions.map((s) => [s.id, `Sessions/${sessionNames.get(s.id)}.md`]));
	const conceptNames = uniqueNames(input.nodes, (n) => safeName(n.name), (n) => n.id);
	const conceptFile = new Map(input.nodes.map((n) => [n.id, `Concepts/${conceptNames.get(n.id)}.md`]));
	const conceptLink = (id: string) => {
		const node = input.nodes.find((n) => n.id === id);
		return node ? link(conceptFile.get(id)!, node.name) : null;
	};
	const sessionTitle = new Map(input.sessions.map((s) => [s.id, s.title]));

	const frontMatter = (fields: Record<string, string | string[]>) => {
		const lines = ["---", MARKER];
		for (const [k, v] of Object.entries(fields)) {
			lines.push(Array.isArray(v) ? `${k}: [${v.map((x) => JSON.stringify(x)).join(", ")}]` : `${k}: ${JSON.stringify(v)}`);
		}
		lines.push("---", "");
		return lines.join("\n");
	};
	const tagSlug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";

	// ── concepts ──
	for (const node of input.nodes) {
		const birth = birthSessionOf(node);
		const birthSession = birth ? input.sessions.find((s) => s.id === birth) : undefined;
		const mod = birthSession?.moduleId ? moduleById.get(birthSession.moduleId) : undefined;
		const tags = ["learnharness", ...(mod ? [`learnharness/${tagSlug(mod.title)}`] : [])];
		const out = [frontMatter({ lh_id: node.id, tags }), `# ${node.name}`, "", node.statement, ""];

		const from = input.chains.filter((c) => c.conclusion === node.id);
		const premiseLinks = from.map((c) => c.premises.map(conceptLink).filter(Boolean).join(" + ")).filter(Boolean);
		if (premiseLinks.length > 0) out.push("## Follows from", "", ...premiseLinks.map((l) => `- ${l}`), "");

		const to = input.chains.filter((c) => c.premises.includes(node.id));
		const leadLines = to
			.map((c) => {
				const conclusion = conceptLink(c.conclusion);
				if (!conclusion) return null;
				const others = c.premises.filter((p) => p !== node.id).map(conceptLink).filter(Boolean);
				return others.length > 0 ? `- ${conclusion} (together with ${others.join(", ")})` : `- ${conclusion}`;
			})
			.filter((l): l is string => l !== null);
		if (leadLines.length > 0) out.push("## Leads to", "", ...leadLines, "");

		const sources = [...new Set(node.provenance.map((p) => p.chatId))];
		const learned = sources
			.map((id) => (sessionFile.has(id) ? `- ${link(sessionFile.get(id)!, sessionTitle.get(id)!)}` : input.fileSources[id] ? `- Imported notes: ${input.fileSources[id]}` : null))
			.filter((l): l is string => l !== null);
		if (learned.length > 0) out.push("## Learned in", "", ...learned, "");

		const phrasings = node.aliases.filter((a) => a.trim() && a.trim() !== node.statement.trim()).slice(0, 5);
		if (phrasings.length > 0) out.push("## Also phrased as", "", ...phrasings.map((a) => `- ${a}`), "");
		files.set(conceptFile.get(node.id)!, out.join("\n"));
	}

	// ── sessions ──
	for (const s of input.sessions) {
		const mod = s.moduleId ? moduleById.get(s.moduleId) : undefined;
		const out = [
			frontMatter({ lh_id: s.id, kind: s.kind, started: s.createdAt.slice(0, 10), tags: ["learnharness", "learnharness/session"] }),
			`# ${s.title}`,
			"",
			`${s.kind === "practice" ? "Practice" : "Teaching"} session · started ${s.createdAt.slice(0, 10)} · last active ${s.updatedAt.slice(0, 10)}${mod ? ` · module ${link(moduleFile.get(mod.id)!, mod.title)}` : ""}`,
			"",
		];
		if (s.recap?.text) out.push("## Recap", "", s.recap.text, "");
		const born = input.nodes.filter((n) => birthSessionOf(n) === s.id);
		if (born.length > 0) out.push("## Concepts", "", ...born.map((n) => `- ${link(conceptFile.get(n.id)!, n.name)}`), "");
		out.push("## Transcript", "", input.transcriptOf(s.id).trim(), "");
		files.set(sessionFile.get(s.id)!, out.join("\n"));
	}

	// ── modules ──
	for (const m of input.modules) {
		const sessions = input.sessions
			.filter((s) => s.moduleId === m.id)
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		const out = [frontMatter({ lh_id: m.id, tags: ["learnharness", `learnharness/${tagSlug(m.title)}`] }), `# ${m.title}`, ""];
		if (m.goal.trim()) out.push("## Goal", "", m.goal.trim(), "");
		if (m.plan.trim()) out.push("## Plan", "", m.plan.trim(), "");
		out.push("## Sessions", "");
		out.push(...(sessions.length > 0 ? sessions.map((s) => `- ${link(sessionFile.get(s.id)!, s.title)}`) : ["(none yet)"]), "");
		files.set(moduleFile.get(m.id)!, out.join("\n"));
	}

	// ── index ──
	const unfiled = input.sessions.filter((s) => !s.moduleId || !moduleById.has(s.moduleId));
	files.set(
		"LearnHarness.md",
		[
			frontMatter({ tags: ["learnharness"] }),
			"# LearnHarness",
			"",
			"Generated by LearnHarness — notes in this folder are rewritten by the app, so edits here are lost. Link to them from your own notes instead.",
			"",
			"## Modules",
			"",
			...(input.modules.length > 0 ? input.modules.map((m) => `- ${link(moduleFile.get(m.id)!, m.title)}`) : ["(none yet)"]),
			"",
			...(unfiled.length > 0 ? ["## Unfiled sessions", "", ...unfiled.map((s) => `- ${link(sessionFile.get(s.id)!, s.title)}`), ""] : []),
			`${input.nodes.length} concepts · ${input.sessions.length} sessions`,
			"",
		].join("\n"),
	);
	return files;
}

function isGenerated(file: string): boolean {
	try {
		const head = fs.readFileSync(file, "utf-8").slice(0, 200);
		return head.startsWith("---") && head.includes(MARKER);
	} catch {
		return false;
	}
}

function walkMarkdown(dir: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.flatMap((e) => {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) return walkMarkdown(full);
		return e.isFile() && e.name.endsWith(".md") ? [full] : [];
	});
}

/** Write `files` under `folder`: changed notes only, never clobbering an
 *  unmarked note; then delete marked notes that are no longer wanted. */
export function writeVault(folder: string, files: Map<string, string>): { written: number; deleted: number; skipped: string[] } {
	let written = 0;
	let deleted = 0;
	const skipped: string[] = [];
	const wanted = new Set<string>();
	for (const [rel, content] of files) {
		const target = path.join(folder, ...rel.split("/"));
		wanted.add(path.resolve(target));
		if (fs.existsSync(target)) {
			if (!isGenerated(target)) {
				skipped.push(rel); // the learner's own note with our name — never overwritten
				continue;
			}
			if (fs.readFileSync(target, "utf-8") === content) continue;
		}
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content, "utf-8");
		written++;
	}
	for (const file of walkMarkdown(folder)) {
		if (!wanted.has(path.resolve(file)) && isGenerated(file)) {
			fs.rmSync(file);
			deleted++;
		}
	}
	return { written, deleted, skipped };
}

// ─── the process-wide runner ─────────────────────────────────────────────────

export function obsidianFolder(): string | null {
	return readSettings()?.storage?.obsidianFolder?.trim() || null;
}

interface ObsidianGlobal {
	__lhObsidian?: {
		status: Omit<ObsidianStatus, "folder">;
		timer: ReturnType<typeof setTimeout> | null;
		exportedSignature: string | null;
		started: boolean;
	};
}

function runner() {
	const g = globalThis as ObsidianGlobal;
	g.__lhObsidian ??= {
		status: { lastExportAt: null, notes: 0, lastError: null, skipped: [] },
		timer: null,
		exportedSignature: null,
		started: false,
	};
	return g.__lhObsidian;
}

export function obsidianStatus(): ObsidianStatus {
	return { folder: obsidianFolder(), ...runner().status };
}

/** What an export's output depends on — unchanged means nothing to write. */
function exportSignature(folder: string): string {
	const sessions = stores.chatStore
		.listChats()
		.map((c) => `${c.id}:${c.updatedAt}:${c.title}:${c.moduleId ?? ""}:${c.recap?.forUpdatedAt ?? ""}`)
		.join(",");
	const modules = moduleStore.listModules().map((m) => `${m.id}:${m.updatedAt}`).join(",");
	return `${folder}|${graphRevision()}|${sessions}|${modules}`;
}

/** Export now. Returns the status (errors land in lastError). */
export function exportToObsidian(): ObsidianStatus {
	const r = runner();
	const folder = obsidianFolder();
	if (!folder) {
		r.status = { ...r.status, lastError: "No Obsidian folder is set" };
		return obsidianStatus();
	}
	try {
		if (!path.isAbsolute(folder)) throw new Error("The Obsidian folder must be an absolute path");
		const signature = exportSignature(folder);
		const snapshot = graphView();
		const sessions = stores.chatStore.listChats().filter((c) => c.kind !== "orchestrator");
		const vaultRoot = findVaultRoot(folder);
		const prefix = vaultRoot ? `${path.relative(vaultRoot, folder).split(path.sep).filter(Boolean).join("/")}/` : "";
		const files = buildVault(
			{
				nodes: snapshot.propositions,
				chains: snapshot.chains,
				sessions,
				modules: moduleStore.listModules(),
				fileSources: snapshot.fileSources,
				transcriptOf: (id) => {
					const chat = stores.chatStore.getChat(id);
					return chat ? sessionMarkdown(chat.messages, { anchors: false }) : "";
				},
			},
			prefix === "/" ? "" : prefix,
		);
		fs.mkdirSync(folder, { recursive: true });
		const { skipped } = writeVault(folder, files);
		r.exportedSignature = signature;
		r.status = { lastExportAt: new Date().toISOString(), notes: files.size, lastError: null, skipped };
	} catch (err) {
		r.status = { ...r.status, lastError: err instanceof Error ? err.message : String(err) };
	}
	return obsidianStatus();
}

/** Debounced background trigger; skipped when nothing changed. */
export function scheduleObsidianExport(): void {
	const r = runner();
	if (r.timer) clearTimeout(r.timer);
	r.timer = setTimeout(() => {
		r.timer = null;
		const folder = obsidianFolder();
		if (!folder || r.exportedSignature === exportSignature(folder)) return;
		exportToObsidian();
	}, DEBOUNCE_MS);
	r.timer.unref?.();
}

/** Idempotent boot. Never under the test runner or during the build. */
export function startObsidianExport(): void {
	const r = runner();
	if (r.started || process.env.NODE_ENV === "test" || process.env.NEXT_PHASE === "phase-production-build") return;
	r.started = true;
	subscribe((event) => {
		if (event.type === "activity-changed" || event.type === "chats-changed" || event.type === "turn-settled") scheduleObsidianExport();
	});
	scheduleObsidianExport();
}

startObsidianExport();
