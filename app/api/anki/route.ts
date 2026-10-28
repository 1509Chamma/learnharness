/**
 * GET /api/anki — the Anki sync status (Settings → Anki).
 * POST /api/anki — run a sync now and return the resulting status.
 * The sync itself lives in src/server/anki.ts.
 */
import { ankiStatus, syncAnki } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(ankiStatus());
}

export async function POST() {
	return Response.json(await syncAnki());
}
