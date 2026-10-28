/** Status shapes for the storage features (fork feature): src/server/backup.ts
 *  produces BackupStatus, Settings → Storage renders it. In core so the
 *  browser shell can import the types. */

export interface Snapshot {
	name: string;
	createdAt: string;
}

export interface BackupStatus {
	/** The configured folder, or null when backups are off. */
	folder: string | null;
	running: boolean;
	/** Newest first. */
	snapshots: Snapshot[];
	/** The last run's failure, cleared by the next success. */
	lastError: string | null;
}
