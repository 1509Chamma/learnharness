/**
 * GET /api/modules — every module with its session count (the sidebar).
 * POST /api/modules {title, goal?} — create one; 201 with the record.
 */
import { createModule, listModuleSummaries } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ modules: listModuleSummaries() });
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { title?: unknown; goal?: unknown } | null;
	const title = typeof body?.title === "string" ? body.title.trim() : "";
	if (!title) return Response.json({ error: "title is required" }, { status: 400 });
	const goal = typeof body?.goal === "string" ? body.goal : "";
	return Response.json(createModule(title, goal), { status: 201 });
}
