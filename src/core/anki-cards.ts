/**
 * ANKI CARDS (fork feature, 2026-10-28) — the graph rendered as Anki notes.
 * Pure: no IO. src/server/anki.ts diffs these against what AnkiConnect
 * reports and pushes the difference.
 *
 * Two note types, both keyed by the graph's own stable id in their FIRST
 * field (Anki's duplicate check reads the first field, and the sync looks
 * notes up by it — no mapping file anywhere):
 *   - Recall      one per proposition: name → statement.
 *   - Derivation  one per stored chain: premises → conclusion.
 * Each note carries the birth session as a tag (`LearnHarness::<title>`),
 * nested under its module when the session is filed in one
 * (`LearnHarness::<module>::<title>`), so a commute review can filter to
 * one module or one session.
 */

import type { GraphNode, GraphSnapshot } from "./contracts.ts";
import { birthSessionOf } from "./session-clusters.ts";

export const ANKI_DECK = "LearnHarness";
export const RECALL_MODEL = "LearnHarness Recall";
export const DERIVATION_MODEL = "LearnHarness Derivation";
/** Tagged onto notes whose node or chain left the graph (cards suspended). */
export const DELETED_TAG = "LearnHarness::deleted";

export const RECALL_FIELDS = ["NodeId", "Name", "Statement", "Source"] as const;
export const DERIVATION_FIELDS = ["ChainId", "Premises", "Conclusion", "Source"] as const;

export type RecallFields = Record<(typeof RECALL_FIELDS)[number], string>;
export type DerivationFields = Record<(typeof DERIVATION_FIELDS)[number], string>;

export interface DesiredNote {
	model: typeof RECALL_MODEL | typeof DERIVATION_MODEL;
	/** The graph id — the note's first field. */
	key: string;
	fields: RecallFields | DerivationFields;
	tags: string[];
}

const CSS = `.card { font-family: system-ui, sans-serif; font-size: 20px; line-height: 1.5; text-align: left; max-width: 40em; margin: 0 auto; }
.lh-name { font-weight: 600; }
.lh-prompt { color: #888; font-size: 0.8em; margin-top: 0.5em; }
.lh-source { color: #888; font-size: 0.7em; margin-top: 1.5em; }
ul.lh-premises { padding-left: 1.2em; }`;

/** The two note types as AnkiConnect `createModel` params. */
export const MODEL_DEFINITIONS = [
	{
		modelName: RECALL_MODEL,
		inOrderFields: [...RECALL_FIELDS],
		css: CSS,
		cardTemplates: [
			{
				Name: "Recall",
				Front: `<div class="lh-name">{{Name}}</div><div class="lh-prompt">State it precisely.</div>`,
				Back: `{{FrontSide}}<hr id="answer">{{Statement}}<div class="lh-source">{{Source}}</div>`,
			},
		],
	},
	{
		modelName: DERIVATION_MODEL,
		inOrderFields: [...DERIVATION_FIELDS],
		css: CSS,
		cardTemplates: [
			{
				Name: "Derivation",
				Front: `<div class="lh-prompt">Given</div>{{Premises}}<div class="lh-prompt">what follows?</div>`,
				Back: `{{FrontSide}}<hr id="answer">{{Conclusion}}<div class="lh-source">{{Source}}</div>`,
			},
		],
	},
] as const;

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Light inline markdown on a non-math run: code, bold, italics, newlines. */
function inlineMarkdown(s: string): string {
	return escapeHtml(s)
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
		.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>")
		.replace(/\n/g, "<br>");
}

/**
 * The app's text (markdown + `$…$` / `$$…$$` / `\(…\)` / `\[…\]` math) as
 * Anki field HTML: math goes to MathJax's `\(…\)` / `\[…\]` (what Anki
 * renders), everything else is escaped with light markdown applied.
 */
export function toAnkiHtml(text: string): string {
	const math = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g;
	let out = "";
	let last = 0;
	for (const m of text.matchAll(math)) {
		out += inlineMarkdown(text.slice(last, m.index));
		const display = m[1] ?? m[2];
		out += display !== undefined ? `\\[${escapeHtml(display)}\\]` : `\\(${escapeHtml(m[3] ?? m[4] ?? "")}\\)`;
		last = m.index + m[0].length;
	}
	return out + inlineMarkdown(text.slice(last));
}

/** One tag segment: no spaces, no quotes, no "::" (Anki's hierarchy). */
function tagSegment(text: string): string {
	return text.trim().replace(/\s+/g, "_").replace(/["]/g, "").replace(/:{2,}/g, ":") || "untitled";
}

/** A session title as one Anki tag (tags cannot hold spaces), nested under
 *  its module's title when it has one. */
export function sessionTag(title: string, moduleTitle?: string | null): string {
	return moduleTitle
		? `${ANKI_DECK}::${tagSegment(moduleTitle)}::${tagSegment(title)}`
		: `${ANKI_DECK}::${tagSegment(title)}`;
}

function sourceOf(node: GraphNode, snapshot: Pick<GraphSnapshot, "sessions" | "fileSources">): string | null {
	const birth = birthSessionOf(node);
	if (!birth) return null;
	return snapshot.sessions[birth] ?? snapshot.fileSources[birth] ?? null;
}

/** Every note the graph currently implies, recall notes first.
 *  `moduleTitleOf` maps a birth session id to its module's title. */
export function desiredNotes(
	snapshot: Pick<GraphSnapshot, "propositions" | "chains" | "sessions" | "fileSources">,
	moduleTitleOf: (sessionId: string) => string | null = () => null,
): DesiredNote[] {
	const byId = new Map(snapshot.propositions.map((n) => [n.id, n]));
	const tagsFor = (source: string | null, node: GraphNode) => {
		if (!source) return [ANKI_DECK];
		const birth = birthSessionOf(node);
		return [ANKI_DECK, sessionTag(source, birth ? moduleTitleOf(birth) : null)];
	};

	const recall: DesiredNote[] = snapshot.propositions.map((node) => {
		const source = sourceOf(node, snapshot);
		return {
			model: RECALL_MODEL,
			key: node.id,
			fields: {
				NodeId: node.id,
				Name: toAnkiHtml(node.name),
				Statement: toAnkiHtml(node.statement),
				Source: source ? escapeHtml(source) : "",
			},
			tags: tagsFor(source, node),
		};
	});

	const derivation: DesiredNote[] = [];
	for (const chain of snapshot.chains) {
		const conclusion = byId.get(chain.conclusion);
		const premises = chain.premises.map((id) => byId.get(id));
		if (!conclusion || premises.length === 0 || premises.some((p) => !p)) continue;
		const source = sourceOf(conclusion, snapshot);
		derivation.push({
			model: DERIVATION_MODEL,
			key: chain.id,
			fields: {
				ChainId: chain.id,
				Premises: premisesHtml(premises as GraphNode[]),
				Conclusion: `<div class="lh-name">${toAnkiHtml(conclusion.name)}</div>${toAnkiHtml(conclusion.statement)}`,
				Source: source ? escapeHtml(source) : "",
			},
			tags: tagsFor(source, conclusion),
		});
	}
	return [...recall, ...derivation];
}

function premisesHtml(premises: GraphNode[]): string {
	return `<ul class="lh-premises">${premises.map((p) => `<li>${toAnkiHtml(p.statement)}</li>`).join("")}</ul>`;
}

/** The identity field name for a note type. */
export function keyField(model: DesiredNote["model"]): "NodeId" | "ChainId" {
	return model === RECALL_MODEL ? "NodeId" : "ChainId";
}

