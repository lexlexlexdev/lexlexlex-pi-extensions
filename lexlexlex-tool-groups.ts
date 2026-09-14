/**
 * lexlexlex-tool-groups — fold runs of consecutive tool executions into a single
 * collapsible block, the way compact-ui does, WITHOUT owning any tool.
 *
 * Why this exists: compact-ui groups tool calls by re-registering the seven
 * built-ins with empty renderers, which makes same-name registration clobber
 * pi-code-previews, lexlexlex-tool-render and (through self-healing) fights
 * lexlexlex-permission-gates. This extension never calls `registerTool` — it
 * only wraps the native `ToolExecutionComponent` instances Pi already created
 * and moved into the chat container:
 *
 *   interactive-mode.js:  component.setExpanded(this.toolOutputExpanded);
 *                         this.chatContainer.addChild(component);
 *
 * That call site runs for live streaming AND for history replay (`pi -r`),
 * so resumed sessions get regrouped for free. Every renderer keeps ownership
 * of its own look: lexlexlex cards, pi-code-previews, permission-gates bash,
 * MCP/subagent/custom tools — all of them render unchanged inside the group.
 *
 * Collapsed: one row per tool (the renderer's own first line, so the tool's own
 * dot/label/summary is preserved) plus a "why:" row for risky calls, capped at
 * `collapsedMaxItems` with a "… +N more" tail.
 * Expanded (Ctrl+O — Pi walks `chatContainer.children` calling `setExpanded`):
 * the group propagates expansion to its children, so each tool shows its own
 * full card (args, output previews, diffs) exactly as before.
 *
 * The group is a plain Container child of the chat container, so no anchoring,
 * no AssistantMessageComponent patching, no thinking injection is required: the
 * group simply stays where Pi put the first tool of the run, which is already
 * the correct position relative to the surrounding assistant text.
 *
 * Config (optional): ~/.pi/agent/tool-groups.json
 *   {
 *     "collapsedMaxItems": 5,      // folded window size
 *     "window": "newest",          // "newest" = live stack (old calls drop out)
 *     "keepWhyRows": true,         // keep the renderer's "why:" audit row
 *     "stripChildBackground": true, // remove Pi's toolPending/Success/ErrorBg bands
 *     "unfoldedTools": ["edit", "write"],   // tools never folded (stay live)
 *     "unfoldBashMutations": true,          // mutation shell commands stay live
 *     "unfoldBashPatterns": [],             // extra regex sources for shell detection
 *     "unfoldToolPatterns": []              // extra regex sources for tool names
 *   }
 *
 * Mutations stay outside the fold so renderers that stream diffs in real time
 * (pi-code-previews edits/writes, lexlexlex cards for git/npm/etc.) keep
 * painting the live region untouched.
 *
 * This file is an extension. Keep all logic inside it; the patch lives on
 * globalThis so /reload reuses the original Container methods.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// =============================================================================
// Config
// =============================================================================

type ToolGroupsConfig = {
	collapsedMaxItems: number;
	keepWhyRows: boolean;
	/** "newest" keeps the folded window on the most recent calls (live stack). */
	window: "newest" | "oldest";
	/** Strip Pi's per-tool background (toolPendingBg/toolSuccessBg/toolErrorBg) from child rows. */
	stripChildBackground: boolean;
	/** Tool names that must never be folded (mutations keep their live preview). */
	unfoldedTools: string[];
	/** Keep mutating shell commands out of the fold too. */
	unfoldBashMutations: boolean;
	/** Extra regex sources tested against a bash command. */
	unfoldBashPatterns: string[];
	/** Extra regex sources tested against a tool name. */
	unfoldToolPatterns: string[];
};

const CONFIG_PATH = join(homedir(), ".pi", "agent", "tool-groups.json");
const DEFAULT_CONFIG: ToolGroupsConfig = {
	collapsedMaxItems: 5,
	keepWhyRows: true,
	window: "newest",
	stripChildBackground: true,
	unfoldedTools: ["edit", "write"],
	unfoldBashMutations: true,
	unfoldBashPatterns: [],
	unfoldToolPatterns: [],
};

const config: ToolGroupsConfig = { ...DEFAULT_CONFIG, unfoldedTools: [...DEFAULT_CONFIG.unfoldedTools] };

function loadConfig(): void {
	Object.assign(config, DEFAULT_CONFIG, { unfoldedTools: [...DEFAULT_CONFIG.unfoldedTools] });
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<ToolGroupsConfig>;
		if (typeof parsed.collapsedMaxItems === "number" && Number.isFinite(parsed.collapsedMaxItems)) {
			config.collapsedMaxItems = Math.max(1, Math.floor(parsed.collapsedMaxItems));
		}
		if (typeof parsed.keepWhyRows === "boolean") config.keepWhyRows = parsed.keepWhyRows;
		if (parsed.window === "newest" || parsed.window === "oldest") config.window = parsed.window;
		if (typeof parsed.stripChildBackground === "boolean") config.stripChildBackground = parsed.stripChildBackground;
		if (Array.isArray(parsed.unfoldedTools)) {
			config.unfoldedTools = parsed.unfoldedTools.filter((name): name is string => typeof name === "string");
		}
		if (typeof parsed.unfoldBashMutations === "boolean") config.unfoldBashMutations = parsed.unfoldBashMutations;
		if (Array.isArray(parsed.unfoldBashPatterns)) config.unfoldBashPatterns = parsed.unfoldBashPatterns.filter((p) => typeof p === "string");
		if (Array.isArray(parsed.unfoldToolPatterns)) config.unfoldToolPatterns = parsed.unfoldToolPatterns.filter((p) => typeof p === "string");
	} catch {
		// Missing or malformed config: defaults are fine.
	}
	compiledBash = undefined;
	compiledNames = undefined;
}

// =============================================================================
// Small helpers (theme-safe: render() must never throw)
// =============================================================================

const RAIL_MID = "│  ";
const RAIL_TAIL = "└  ";
const RAIL_WIDTH = 3;

let currentTheme: Theme | undefined;

function fg(color: string, text: string): string {
	try {
		return currentTheme?.fg?.(color, text) ?? text;
	} catch {
		return text;
	}
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}m ${seconds}s`;
}

function safeRender(component: { render: (width: number) => string[] }, width: number): string[] {
	try {
		const lines = component.render(width);
		return Array.isArray(lines) ? lines : [];
	} catch {
		return [];
	}
}

function safeStrip(line: string): string {
	try {
		return stripTerminalSequences(line);
	} catch {
		return line;
	}
}

const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;

/**
 * Drop background SGR parameters, keeping every foreground/attribute code.
 * Pi paints each tool region with theme.bg("toolPendingBg" | "toolSuccessBg" |
 * "toolErrorBg"), so folded rows would otherwise repeat a full-width color band
 * per call. Handles `48;5;N` and `48;2;R;G;B` extended forms.
 */
function stripBackgroundCodes(line: string): string {
	return line.replace(SGR_PATTERN, (_match, rawParams: string) => {
		const parts = rawParams === "" ? ["0"] : rawParams.split(";");
		const kept: string[] = [];
		for (let index = 0; index < parts.length; index++) {
			const code = Number(parts[index]);
			if (code === 48) {
				const mode = Number(parts[index + 1]);
				if (mode === 5) index += 2;
				else if (mode === 2) index += 4;
				continue;
			}
			if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107) || code === 49) continue;
			kept.push(parts[index]!);
		}
		return kept.length > 0 ? `\x1b[${kept.join(";")}m` : "";
	});
}

function prepareRow(line: string): string {
	return config.stripChildBackground ? stripBackgroundCodes(line) : line;
}

/**
 * Collapsed representation of one tool: its renderer's first non-empty line,
 * plus — for risky calls — the renderer's own "why:" audit row, so an approval
 * reason stays visible while the block is folded.
 */
function collapsedRows(child: { render: (width: number) => string[] }, width: number): string[] {
	const lines = safeRender(child, width);
	const visible = lines.filter((line) => safeStrip(line).trim() !== "");
	if (visible.length === 0) return [];

	const rows = [visible[0]!];
	if (config.keepWhyRows) {
		const why = visible.find((line) => /^\s*why:/.test(safeStrip(line)));
		if (why && why !== rows[0]) rows.push(why);
	}
	return rows.map(prepareRow);
}

// =============================================================================
// Mutations stay unfolded
// =============================================================================

/**
 * Shell commands that change state. A mutation is kept out of the fold so the
 * renderer for that tool keeps streaming its live view (diffs, file writes,
 * git output) instead of being replaced by a one-line folded row.
 */
const MUTATION_COMMAND_PATTERNS: RegExp[] = [
	// file system writes
	/\b(rm|rmdir|mv|cp|ln|mkdir|touch|truncate|shred|dd|mkfs(?:\.\w+)?)\b/i,
	/\b(sed\s+-i|tee|patch|unzip|gunzip|tar\b[^\n]*\s-[a-z]*x)/i,
	/(?:^|[^0-9>])>{1,2}(?!&)\s*[\w./~$"']/,
	/\b(sudo|doas)\b/i,
	// permissions, processes, services
	/\b(chmod|chown|chgrp|kill|pkill|killall|systemctl|launchctl|service)\b/i,
	// git
	/\bgit\s+(commit|push|pull|merge|rebase|reset|checkout|switch|restore|clean|stash|apply|am|cherry-pick|revert|tag|init|add|mv|rm|remote\s+(add|remove|set-url))\b/i,
	// package managers / dependency state
	/\b(npm|pnpm|yarn|bun)\s+(install|i|add|remove|uninstall|update|upgrade|link|publish|init)\b/i,
	/\b(pip3?|uv|poetry)\s+(install|uninstall|add|remove|sync|lock|update)\b/i,
	/\b(brew|cargo|gem|composer|go)\s+(install|uninstall|upgrade|remove|add|get|publish)\b/i,
	/\b(apt|apt-get|yum|dnf|pacman|apk)\s+(install|remove|upgrade|update|purge)\b/i,
	// infrastructure
	/\b(docker|podman)\s+(run|rm|rmi|build|push|pull|compose\s+(up|down|build)|stop|kill)\b/i,
	/\b(kubectl|helm)\s+(apply|delete|create|patch|replace|scale|rollout|upgrade|uninstall)\b/i,
	/\b(terraform|pulumi)\s+(apply|destroy|import|state)\b/i,
	/\baws\s+[a-z0-9-]+\s+(create|delete|put|update|modify|terminate|attach|detach)\b/i,
];

let compiledBash: RegExp[] | undefined;
let compiledNames: RegExp[] | undefined;

function compilePatterns(sources: string[]): RegExp[] {
	const compiled: RegExp[] = [];
	for (const source of sources) {
		try {
			compiled.push(new RegExp(source, "i"));
		} catch {
			// Ignore invalid user patterns.
		}
	}
	return compiled;
}

function bashPatterns(): RegExp[] {
	compiledBash ??= compilePatterns(config.unfoldBashPatterns);
	return [...MUTATION_COMMAND_PATTERNS, ...compiledBash];
}

function toolNamePatterns(): RegExp[] {
	compiledNames ??= compilePatterns(config.unfoldToolPatterns);
	return compiledNames;
}

function isMutationCommand(command: unknown): boolean {
	const text = typeof command === "string" ? command : "";
	if (!text) return false;
	return bashPatterns().some((pattern) => pattern.test(text));
}

/**
 * Should this call stay outside the fold? `args` may be empty while a tool call
 * is still streaming, so pi's tool_execution_start event re-checks later and
 * extracts a call that turned out to be a mutation.
 */
function isUnfoldedCall(toolName: unknown, args: any): boolean {
	const name = typeof toolName === "string" ? toolName : "";
	if (!name) return false;
	if (config.unfoldedTools.includes(name)) return true;
	if (toolNamePatterns().some((pattern) => pattern.test(name))) return true;
	if (config.unfoldBashMutations && name === "bash") return isMutationCommand(args?.command);
	return false;
}

/**
 * Child rows for a tool that must never be folded. The call keeps its native
 * live rendering, so we hand back its own lines untouched (background policy
 * still applies).
 */
function isComponentUnfolded(component: any): boolean {
	try {
		return isUnfoldedCall(component?.toolName, component?.args);
	} catch {
		return false;
	}
}

// =============================================================================
// The group component
// =============================================================================

/** Back-pointer so removeChild() can find the group owning a tool. */
const TOOL_PARENT = Symbol.for("lexlexlex.tool-groups.parent");

/**
 * A tool execution is done once Pi has pushed its final (non-partial) result.
 * ToolExecutionComponent keeps no timing fields, so completion is derived from
 * the component's own state and the moment we first observed it finished.
 */
function childFinished(child: any): boolean {
	try {
		return child?.isPartial === false && child?.result !== undefined;
	} catch {
		return true;
	}
}

/**
 * A folded run of tool executions. It is a plain chat-container child, which is
 * what makes Ctrl+O work: Pi's setToolsExpanded() iterates chatContainer
 * children and calls setExpanded() on anything that has the method.
 */
class ToolGroupComponent extends Container {
	endedAt?: number;
	private expandedState = false;
	/**
	 * Timer base for the current burst of calls. Re-based when a new call joins a
	 * run whose previous calls had all finished, so an idle gap between bursts is
	 * not billed to the block.
	 */
	private windowStart = Date.now();
	private windowLastFinish = 0;
	private readonly finishedAt = new WeakMap<object, number>();

	get isSealed(): boolean {
		return this.endedAt !== undefined;
	}

	seal(): void {
		this.endedAt ??= Date.now();
	}

	get expanded(): boolean {
		return this.expandedState;
	}

	setExpanded(expanded: boolean): void {
		this.expandedState = expanded;
		for (const child of this.children) {
			(child as { setExpanded?: (value: boolean) => void }).setExpanded?.(expanded);
		}
		this.invalidate();
	}

	/** Direct children.push: never re-enters the patched Container.addChild. */
	addTool(tool: any): void {
		this.children.push(tool);
		(tool as Record<PropertyKey, unknown>)[TOOL_PARENT] = this;
		// A finished burst followed by new work restarts the clock for that burst.
		const prior = this.children.slice(0, -1);
		if (prior.length > 0 && prior.every((child) => childFinished(child))) {
			this.windowStart = Date.now();
			this.windowLastFinish = 0;
		}
		// Keep a tool added to an already-expanded group consistent with it.
		(tool as { setExpanded?: (value: boolean) => void }).setExpanded?.(this.expandedState);
	}

	removeTool(tool: any): void {
		const index = this.children.indexOf(tool);
		if (index >= 0) this.children.splice(index, 1);
		if ((tool as Record<PropertyKey, unknown>)[TOOL_PARENT] === this) {
			delete (tool as Record<PropertyKey, unknown>)[TOOL_PARENT];
		}
	}

	/** True while at least one child still has a partial (streaming) result. */
	private hasPending(): boolean {
		const now = Date.now();
		for (const child of this.children) {
			if (!childFinished(child)) return true;
			this.noteFinish(child, now);
		}
		return false;
	}

	private noteFinish(child: any, now: number): void {
		let finished = this.finishedAt.get(child);
		if (finished === undefined) {
			finished = now;
			this.finishedAt.set(child, finished);
		}
		this.windowLastFinish = Math.max(this.windowLastFinish, finished);
	}

	private header(): string {
		const count = this.children.length;
		const pending = this.hasPending();
		// Frozen at the last finish while nothing runs; only ticks during real work.
		const elapsed = pending ? Date.now() - this.windowStart : this.windowLastFinish - this.windowStart;
		const label = `${count} ${count === 1 ? "tool" : "tools"} · ${formatDuration(Math.max(0, elapsed))}`;
		const working = pending || (this.children.length === 0 && !this.isSealed);
		const icon = working ? fg("accent", "⏺") : fg("dim", "✓");
		return `${icon} ${fg("muted", label)}`;
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - RAIL_WIDTH);
		const lines: string[] = [this.header()];

		if (this.expandedState) {
			for (const child of this.children) {
				for (const line of safeRender(child, width)) lines.push(prepareRow(line));
			}
			return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
		}

		// Build rows first so the last emitted row can use the tail rail.
		type Row = { rail: "mid" | "tail" | "cont"; text: string };
		const rows: Row[] = [];
		const total = this.children.length;
		const cap = Math.max(1, config.collapsedMaxItems);
		// "newest": keep the window on the most recent calls so the fold behaves
		// like a live stack — new calls appear at the bottom, old ones drop out.
		const windowStart = config.window === "oldest" ? 0 : Math.max(0, total - cap);
		const windowEnd = config.window === "oldest" ? Math.min(total, cap) : total;

		const earlier = windowStart;
		if (earlier > 0) rows.push({ rail: "mid", text: fg("muted", `… +${earlier} earlier`) });

		for (let index = windowStart; index < windowEnd; index++) {
			const childRows = collapsedRows(this.children[index]!, inner);
			childRows.forEach((text, rowIndex) => {
				rows.push({ rail: rowIndex === 0 ? "mid" : "cont", text });
			});
		}

		const later = total - windowEnd;
		if (later > 0) rows.push({ rail: "mid", text: fg("muted", `… +${later} more`) });
		if (rows.length > 0) rows[rows.length - 1]!.rail = "tail";

		for (const row of rows) {
			const rail = row.rail === "tail" ? RAIL_TAIL : RAIL_MID;
			lines.push(fg("dim", rail) + truncateToWidth(row.text, inner, "…"));
		}
		return lines;
	}
}

// =============================================================================
// Container prototype patch
// =============================================================================

type PatchState = {
	original: { addChild: Function; removeChild: Function; clear: Function };
	installed: { addChild: Function; removeChild: Function; clear: Function };
	activeGroup?: ToolGroupComponent;
	/** toolCallId → its component + the container it currently lives in. */
	owners: Map<string, { component: any; parent: any }>;
};

const PATCH_KEY = Symbol.for("lexlexlex.tool-groups.patch");
const COMPACT_UI_PATCH_KEY = Symbol.for("compact-ui.group-patch");

function isGroupable(value: any): value is ToolExecutionComponent {
	return value instanceof ToolExecutionComponent;
}

/**
 * Walk back past spacing and assistant-message components: a run must survive the
 * thinking-only assistant messages Pi inserts between tool batches of one turn.
 * Any assistant message carrying visible text already sealed the run through the
 * message_update handler, so an unsealed group here implies no text was emitted.
 */
function previousSibling(children: any[], start: number): { child: any; index: number } | undefined {
	for (let index = start; index >= 0; index--) {
		const child = children[index];
		if (child instanceof Spacer || child instanceof AssistantMessageComponent) continue;
		return { child, index };
	}
	return undefined;
}

/** Keep the group adjacent to the newest tool so later text lands after it. */
function moveToTail(children: any[], group: ToolGroupComponent): void {
	const index = children.indexOf(group);
	if (index < 0 || index === children.length - 1) return;
	children.splice(index, 1);
	children.push(group);
}

function groupTool(parent: any, component: ToolExecutionComponent, state: PatchState): void {
	const children = parent?.children;
	if (!Array.isArray(children)) return;
	const index = children.indexOf(component);
	if (index < 0) return;

	// Mutations (edit/write, git/npm/rm/… shell commands) stay outside the fold so
	// their renderers keep streaming live output. They also close the open run, so
	// the transcript reads [folded work][live mutation][folded work].
	if (isComponentUnfolded(component)) {
		state.activeGroup?.seal();
		state.activeGroup = undefined;
		parent.invalidate?.();
		return;
	}

	const sibling = previousSibling(children, index - 1);
	const previous = sibling?.child;

	// Previous sibling is an open group → join it.
	if (previous instanceof ToolGroupComponent && !previous.isSealed) {
		children.splice(index, 1);
		previous.addTool(component);
		moveToTail(children, previous);
		state.activeGroup = previous;
		parent.invalidate?.();
		return;
	}

	// Previous sibling is a bare (foldable) tool → fold both into a new group.
	if (sibling && isGroupable(previous) && !isComponentUnfolded(previous)) {
		const group = new ToolGroupComponent();
		group.addTool(previous);
		group.addTool(component);
		children[sibling.index] = group;
		children.splice(index, 1);
		state.activeGroup = group;
		parent.invalidate?.();
		return;
	}

	// Otherwise wrap this tool on its own, still open for the next one to join.
	const group = new ToolGroupComponent();
	group.addTool(component);
	children[index] = group;
	state.activeGroup = group;
	parent.invalidate?.();
}

function installGrouping(): void {
	const host = globalThis as any;
	// compact-ui owns grouping (and neuters native renderers) when present.
	if (host[COMPACT_UI_PATCH_KEY]) return;

	const prototype = Container.prototype as any;
	const previous = host[PATCH_KEY] as PatchState | undefined;
	// /reload keeps our methods on the prototype while the module state resets, so
	// unwrap back to the true originals before installing fresh closures.
	const original = {
		addChild: previous && prototype.addChild === previous.installed.addChild ? previous.original.addChild : prototype.addChild,
		removeChild:
			previous && prototype.removeChild === previous.installed.removeChild ? previous.original.removeChild : prototype.removeChild,
		clear: previous && prototype.clear === previous.installed.clear ? previous.original.clear : prototype.clear,
	};

	const state: PatchState = { original, installed: undefined as any, owners: new Map() };
	state.installed = {
		addChild: function (this: any, component: any) {
			const result = state.original.addChild.call(this, component);
			if (
				component instanceof ToolExecutionComponent &&
				!(this instanceof ToolExecutionComponent) &&
				!(this instanceof ToolGroupComponent)
			) {
				groupTool(this, component, state);
				const id = (component as any).toolCallId;
				if (typeof id === "string") state.owners.set(id, { component, parent: this });
			}
			return result;
		},
		removeChild: function (this: any, component: any) {
			const id = (component as any)?.toolCallId;
			if (typeof id === "string" && state.owners.get(id)?.component === component) state.owners.delete(id);
			const group = (component as Record<PropertyKey, unknown>)?.[TOOL_PARENT];
			if (group instanceof ToolGroupComponent && group.children.includes(component)) {
				group.removeTool(component);
				if (group.children.length === 0) state.activeGroup = undefined;
				this.invalidate?.();
				return;
			}
			return state.original.removeChild.call(this, component);
		},
		clear: function (this: any) {
			state.activeGroup = undefined;
			state.owners.clear();
			return state.original.clear.call(this);
		},
	};

	prototype.addChild = state.installed.addChild;
	prototype.removeChild = state.installed.removeChild;
	prototype.clear = state.installed.clear;
	host[PATCH_KEY] = state;
}

function sealActiveGroup(): void {
	const state = (globalThis as any)[PATCH_KEY] as PatchState | undefined;
	state?.activeGroup?.seal();
	if (state) state.activeGroup = undefined;
}

/**
 * tool_execution_start carries the finished arguments, which addChild did not
 * have while the call was still streaming. If it turns out to be a mutation the
 * fold already swallowed, pull the component back out next to its group so its
 * live renderer takes over again.
 */
function unfoldLateMutation(toolCallId: unknown): void {
	const state = (globalThis as any)[PATCH_KEY] as PatchState | undefined;
	if (!state || typeof toolCallId !== "string") return;
	const entry = state.owners.get(toolCallId);
	if (!entry) return;

	const { component, parent } = entry;
	const children = parent?.children;
	if (!Array.isArray(children)) return;
	const groupIndex = children.findIndex(
		(child: any) => child instanceof ToolGroupComponent && child.children.includes(component),
	);
	if (groupIndex < 0) return;

	const group = children[groupIndex] as ToolGroupComponent;
	group.removeTool(component);
	group.seal();
	// The fold cannot stay "open" once a live mutation sits right after it.
	state.activeGroup = undefined;

	if (group.children.length === 0) {
		children.splice(groupIndex, 1, component);
	} else {
		children.splice(groupIndex + 1, 0, component);
	}
	parent.invalidate?.();
}

// =============================================================================
// Extension entry
// =============================================================================

export default function lexlexlexToolGroups(pi: ExtensionAPI) {
	loadConfig();
	installGrouping();

	pi.on("session_start", async (_event, ctx) => {
		currentTheme = ctx.ui.theme;
		installGrouping();
	});

	// A user turn is a hard boundary.
	pi.on("message_start", async (event) => {
		const role = (event.message as any)?.role;
		if (role === "user") sealActiveGroup();
	});

	// Visible assistant text closes the run: later tool calls start a new block.
	// Thinking-only messages deliberately do NOT seal, so a long tool loop stays
	// one block.
	pi.on("message_update", async (event) => {
		const message = event.message as any;
		if (!message || message.role !== "assistant") return;
		const streamEvent = (event as any).assistantMessageEvent as any;
		const streamType = String(streamEvent?.type ?? "");
		if (!streamType.startsWith("text_")) return;
		const content = Array.isArray(message.content) ? message.content : [];
		const contentIndex = Number(streamEvent?.contentIndex);
		const block = Number.isInteger(contentIndex) ? content[contentIndex] : undefined;
		const text = block?.type === "text" ? String(block.text ?? "").trim() : "";
		if (text.length > 0) sealActiveGroup();
	});

	pi.on("agent_end", async () => {
		sealActiveGroup();
	});

	// Late mutation detection: args are only complete once execution starts.
	pi.on("tool_execution_start", async (event) => {
		const toolName = (event as any)?.toolName;
		const args = (event as any)?.args;
		if (!isUnfoldedCall(toolName, args)) return;
		unfoldLateMutation((event as any)?.toolCallId);
	});
}
