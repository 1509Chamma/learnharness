/**
 * PUT /api/chats/[id]/module {moduleId: string | null} — file the session
 * into a module, or unfile it.
 */
import { chatStore, fileSession } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!chatStore.getChat(id)) return Response.json({ error: "session not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as { moduleId?: unknown } | null;
	const moduleId = body?.moduleId;
	if (moduleId !== null && typeof moduleId !== "string") {
		return Response.json({ error: "moduleId must be a string or null" }, { status: 400 });
	}
	try {
		fileSession(id, moduleId);
	} catch (err) {
		return Response.json({ error: (err as Error).message }, { status: 404 });
	}
	return Response.json({ ok: true });
}
