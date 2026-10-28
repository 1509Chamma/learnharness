import { notFound } from "next/navigation";
import { ModulePage } from "@/components/module-page";
import { slotsConfigured } from "@/src/core";
import {
	compactionInFlight,
	ensureOrchestratorChat,
	getChat,
	getModule,
	isTurnRunning,
	moduleSessions,
	readSettingsRecord,
	turnFailure,
} from "@/src/server";

export const dynamic = "force-dynamic";

/** A module's page (modules, fork feature): its orchestrator chat beside
 *  the module panel. The orchestrator chat is created on first visit. */
export default async function ModuleRoute({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const mod = getModule(id);
	if (!mod) notFound();
	const chatId = ensureOrchestratorChat(id);
	const chat = getChat(chatId);
	if (!chat) notFound();
	return (
		<ModulePage
			key={mod.id}
			initialModule={mod}
			initialSessions={moduleSessions(id)}
			orchestrator={{
				chatId,
				title: chat.title,
				initialMessages: chat.messages,
				initialError: turnFailure(chatId),
				initialConfigured: slotsConfigured(readSettingsRecord()?.models),
				initiallyInFlight: isTurnRunning(chatId),
				initiallyCompacting: compactionInFlight(chatId),
			}}
		/>
	);
}
