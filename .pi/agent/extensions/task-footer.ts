import { hostname } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let taskStartedAt: number | undefined;
let completedOutputTokens = 0;
let currentMessageEstimatedTokens = 0;
let currentMessageActualTokens = 0;
let requestRender: (() => void) | undefined;
let currentModel: any;
let currentThinkingLevel = "off";
let lastSpeedText = "idle";
const machineHostname = hostname();

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const insideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!insideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;

	if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m`;
	if (m > 0) return `${m}m${s.toString().padStart(2, "0")}s`;
	return `${s}s`;
}

function formatTokens(count: number): string {
	if (count < 1000) return Math.round(count).toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "");
}

function visibleWidth(text: string): number {
	return [...stripAnsi(text)].length;
}

function truncatePlain(text: string, width: number, ellipsis = "…"): string {
	if (width <= 0) return "";
	const chars = [...text];
	if (chars.length <= width) return text;
	if (width <= ellipsis.length) return ellipsis.slice(0, width);
	return chars.slice(0, width - ellipsis.length).join("") + ellipsis;
}

function estimateTokens(text: string): number {
	// Good enough for live speed; final provider usage replaces this when available.
	return text.length / 4;
}

function outputTokensFromEvent(event: AssistantMessageEvent): number | undefined {
	if ("partial" in event) return event.partial.usage?.output;
	if (event.type === "done") return event.message.usage.output;
	if (event.type === "error") return event.error.usage.output;
	return undefined;
}

function currentTaskTokens(): number {
	return completedOutputTokens + (currentMessageActualTokens || currentMessageEstimatedTokens);
}

function resetCurrentMessage(): void {
	currentMessageEstimatedTokens = 0;
	currentMessageActualTokens = 0;
}

function formatSpeedText(tokens: number, elapsedMs: number): string {
	const tokPerSec = tokens / Math.max(1, elapsedMs / 1000);
	const rate = tokPerSec >= 10 ? tokPerSec.toFixed(0) : tokPerSec.toFixed(1);
	return `${rate} tok/s ◯ ${formatElapsed(elapsedMs)}`;
}

function lineWithRightSide(
	left: string,
	rightText: string,
	width: number,
	theme: { fg(color: string, text: string): string },
	leftColor = "dim",
): string {
	const leftStyled = left;
	const leftWidth = visibleWidth(leftStyled);
	if (leftWidth > width) return truncatePlain(left, width);

	const minGap = 2;
	const rightMaxWidth = width - leftWidth - minGap;
	if (rightMaxWidth <= 0) return leftStyled;

	const right = truncatePlain(rightText, rightMaxWidth);
	const padding = " ".repeat(Math.max(minGap, width - leftWidth - visibleWidth(right)));
	return leftStyled + padding + right;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		currentModel = ctx.model;
		const latestThinkingEntry = [...ctx.sessionManager.getEntries()]
			.reverse()
			.find((entry: any) => entry.type === "thinking_level_change");
		currentThinkingLevel = (ctx as any).thinkingLevel ?? latestThinkingEntry?.thinkingLevel ?? currentThinkingLevel;
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const interval = setInterval(() => {
				if (taskStartedAt) tui.requestRender();
			}, 1000);
			interval.unref?.();

			return {
				dispose() {
					clearInterval(interval);
					if (requestRender) requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const elapsedMs = taskStartedAt ? Date.now() - taskStartedAt : 0;
					const tokens = currentTaskTokens();
					const speedText = taskStartedAt ? formatSpeedText(tokens, elapsedMs) : lastSpeedText;

					const cwd = (ctx.sessionManager as any).getCwd?.() ?? ctx.cwd;
					let cwdText = `${machineHostname} ${formatCwd(cwd)}`;
					const sessionName = (ctx.sessionManager as any).getSessionName?.();
					if (sessionName) cwdText += ` ◯ ${sessionName}`;

					const lines = [
						lineWithRightSide(speedText, cwdText, width, theme, taskStartedAt ? "accent" : "dim"),
					];

					let totalInput = 0;
					let totalOutput = 0;
					let totalCacheRead = 0;
					let totalCacheWrite = 0;
					let totalCost = 0;
					let latestCacheHitRate: number | undefined;

					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type !== "message" || entry.message.role !== "assistant") continue;
						const usage = entry.message.usage;
						totalInput += usage.input;
						totalOutput += usage.output;
						totalCacheRead += usage.cacheRead;
						totalCacheWrite += usage.cacheWrite;
						totalCost += usage.cost.total;

						const latestPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
						latestCacheHitRate = latestPromptTokens > 0 ? (usage.cacheRead / latestPromptTokens) * 100 : undefined;
					}

					const statsParts: string[] = [];
					if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
					if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
					if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
					if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
					if ((totalCacheRead > 0 || totalCacheWrite > 0) && latestCacheHitRate !== undefined) {
						statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
					}

					const model = currentModel ?? ctx.model;
					const usingSubscription = model ? (ctx.modelRegistry as any).isUsingOAuth?.(model) : false;
					if (totalCost || usingSubscription) {
						statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
					}

					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
					const contextDisplay =
						contextPercent === "?"
							? `?/${formatTokens(contextWindow)} (auto)`
							: `${contextPercent}%/${formatTokens(contextWindow)} (auto)`;
					statsParts.push(contextDisplay);

					let modelText = model?.id || "no-model";
					if (model?.reasoning) {
						modelText += currentThinkingLevel === "off" ? " ◯ thinking off" : ` ◯ ${currentThinkingLevel}`;
					}
					if (footerData.getAvailableProviderCount() > 1 && model) {
						modelText = `(${model.provider}) ${modelText}`;
					}
					lines.push(lineWithRightSide(statsParts.join(" "), modelText, width, theme));

					const statuses = footerData.getExtensionStatuses();
					if (statuses.size > 0) {
						const statusLine = Array.from(statuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text))
							.join(" ");
						lines.push(truncatePlain(statusLine, width));
					}

					return lines;
				},
			};
		});
	});

	pi.on("model_select", (event) => {
		currentModel = event.model;
		requestRender?.();
	});

	pi.on("thinking_level_select", (event) => {
		currentThinkingLevel = event.level;
		requestRender?.();
	});

	pi.on("agent_start", () => {
		taskStartedAt = Date.now();
		completedOutputTokens = 0;
		resetCurrentMessage();
		requestRender?.();
	});

	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") {
			resetCurrentMessage();
			requestRender?.();
		}
	});

	pi.on("message_update", (event) => {
		const streamEvent = event.assistantMessageEvent;
		if (
			streamEvent.type === "text_delta" ||
			streamEvent.type === "thinking_delta" ||
			streamEvent.type === "toolcall_delta"
		) {
			currentMessageEstimatedTokens += estimateTokens(streamEvent.delta);
		}

		const actual = outputTokensFromEvent(streamEvent);
		if (typeof actual === "number" && actual > currentMessageActualTokens) {
			currentMessageActualTokens = actual;
		}
		requestRender?.();
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;

		const actual = event.message.usage?.output;
		completedOutputTokens += typeof actual === "number" && actual > 0
			? actual
			: currentMessageActualTokens || currentMessageEstimatedTokens;
		resetCurrentMessage();
		requestRender?.();
	});

	pi.on("agent_end", () => {
		if (taskStartedAt) {
			lastSpeedText = formatSpeedText(currentTaskTokens(), Date.now() - taskStartedAt);
		}
		taskStartedAt = undefined;
		completedOutputTokens = 0;
		resetCurrentMessage();
		requestRender?.();
	});
}
