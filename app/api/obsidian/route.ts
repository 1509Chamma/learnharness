/**
 * GET /api/obsidian — the export folder and the last export's outcome.
 * POST /api/obsidian — export now. The engine: src/server/obsidian.ts.
 */
import { exportToObsidian, obsidianStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(obsidianStatus());
}

export async function POST() {
	return Response.json(exportToObsidian());
}
