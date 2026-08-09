import { readFile } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SUBSCRIPTION_REFRESH_MS = 5 * 60 * 1000;
const SUBSCRIPTION_FETCH_TIMEOUT_MS = 10 * 1000;

let taskStartedAt: number | undefined;
let currentMessageEstimatedTokens = 0;
let currentMessageActualTokens = 0;
let requestRender: (() => void) | undefined;
let currentModel: any;
let currentThinkingLevel = "off";
let lastRunText = "idle";
let subscriptionUsageText: string | undefined;
let subscriptionProvider: string | undefined;
let subscriptionLastFetched = 0;
let subscriptionFetchInFlight: Promise<void> | undefined;
const machineHostname = hostname();

type UsageWindowName = "5h" | "7d";

type UsageWindow = {
	name: UsageWindowName;
	usedPercent: number;
	resetAt: number;
};

type UsageSnapshot = {
	provider: string;
	primary?: UsageWindow;
	secondary?: UsageWindow;
};

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
	// Good enough for live output usage; final provider usage replaces this when available.
	return text.length / 4;
}

function outputTokensFromEvent(event: AssistantMessageEvent): number | undefined {
	if ("partial" in event) return event.partial.usage?.output;
	if (event.type === "done") return event.message.usage.output;
	if (event.type === "error") return event.error.usage.output;
	return undefined;
}

function currentMessageTokens(): number {
	return currentMessageActualTokens || currentMessageEstimatedTokens;
}

function resetCurrentMessage(): void {
	currentMessageEstimatedTokens = 0;
	currentMessageActualTokens = 0;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function finiteNumber(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) ? number : undefined;
}

function clampPercent(value: unknown): number | undefined {
	const number = finiteNumber(value);
	return number === undefined ? undefined : Math.min(100, Math.max(0, number));
}

function epochMs(value: unknown): number | undefined {
	if (typeof value === "string" && value.trim() && !Number.isFinite(Number(value))) {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	const number = finiteNumber(value);
	if (number === undefined || number <= 0) return undefined;
	return number < 10_000_000_000 ? number * 1000 : number;
}

function usageWindow(name: UsageWindowName, value: unknown): UsageWindow | undefined {
	const source = record(value);
	const usedPercent = clampPercent(source.used_percent ?? source.usedPercent ?? source.utilization);
	const resetAt = epochMs(source.reset_at ?? source.resetAt ?? source.resets_at);
	if (usedPercent === undefined || resetAt === undefined) return undefined;

	return { name, usedPercent, resetAt };
}

function usageFamily(provider: string): "codex" | "anthropic" | undefined {
	if (provider === "openai-codex" || /^openai-codex-account-\d+$/.test(provider)) return "codex";
	if (provider === "anthropic" || /^anthropic-account-\d+$/.test(provider)) return "anthropic";
	return undefined;
}

function providerUsageLabel(provider: string): string {
	const index = provider.match(/-account-(\d+)$/)?.[1];
	if (provider.startsWith("openai-codex")) return index ? `Codex A${index}` : "Codex";
	if (provider.startsWith("anthropic")) return index ? `Claude A${index}` : "Claude";
	return provider;
}

function remainingPercent(window: UsageWindow): number {
	return Math.max(0, Math.round(100 - window.usedPercent));
}

function formatResetDuration(resetAt: number, now = Date.now()): string {
	const minutes = Math.max(0, Math.ceil((resetAt - now) / 60_000));
	if (minutes < 60) return `${minutes}m`;

	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	if (hours < 24) return restMinutes ? `${hours}h${restMinutes}m` : `${hours}h`;

	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours ? `${days}d${restHours}h` : `${days}d`;
}

function formatSubscriptionUsage(snapshot: UsageSnapshot, now = Date.now()): string {
	const parts = [providerUsageLabel(snapshot.provider)];
	for (const window of [snapshot.primary, snapshot.secondary]) {
		if (!window) continue;
		parts.push(`${window.name} ${remainingPercent(window)}%/${formatResetDuration(window.resetAt, now)}`);
	}
	return parts.join(" ");
}

function parseCodexUsageBody(provider: string, body: unknown): UsageSnapshot | undefined {
	const source = record(body);
	const rateLimit = record(source.rate_limit);
	const primary = usageWindow("5h", rateLimit.primary_window);
	const secondary = usageWindow("7d", rateLimit.secondary_window);
	if (!primary && !secondary) return undefined;
	return { provider, primary, secondary };
}

function parseAnthropicUsageBody(provider: string, body: unknown): UsageSnapshot | undefined {
	const source = record(body);
	const primary = usageWindow("5h", source.five_hour);
	const secondary = usageWindow("7d", source.seven_day);
	if (!primary && !secondary) return undefined;
	return { provider, primary, secondary };
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

async function getOAuthAccess(provider: string): Promise<{ access: string; accountId?: string } | undefined> {
	const authPath = join(agentDir(), "auth.json");
	const auth = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
	const credential = record(auth[provider]);
	const access = credential.access;
	const expires = finiteNumber(credential.expires);

	if (credential.type !== "oauth" || typeof access !== "string" || !access) return undefined;
	if (expires !== undefined && expires <= Date.now()) return undefined;
	return {
		access,
		accountId: typeof credential.accountId === "string" ? credential.accountId : undefined,
	};
}

async function fetchSubscriptionUsage(provider: string): Promise<UsageSnapshot | undefined> {
	const family = usageFamily(provider);
	if (!family) return undefined;

	const credential = await getOAuthAccess(provider);
	if (!credential) return undefined;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SUBSCRIPTION_FETCH_TIMEOUT_MS);
	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${credential.access}`,
			Accept: "application/json",
		};
		const url =
			family === "codex"
				? "https://chatgpt.com/backend-api/wham/usage"
				: "https://api.anthropic.com/api/oauth/usage";

		if (family === "codex" && credential.accountId) {
			headers["ChatGPT-Account-Id"] = credential.accountId;
		}
		if (family === "anthropic") {
			headers["anthropic-beta"] = "oauth-2025-04-20";
		}

		const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
		if (!response.ok) return undefined;

		const body = await response.json();
		return family === "codex"
			? parseCodexUsageBody(provider, body)
			: parseAnthropicUsageBody(provider, body);
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

function activeUsageProvider(model: unknown): string | undefined {
	const provider = record(model).provider;
	return typeof provider === "string" ? provider : undefined;
}

function refreshSubscriptionUsage(ctx: { model?: unknown }, force = false): void {
	const provider = activeUsageProvider(ctx.model ?? currentModel);
	if (!provider || !usageFamily(provider)) {
		subscriptionProvider = undefined;
		subscriptionUsageText = undefined;
		subscriptionLastFetched = 0;
		requestRender?.();
		return;
	}

	const now = Date.now();
	if (
		!force &&
		subscriptionProvider === provider &&
		subscriptionUsageText &&
		now - subscriptionLastFetched < SUBSCRIPTION_REFRESH_MS
	) {
		return;
	}
	if (subscriptionFetchInFlight) return;

	subscriptionProvider = provider;
	subscriptionFetchInFlight = fetchSubscriptionUsage(provider)
		.then((snapshot) => {
			if (subscriptionProvider !== provider) return;
			subscriptionLastFetched = Date.now();
			subscriptionUsageText = snapshot ? formatSubscriptionUsage(snapshot) : undefined;
		})
		.finally(() => {
			subscriptionFetchInFlight = undefined;
			requestRender?.();
		});
}

function lineWithRightSide(left: string, rightText: string, width: number): string {
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

function usageNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sessionUsageText(ctx: any, model: any): string {
	let totalInput = 0;
	let totalOutput = 0;
	let totalCost = 0;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message") continue;
		const usage = entry.message.usage;
		if (!usage) continue;

		// Keep one compact "in" figure by folding cache tokens into prompt/input usage.
		totalInput += usageNumber(usage.input) + usageNumber(usage.cacheRead) + usageNumber(usage.cacheWrite);
		totalOutput += usageNumber(usage.output);
		totalCost += usageNumber(usage.cost?.total);
	}

	// Add the currently streaming assistant output before the finalized usage arrives.
	totalOutput += currentMessageTokens();

	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
	const contextPercentValue = contextUsage?.percent ?? 0;
	const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
	const contextDisplay =
		contextPercent === "?"
			? `ctx?/${formatTokens(contextWindow)}`
			: `ctx${contextPercent}%/${formatTokens(contextWindow)}`;

	return [
		`↑${formatTokens(totalInput)}`,
		`↓${formatTokens(totalOutput)}`,
		`$${totalCost.toFixed(3)}`,
		contextDisplay,
	].join(" ");
}

function elapsedText(): string {
	const elapsed = taskStartedAt ? formatElapsed(Date.now() - taskStartedAt) : lastRunText;
	return [elapsed, subscriptionUsageText].filter(Boolean).join(" ");
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		currentModel = ctx.model;
		const latestThinkingEntry = [...ctx.sessionManager.getEntries()]
			.reverse()
			.find((entry: any) => entry.type === "thinking_level_change");
		currentThinkingLevel = (ctx as any).thinkingLevel ?? latestThinkingEntry?.thinkingLevel ?? currentThinkingLevel;
		refreshSubscriptionUsage(ctx, true);

		ctx.ui.setFooter((tui, _theme, footerData) => {
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
					const model = currentModel ?? ctx.model;
					const usageText = sessionUsageText(ctx, model);

					const cwd = (ctx.sessionManager as any).getCwd?.() ?? ctx.cwd;
					let cwdText = `${machineHostname} ${formatCwd(cwd)}`;
					const sessionName = (ctx.sessionManager as any).getSessionName?.();
					if (sessionName) cwdText += ` ${sessionName}`;

					const lines = [lineWithRightSide(usageText, cwdText, width)];

					let modelText = model?.id || "no-model";
					if (model?.reasoning) {
						modelText += currentThinkingLevel === "off" ? " thinking off" : ` ${currentThinkingLevel}`;
					}
					if (footerData.getAvailableProviderCount() > 1 && model) {
						modelText = `(${model.provider}) ${modelText}`;
					}
					lines.push(lineWithRightSide(elapsedText(), modelText, width));

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

	pi.on("model_select", (event, ctx) => {
		currentModel = event.model;
		refreshSubscriptionUsage(ctx, true);
		requestRender?.();
	});

	pi.on("thinking_level_select", (event) => {
		currentThinkingLevel = event.level;
		requestRender?.();
	});

	pi.on("agent_start", (_event, ctx) => {
		taskStartedAt = Date.now();
		resetCurrentMessage();
		refreshSubscriptionUsage(ctx);
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

		resetCurrentMessage();
		requestRender?.();
	});

	pi.on("turn_end", (_event, ctx) => {
		refreshSubscriptionUsage(ctx);
	});

	pi.on("agent_end", () => {
		if (taskStartedAt) {
			lastRunText = formatElapsed(Date.now() - taskStartedAt);
		}
		taskStartedAt = undefined;
		resetCurrentMessage();
		requestRender?.();
	});
}
