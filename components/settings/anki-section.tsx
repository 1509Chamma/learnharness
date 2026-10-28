"use client";
/**
 * Settings → Anki (fork feature): the sync status plus a manual trigger.
 * The sync runs server-side on its own (src/server/anki.ts) — this panel
 * only reads GET /api/anki and POSTs for "Sync now".
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BrailleSpinner } from "@/components/braille-spinner";
import type { AnkiStatus } from "@/src/core";
import { SettingsGroup, SettingsRow } from "./controls.tsx";

export function ankiStatusText(status: AnkiStatus | null): string {
	switch (status?.state) {
		case undefined: return "Checking…";
		case "never": return "Not synced yet";
		case "syncing": return "Syncing…";
		case "ok": return "Connected";
		case "unreachable": return "Anki isn’t running, or AnkiConnect isn’t installed";
		case "error": return status.message ?? "Sync failed";
	}
}

export function AnkiSection() {
	const [status, setStatus] = useState<AnkiStatus | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let live = true;
		void fetch("/api/anki").then((r) => r.json()).then((s: AnkiStatus) => { if (live) setStatus(s); }).catch(() => {});
		return () => { live = false; };
	}, []);

	const syncNow = async () => {
		setBusy(true);
		try {
			const res = await fetch("/api/anki", { method: "POST" });
			setStatus((await res.json()) as AnkiStatus);
		} catch {
			/* the status row keeps the last known state */
		} finally {
			setBusy(false);
		}
	};

	const counts = status?.counts;
	const syncing = busy || status?.state === "syncing";
	return (
		<>
			<SettingsGroup label="Sync" testid="anki-sync">
				<SettingsRow
					label={ankiStatusText(status)}
					testid="row-anki-status"
					hint={
						<>
							{status?.lastSyncAt && (
								<span className="block">Last synced {new Date(status.lastSyncAt).toLocaleString()}</span>
							)}
							{counts && (
								<span className="block">
									{counts.recall} recall · {counts.derivation} derivation cards
									{(counts.added > 0 || counts.updated > 0 || counts.suspended > 0) &&
										` — last run: ${counts.added} added, ${counts.updated} updated, ${counts.suspended} suspended`}
								</span>
							)}
							{status?.state === "ok" && status.message && <span className="block">{status.message}</span>}
						</>
					}
				>
					<Button
						type="button"
						size="xs"
						variant="outline"
						className="cursor-pointer disabled:cursor-not-allowed"
						data-testid="anki-sync-now"
						disabled={syncing}
						aria-busy={syncing}
						onClick={() => void syncNow()}
					>
						{syncing && <BrailleSpinner label="Syncing with Anki" />}
						Sync now
					</Button>
				</SettingsRow>
			</SettingsGroup>
			<SettingsGroup label="Setup" testid="anki-setup">
				<p className="text-xs text-muted-foreground">
					Install Anki desktop, then the AnkiConnect add-on (Tools → Add-ons → Get Add-ons, code 2055492159)
					and restart Anki. Sign in to AnkiWeb in Anki so cards reach your phone. While Anki is open, every
					node and reasoning chain syncs into the {"“"}LearnHarness{"”"} deck after each lesson, tagged by
					session. Suspend a card in Anki to drop it — the sync never unsuspends. Edit wording in the app,
					not in Anki: the next sync overwrites card text from the graph.
				</p>
			</SettingsGroup>
		</>
	);
}
