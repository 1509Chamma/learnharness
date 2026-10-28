/** The Anki sync's status shape (src/server/anki.ts produces it, Settings →
 *  Anki renders it) — in core so the browser shell can import the type. */

export interface AnkiSyncCounts {
	recall: number;
	derivation: number;
	added: number;
	updated: number;
	suspended: number;
}

export interface AnkiStatus {
	state: "never" | "syncing" | "ok" | "unreachable" | "error";
	/** ISO — the last run that reached Anki and finished. */
	lastSyncAt: string | null;
	counts: AnkiSyncCounts | null;
	/** The last failure, or the AnkiWeb sync's complaint on an ok run. */
	message: string | null;
}
