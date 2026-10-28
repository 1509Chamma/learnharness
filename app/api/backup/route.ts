/**
 * GET /api/backup — the backup folder, its snapshots and the last error.
 * POST /api/backup — take a snapshot now. The engine: src/server/backup.ts.
 */
import { backUpNow, backupStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(backupStatus());
}

export async function POST() {
	return Response.json(backUpNow());
}
