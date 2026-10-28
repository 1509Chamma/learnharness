/**
 * GET /api/modules/[id] — the module plus its sessions (newest first).
 * PATCH /api/modules/[id] {title?, goal?, plan?} — edit.
 * DELETE /api/modules/[id] — remove it; its sessions become unfiled.
 */
import { deleteModule, getModule, moduleSessions, updateModule } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
	const { id } = await params;
	const mod = getModule(id);
	if (!mod) return Response.json({ error: "module not found" }, { status: 404 });
	const sessions = moduleSessions(id);
	return Response.json({ module: mod, sessions });
}

export async function PATCH(req: Request, { params }: Params) {
	const { id } = await params;
	if (!getModule(id)) return Response.json({ error: "module not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== "object") return Response.json({ error: "body must be JSON" }, { status: 400 });
	const patch: { title?: string; goal?: string; plan?: string } = {};
	for (const key of ["title", "goal", "plan"] as const) {
		if (body[key] === undefined) continue;
		if (typeof body[key] !== "string") return Response.json({ error: `${key} must be a string` }, { status: 400 });
		patch[key] = body[key];
	}
	return Response.json(updateModule(id, patch));
}

export async function DELETE(_req: Request, { params }: Params) {
	const { id } = await params;
	return deleteModule(id)
		? Response.json({ ok: true })
		: Response.json({ error: "module not found" }, { status: 404 });
}
