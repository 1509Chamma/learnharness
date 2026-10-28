/**
 * MODULES (fork feature, 2026-10-28): a module is a folder of sessions on
 * one subject (Linear Algebra, Real Analysis, …) with its own orchestrating
 * agent. Sessions join a module through ChatRecord.moduleId; the module
 * record holds what belongs to the subject as a whole. One JSON file per
 * module in data/modules/ (src/store/modules.ts).
 */

export interface ModuleRecord {
	/** "mod_" + time + random, filename-safe. */
	id: string;
	title: string;
	/** What the learner is aiming at in this module ("MIT 18.06, then
	 *  Linear Algebra Done Right") — their words, editable. */
	goal: string;
	/** The module plan in markdown: resources, lecture checklist, progress.
	 *  Maintained by the orchestrator; editable by the learner. */
	plan: string;
	createdAt: string;
	updatedAt: string;
}

/** The sidebar's module row: the record plus its session count. */
export interface ModuleSummary extends ModuleRecord {
	sessionCount: number;
}
