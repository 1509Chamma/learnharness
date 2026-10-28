import { notFound } from "next/navigation";
import { ModulePage } from "@/components/module-page";
import { getModule, listChats } from "@/src/server";

export const dynamic = "force-dynamic";

/** A module's page (modules, fork feature): goal, plan and its sessions. */
export default async function ModuleRoute({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const mod = getModule(id);
	if (!mod) notFound();
	const sessions = listChats().filter((c) => c.moduleId === id);
	return <ModulePage key={mod.id} initialModule={mod} initialSessions={sessions} />;
}
