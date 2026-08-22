import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

type TodoTask = {
	id: number;
	subject: string;
	status: TaskStatus;
	activeForm?: string;
};

type TodoDetails = {
	tasks: TodoTask[];
	nextId: number;
};

const TITLE_REFRESH_MS = 2000;
const MAX_TITLE_CHARS = 100;

let tasks: TodoTask[] = [];
let lastTitle = "";
let refreshTimer: ReturnType<typeof setInterval> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function isTask(value: unknown): value is TodoTask {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "number" &&
		typeof value.subject === "string" &&
		["pending", "in_progress", "completed", "deleted"].includes(String(value.status))
	);
}

function isTodoDetails(value: unknown): value is TodoDetails {
	if (!isRecord(value)) return false;
	return Array.isArray(value.tasks) && typeof value.nextId === "number" && value.tasks.every(isTask);
}

function cloneTasks(source: readonly TodoTask[]): TodoTask[] {
	return source.map((task) => ({ ...task }));
}

function replayTasksFromBranch(ctx: ExtensionContext): TodoTask[] {
	let latest: TodoTask[] = [];

	for (const entry of ctx.sessionManager.getBranch()) {
		const candidate = entry as {
			type?: string;
			message?: { role?: string; toolName?: string; details?: unknown };
		};

		if (candidate.type !== "message") continue;
		if (candidate.message?.role !== "toolResult") continue;
		if (candidate.message.toolName !== "todo") continue;
		if (!isTodoDetails(candidate.message.details)) continue;

		latest = cloneTasks(candidate.message.details.tasks);
	}

	return latest;
}

function currentTodo(): TodoTask | undefined {
	return tasks
		.filter((task) => task.status === "in_progress")
		.sort((a, b) => a.id - b.id)[0];
}

function stripAnsiAndControls(text: string): string {
	return text
		.replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function truncateTitle(text: string): string {
	const chars = [...text];
	if (chars.length <= MAX_TITLE_CHARS) return text;
	return `${chars.slice(0, MAX_TITLE_CHARS - 1).join("")}…`;
}

function fallbackTitle(ctx: ExtensionContext): string {
	const sessionName = (ctx.sessionManager as { getSessionName?: () => string | undefined }).getSessionName?.();
	return sessionName ? `pi · ${sessionName}` : "pi";
}

function titleFor(ctx: ExtensionContext): string {
	const todo = currentTodo();
	const raw = todo ? `pi · ${todo.subject}` : fallbackTitle(ctx);
	return truncateTitle(stripAnsiAndControls(raw) || "pi");
}

function updateTitle(ctx: ExtensionContext, force = false): void {
	if (!ctx.hasUI) return;

	const nextTitle = titleFor(ctx);
	if (!force && nextTitle === lastTitle) return;

	lastTitle = nextTitle;
	ctx.ui.setTitle(nextTitle);
}

function startRefreshTimer(ctx: ExtensionContext): void {
	if (refreshTimer) clearInterval(refreshTimer);
	if (!ctx.hasUI) return;

	refreshTimer = setInterval(() => {
		updateTitle(ctx, true);
	}, TITLE_REFRESH_MS);
	refreshTimer.unref?.();
}

function stopRefreshTimer(): void {
	if (!refreshTimer) return;
	clearInterval(refreshTimer);
	refreshTimer = undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		tasks = replayTasksFromBranch(ctx);
		lastTitle = "";
		updateTitle(ctx, true);
		startRefreshTimer(ctx);
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "todo") return;
		if (!isTodoDetails(event.details)) return;

		tasks = cloneTasks(event.details.tasks);
		updateTitle(ctx, true);
	});

	pi.on("session_compact", (_event, ctx) => {
		tasks = replayTasksFromBranch(ctx);
		updateTitle(ctx, true);
	});

	pi.on("session_tree", (_event, ctx) => {
		tasks = replayTasksFromBranch(ctx);
		updateTitle(ctx, true);
	});

	pi.on("session_info_changed", (_event, ctx) => {
		updateTitle(ctx, true);
	});

	pi.on("session_shutdown", () => {
		stopRefreshTimer();
		tasks = [];
		lastTitle = "";
	});

	pi.registerCommand("todo-title-refresh", {
		description: "Refresh the terminal title from the current in-progress todo",
		handler: async (_args, ctx) => {
			tasks = replayTasksFromBranch(ctx);
			updateTitle(ctx, true);
			ctx.ui.notify(`Title: ${titleFor(ctx)}`, "info");
		},
	});
}
