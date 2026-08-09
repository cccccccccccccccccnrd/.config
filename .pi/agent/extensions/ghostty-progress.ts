import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const OSC = "\x1b]";
const ST = "\x1b\\";

let running = false;
let keepAlive: ReturnType<typeof setInterval> | undefined;
let enabledForCurrentRun = false;

function envFlagEnabled(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function isGhosttyLikeTerminal(): boolean {
	const termProgram = process.env.TERM_PROGRAM?.toLowerCase();
	const term = process.env.TERM?.toLowerCase();

	return (
		termProgram === "ghostty" ||
		term === "xterm-ghostty" ||
		term?.includes("ghostty") === true ||
		process.env.GHOSTTY_BIN_DIR !== undefined ||
		process.env.GHOSTTY_RESOURCES_DIR !== undefined
	);
}

function shouldEmit(ctx: ExtensionContext): boolean {
	if (ctx.mode !== "tui") return false;
	if (!process.stdout.isTTY) return false;

	const forced = envFlagEnabled(process.env.PI_GHOSTTY_PROGRESS);
	if (forced !== undefined) return forced;

	return isGhosttyLikeTerminal();
}

function emitProgress(state: 0 | 1 | 2 | 3 | 4, value?: number): void {
	const progress = value === undefined ? "" : `;${Math.max(0, Math.min(100, Math.round(value)))}`;
	process.stdout.write(`${OSC}9;4;${state}${progress}${ST}`);
}

function clearKeepAlive(): void {
	if (!keepAlive) return;
	clearInterval(keepAlive);
	keepAlive = undefined;
}

function startNativeLoading(ctx: ExtensionContext): void {
	if (running) return;

	enabledForCurrentRun = shouldEmit(ctx);
	if (!enabledForCurrentRun) return;

	running = true;
	emitProgress(3); // Indeterminate native Ghostty top loading bar.

	// Ghostty clears stale progress after ~15s, so refresh once per second.
	keepAlive = setInterval(() => {
		if (running) emitProgress(3);
	}, 1000);
	keepAlive.unref?.();
}

function stopNativeLoading(): void {
	const shouldClear = enabledForCurrentRun;
	clearKeepAlive();
	running = false;
	enabledForCurrentRun = false;

	if (shouldClear) emitProgress(0);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_start", (_event, ctx) => {
		startNativeLoading(ctx);
	});

	pi.on("agent_end", () => {
		stopNativeLoading();
	});

	pi.on("session_shutdown", () => {
		stopNativeLoading();
	});

	pi.registerCommand("ghostty-progress-test", {
		description: "Show Ghostty's native OSC 9;4 loading bar for 5 seconds",
		handler: async (_args, ctx) => {
			startNativeLoading(ctx);
			if (!enabledForCurrentRun) {
				ctx.ui.notify(
					"Ghostty progress is inactive. Run inside Ghostty or set PI_GHOSTTY_PROGRESS=1 to force OSC 9;4 output.",
					"warning",
				);
				return;
			}

			await delay(5000);
			stopNativeLoading();
		},
	});
}
