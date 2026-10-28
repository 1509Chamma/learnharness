"use client";
/**
 * Settings → Storage (fork feature): where the app copies your knowledge
 * outside itself. The Backup group sets the snapshot folder (saved on blur
 * through the storage section) and shows the snapshots; "Back up now" POSTs
 * /api/backup. The engine is src/server/backup.ts.
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BrailleSpinner } from "@/components/braille-spinner";
import type { BackupStatus, StorageSettings } from "@/src/core";
import { SettingsGroup, SettingsRow } from "./controls.tsx";

/** A folder path field that saves on blur (and on Enter). */
export function FolderField({
	value,
	label,
	placeholder,
	testid,
	onSave,
}: {
	value: string;
	label: string;
	placeholder: string;
	testid: string;
	onSave: (folder: string) => void;
}) {
	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);
	return (
		<input
			value={draft}
			aria-label={label}
			data-testid={testid}
			placeholder={placeholder}
			spellCheck={false}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={() => {
				if (draft.trim() !== value) onSave(draft.trim());
			}}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
			}}
			className="w-full rounded-sm border border-border bg-background px-2 py-1.5 font-ui text-xs text-foreground outline-none"
		/>
	);
}

export function backupSummary(status: BackupStatus | null): string {
	if (!status) return "Checking…";
	if (!status.folder) return "Off: set a folder to start daily backups";
	if (status.running) return "Backing up…";
	const newest = status.snapshots[0];
	if (!newest) return "No backups yet";
	return `Last backup ${new Date(newest.createdAt).toLocaleString()}`;
}

export function StorageSection({
	storage,
	onChange,
}: {
	storage: StorageSettings | undefined;
	onChange: (next: StorageSettings) => Promise<void> | void;
}) {
	const [status, setStatus] = useState<BackupStatus | null>(null);
	const [busy, setBusy] = useState(false);

	const load = async () => {
		try {
			setStatus((await (await fetch("/api/backup")).json()) as BackupStatus);
		} catch {
			/* keep the last known status */
		}
	};
	useEffect(() => {
		void load();
	}, [storage?.backupFolder]);

	const backUp = async () => {
		setBusy(true);
		try {
			setStatus((await (await fetch("/api/backup", { method: "POST" })).json()) as BackupStatus);
		} finally {
			setBusy(false);
		}
	};

	const saveFolder = (key: keyof StorageSettings, folder: string) => {
		const next: StorageSettings = { ...storage };
		if (folder) next[key] = folder;
		else delete next[key];
		void onChange(next);
	};

	const running = busy || status?.running === true;
	return (
		<>
			<SettingsGroup label="Backup" testid="storage-backup">
				<p className="text-xs text-muted-foreground">
					A dated copy of your sessions, graph, modules and settings goes to this folder once a day while the app runs (API keys are
					never included). Put it inside Google Drive so it is kept off this computer. The newest 30 are kept.
				</p>
				<FolderField
					value={storage?.backupFolder ?? ""}
					label="Backup folder"
					placeholder="e.g. G:\My Drive\LearnHarness Backups"
					testid="backup-folder"
					onSave={(folder) => saveFolder("backupFolder", folder)}
				/>
				<SettingsRow
					label={backupSummary(status)}
					testid="row-backup-status"
					hint={
						<>
							{status && status.snapshots.length > 0 && (
								<span className="block">{status.snapshots.length} of 30 kept</span>
							)}
							{status?.lastError && (
								<span className="block text-red-400" role="alert">
									{status.lastError}
								</span>
							)}
						</>
					}
				>
					<Button
						type="button"
						size="xs"
						variant="outline"
						className="cursor-pointer disabled:cursor-not-allowed"
						data-testid="backup-now"
						disabled={running || !status?.folder}
						aria-busy={running}
						onClick={() => void backUp()}
					>
						{running && <BrailleSpinner label="Backing up" />}
						Back up now
					</Button>
				</SettingsRow>
				<p className="text-xs text-muted-foreground/80">
					To restore: quit the app, then copy the <code>data</code> folder from the snapshot you want over the app&apos;s own{" "}
					<code>data</code> folder.
				</p>
			</SettingsGroup>
		</>
	);
}
