/**
 * Shared tool-card renderers for lexlexlex extensions.
 *
 * Extracted from lexlexlex-tool-render.ts so that permission-gates (which owns
 * the overridden `bash` tool) and tool-render (which owns the other built-ins)
 * can attach the exact same card UI without duplicating code.
 */

import type { AgentToolResult, Theme, ToolRenderContext, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isAbsolute, relative } from "node:path";

export type CardToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

const TARGET_WIDTH = 92;
const OUTPUT_PREVIEW_LIMIT = 2600;

const NON_SAFE_BASH_PATTERNS: RegExp[] = [
	/\b(sudo|su|doas)\b/i,
	/\brm\s+.*-(?:[^\n\r]*r|[^\n\r]*f)[^\n\r]*/i,
	/\bfind\b[^\n\r]*\b-delete\b/i,
	/\b(dd|mkfs(?:\.\w+)?)\b/i,
	/\b(curl|wget)\b[^\n\r|]*\|\s*(sh|bash|zsh)\b/i,
	/\bbash\s*<\(\s*(curl|wget)\b/i,
	/\b(drop\s+table|drop\s+database|truncate\s+table)\b/i,
	/(?:^|[\s'"=:/])(?:\.env(?:[.\s'"/]|$)|[^\s'";&|]*\.pem\b|~\/(?:\.ssh|\.aws|\.config\/gh)|\$HOME\/(?:\.ssh|\.aws|\.config\/gh)|\$\{HOME\}\/(?:\.ssh|\.aws|\.config\/gh)|\/etc\/|\/usr\/local\/etc\/)/i,
	/(?:^|[;&|\s])(?:printenv|env)(?:$|[\s;&|])/i,
	/\b(apt|apt-get|yum|dnf|brew)\s+(install|remove|upgrade|uninstall)\b/i,
	/\b(npm|pnpm|yarn)\s+.*\s-g\b/i,
	/\b(kill\s+-9|pkill|killall)\b/i,
	/\bsed\s+-i\b/i,
	/\bgit\s+(?:commit|push|reset\s+--hard|clean\s+-[df]|checkout\s+--|restore\s+.*(?:--staged\s+)?\.)\b/i,
];

type RenderState = {
	startedAt?: number;
	endedAt?: number;
	interval?: NodeJS.Timeout;
};

function view(content: string) {
	return new Text(content, 0, 0);
}

function normalize(value: unknown) {
	return String(value ?? "").replace(/\s+/g, " ").trim();
}

function cut(value: unknown, max = TARGET_WIDTH) {
	const text = normalize(value);
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function safeJson(value: unknown) {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function resultText(result: AgentToolResult<unknown>) {
	return (result.content ?? [])
		.map((part) => {
			if (part.type === "text") return part.text;
			if (part.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function linesOf(text: string) {
	return text.trim() ? text.split("\n").length : 0;
}

function sizeOf(text: string) {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function plural(count: number, unit: string) {
	return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

function formatDuration(ms: number) {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}m ${seconds}s`;
}

function getState(context: ToolRenderContext): RenderState {
	return context.state as RenderState;
}

function ensureStarted(context: ToolRenderContext) {
	const state = getState(context);
	state.startedAt ??= Date.now();
	if (!state.interval) {
		state.interval = setInterval(context.invalidate, 250);
	}
	return state.startedAt;
}

function finishTiming(context: ToolRenderContext) {
	const state = getState(context);
	state.startedAt ??= Date.now();
	state.endedAt ??= Date.now();
	if (state.interval) {
		clearInterval(state.interval);
		state.interval = undefined;
	}
	return formatDuration(state.endedAt - state.startedAt);
}

function elapsedTiming(context: ToolRenderContext) {
	const startedAt = ensureStarted(context);
	return formatDuration(Date.now() - startedAt);
}

function isNonSafeBashCommand(command: unknown) {
	const cmd = normalize(command);
	return NON_SAFE_BASH_PATTERNS.some((pattern) => pattern.test(cmd));
}

function isNonSafeTool(tool: CardToolName, args: any) {
	return tool === "bash" && isNonSafeBashCommand(args?.command);
}

/** Agent-provided explanation for the call, if the tool schema carries one. */
function explanationFor(args: any): string | undefined {
	const value = typeof args?.explanation === "string" ? args.explanation.trim() : "";
	return value ? value : undefined;
}

function dot(theme: Theme, state: "idle" | "ok" | "err" = "idle", nonSafe = false) {
	if (state === "err") return theme.fg("error", "●");
	if (nonSafe) return theme.fg("warning", "●");
	if (state === "ok") return theme.fg("success", "●");
	return theme.fg("accent", "●");
}

function dim(theme: Theme, text: string) {
	return theme.fg("muted", text);
}

function typeLabel(tool: CardToolName) {
	switch (tool) {
		case "bash":
			return "sh";
		case "read":
			return "read";
		case "write":
			return "write";
		case "edit":
			return "edit";
		case "ls":
			return "ls";
		case "grep":
			return "grep";
		case "find":
			return "find";
	}
}

function callVerb(tool: CardToolName) {
	switch (tool) {
		case "bash":
			return "run";
		case "read":
			return "read";
		case "ls":
			return "list";
		case "grep":
			return "scan";
		case "find":
			return "match";
		case "edit":
			return "patch";
		case "write":
			return "write";
	}
}

function resultVerb(tool: CardToolName, outputLines: number, isError: boolean) {
	if (isError) return "fail";
	switch (tool) {
		case "bash":
			return "done";
		case "read":
			return "read";
		case "ls":
			return outputLines > 0 ? "list" : "empty";
		case "grep":
		case "find":
			return outputLines > 0 ? "hit" : "miss";
		case "edit":
		case "write":
			return "saved";
	}
}

function pathRelativeToSession(pathValue: unknown, cwd: string, fallback = ".") {
	const pathText = normalize(pathValue) || fallback;
	if (!pathText || pathText === ".") return ".";
	if (!isAbsolute(pathText)) return pathText;
	return relative(cwd, pathText) || ".";
}
function targetFor(tool: CardToolName, args: any, cwd: string) {
	switch (tool) {
		case "bash":
			return args?.command || "shell";
		case "read":
		case "edit":
		case "write":
			return pathRelativeToSession(args?.path, cwd, "file");
		case "ls":
			return pathRelativeToSession(args?.path, cwd);
		case "grep": {
			const parts = [];
			if (args?.pattern) parts.push(`/${args.pattern}/`);
			if (args?.glob) parts.push(args.glob);
			if (args?.path) parts.push(`in ${pathRelativeToSession(args.path, cwd)}`);
			return parts.join(" ") || "content";
		}
		case "find": {
			const parts = [];
			if (args?.pattern) parts.push(args.pattern);
			if (args?.path) parts.push(`in ${pathRelativeToSession(args.path, cwd)}`);
			return parts.join(" ") || "files";
		}
	}
}

function frame(theme: Theme, tool: CardToolName, target: string, state: "idle" | "ok" | "err", detail?: string, nonSafe = false, why?: string) {
	const titleColor = nonSafe && state !== "err" ? "warning" : "toolTitle";
	const outputColor = nonSafe && state !== "err" ? "warning" : "toolOutput";
	const kind = theme.fg(titleColor, typeLabel(tool).padEnd(5));
	const main = theme.fg(outputColor, cut(target));
	// Collapsed audit trail: risky commands keep their stated reason visible
	// without expanding. Safe commands stay one-liners.
	const whyLine = nonSafe && why ? `\n  ${dim(theme, `why: ${cut(why)}`)}` : "";
	const sub = detail ? `\n  ${dim(theme, detail)}` : "";
	return `${dot(theme, state, nonSafe)} ${kind} ${main}${whyLine}${sub}`;
}

function meta(theme: Theme, items: Array<string | undefined | false>) {
	const body = items.filter(Boolean).join(theme.fg("dim", " · ")) || "ok";
	return dim(theme, body);
}

function rawSection(theme: Theme, label: string, body: string, color: "muted" | "toolOutput" = "toolOutput") {
	return `${theme.fg("dim", label.toUpperCase())}\n${theme.fg(color, body)}`;
}

export function cardRenderCall(tool: CardToolName, args: any, theme: Theme, context: ToolRenderContext) {
	// Pi composes renderCall + renderResult in the same row. Once a final result
	// exists, let renderResult own the whole card so the command is not repeated.
	if (!context.isPartial) return view("");

	const nonSafe = isNonSafeTool(tool, args);
	const detail = `${nonSafe ? "non-safe · " : ""}${callVerb(tool)} · ${elapsedTiming(context)}`;
	const explanation = explanationFor(args);
	const card = frame(theme, tool, targetFor(tool, args, context.cwd), "idle", detail, nonSafe, context.expanded ? undefined : explanation);
	if (!context.expanded) return view(card);

	return view([
		card,
		explanation ? `\n${rawSection(theme, "why", explanation, "muted")}` : "",
		rawSection(theme, "args", safeJson(args), "muted"),
	].filter(Boolean).join("\n"));
}

export function cardRenderResult(tool: CardToolName, result: AgentToolResult<unknown>, _options: ToolRenderResultOptions, theme: Theme, context: ToolRenderContext) {
	// While running, renderCall owns the single live card. The final result
	// replaces it, which avoids duplicated command/path rows.
	if (context.isPartial) return view("");

	const output = resultText(result);
	const count = linesOf(output);
	const isError = Boolean(context.isError);
	const duration = finishTiming(context);
	const nonSafe = isNonSafeTool(tool, context.args);
	const detail = `${nonSafe ? "non-safe · " : ""}${resultVerb(tool, count, isError)} · ${meta(theme, [count ? plural(count, "line") : undefined, output ? sizeOf(output) : undefined, duration])}`;
	const explanation = explanationFor(context.args);
	const card = frame(
		theme,
		tool,
		targetFor(tool, context.args, context.cwd),
		isError ? "err" : "ok",
		detail,
		nonSafe,
		context.expanded ? undefined : explanation,
	);

	if (!context.expanded) return view(card);

	const raw = output.trim() || safeJson(result.details ?? {});
	const preview = raw.length > OUTPUT_PREVIEW_LIMIT ? `${raw.slice(0, OUTPUT_PREVIEW_LIMIT)}\n…` : raw;

	return view([
		card,
		explanation ? `\n${rawSection(theme, "why", explanation, "muted")}` : "",
		rawSection(theme, "args", safeJson(context.args), "muted"),
		"",
		rawSection(theme, "output", preview || "No output"),
	].filter(Boolean).join("\n"));
}
