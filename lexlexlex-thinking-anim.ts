/**
 * lexlexlex-thinking-anim — keep the collapsed "Thinking..." label alive while
 * the model is still thinking, instead of leaving a dead static line in chat.
 *
 * Why this exists: with `hideThinkingBlock: true`, every assistant message renders
 * its hidden thinking run as one static italic line ("Thinking..."), so a long
 * reasoning phase looks like the agent froze. Pi already repaints roughly every
 * 80ms while streaming (the working-row loader ticks `requestRender`), so the
 * animation is driven purely by wall-clock time inside `render()` — no timers, no
 * TUI handle, no requestRender plumbing, no interference with the working row.
 *
 * How it hooks in: `AssistantMessageComponent.updateContent` builds that line as
 * `MouseRegion(child = Text(label))`, and `MouseRegion.child` is a public field, so
 * we call the original and then swap the inner Text for a self-updating one.
 * Streaming state comes from the component itself (`isStreaming`, set by
 * `updateContent(message, true)` during streaming and `false` when the message
 * finishes), so a line has three states:
 *   - reasoning now      -> animated pulse + "· 1,240 chars · 2 runs · 12s"
 *   - reasoning finished -> "Thought for 7s · 2 runs" (duration frozen the moment
 *                           thinking stopped, so it never keeps ticking)
 *   - resumed session    -> "Thought · 2 runs" (nothing is persisted, so a reloaded
 *                           session has no timing data; set `finishedUnknownTemplate`
 *                           to "" to fall back to Pi's own label instead)
 *
 * Roll-up: Pi emits one label per reasoning run, so a tool loop stacks them between
 * tool cards ("Thought for 7s", tool, "Thought for 3s", tool, ...). Every run of one
 * user exchange is instead rolled into a single line that walks down the exchange:
 * only the newest message with reasoning carries it, earlier ones render nothing and
 * their spacer goes with them. Set `rollUpTurns: false` for per-run lines again.
 *
 * Deliberately no persistence: appending durations to the session would put one
 * custom node per assistant message into /tree and into every fork of it.
 *
 * Only the hidden (collapsed) label is touched. With `hideThinkingBlock: false`
 * the run renders as Markdown, so there is no Text to swap and nothing changes.
 *
 * Config (optional): ~/.pi/agent/thinking-anim.json
 *   {
 *     "enabled": true,
 *     "frames": ["·", "•", "●", "•"],          // pulse frames
 *     "colors": ["dim", "muted", "accent", "muted"],
 *     "intervalMs": 120,
 *     "showElapsed": true,                    // "· 12s"
 *     "showChars": true,                      // "· 1,240 chars"
 *     "separator": " · ",
 *     "finishedTemplate": "Thought for {duration}",   // after reasoning
 *     "finishedUnknownTemplate": "Thought",           // resumed sessions; "" = Pi's label
 *     "rollUpTurns": true,                    // one line per user exchange
 *     "showRuns": true,                       // "· 2 runs"
 *     "runsMin": 2                            // ...from this many runs on
 *   }
 *
 * NOTE: frames advance only when Pi repaints. While streaming that is guaranteed
 * by the working-row loader; if some extension hides it (`setWorkingVisible(false)`)
 * the pulse simply advances on whatever repaints still happen.
 *
 * This file is an extension. Keep all logic inside it; the patch lives on
 * globalThis so /reload unwraps the previous wrapper instead of stacking.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	SkillInvocationMessageComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, Spacer, Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// =============================================================================
// Config
// =============================================================================

type ThinkingAnimConfig = {
	enabled: boolean;
	frames: string[];
	colors: string[];
	intervalMs: number;
	showElapsed: boolean;
	showChars: boolean;
	separator: string;
	/** Finished-run label; `{duration}` becomes "7s" / "1m 30s". */
	finishedTemplate: string;
	/** Label when no duration was measured (resumed sessions). Empty = Pi's own label. */
	finishedUnknownTemplate: string;
	/** Roll every reasoning run of one user exchange (tool loop included) into one line. */
	rollUpTurns: boolean;
	/** Show "· 2 runs" next to the metrics. */
	showRuns: boolean;
	/** Minimum runs before the count is shown (0 = always, 1 = also for a single run). */
	runsMin: number;
};

const CONFIG_PATH = join(homedir(), ".pi", "agent", "thinking-anim.json");
const DEFAULT_CONFIG: ThinkingAnimConfig = {
	enabled: true,
	frames: ["·", "•", "●", "•"],
	colors: ["dim", "muted", "accent", "muted"],
	intervalMs: 120,
	showElapsed: true,
	showChars: true,
	separator: " · ",
	finishedTemplate: "Thought for {duration}",
	finishedUnknownTemplate: "Thought",
	rollUpTurns: true,
	showRuns: true,
	runsMin: 2,
};

const config: ThinkingAnimConfig = { ...DEFAULT_CONFIG, frames: [...DEFAULT_CONFIG.frames], colors: [...DEFAULT_CONFIG.colors] };

function loadConfig(): void {
	Object.assign(config, DEFAULT_CONFIG, {
		frames: [...DEFAULT_CONFIG.frames],
		colors: [...DEFAULT_CONFIG.colors],
	});
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<ThinkingAnimConfig>;
		if (typeof parsed.enabled === "boolean") config.enabled = parsed.enabled;
		if (Array.isArray(parsed.frames)) {
			const frames = parsed.frames.filter((frame): frame is string => typeof frame === "string");
			if (frames.length > 0) config.frames = frames;
		}
		if (Array.isArray(parsed.colors)) {
			const colors = parsed.colors.filter((color): color is string => typeof color === "string" && color.length > 0);
			if (colors.length > 0) config.colors = colors;
		}
		if (typeof parsed.intervalMs === "number" && Number.isFinite(parsed.intervalMs) && parsed.intervalMs > 0) {
			config.intervalMs = Math.max(16, Math.floor(parsed.intervalMs));
		}
		if (typeof parsed.showElapsed === "boolean") config.showElapsed = parsed.showElapsed;
		if (typeof parsed.showChars === "boolean") config.showChars = parsed.showChars;
		if (typeof parsed.separator === "string") config.separator = parsed.separator;
		if (typeof parsed.finishedTemplate === "string" && parsed.finishedTemplate.length > 0) {
			config.finishedTemplate = parsed.finishedTemplate;
		}
		if (typeof parsed.finishedUnknownTemplate === "string") config.finishedUnknownTemplate = parsed.finishedUnknownTemplate;
		if (typeof parsed.rollUpTurns === "boolean") config.rollUpTurns = parsed.rollUpTurns;
		if (typeof parsed.showRuns === "boolean") config.showRuns = parsed.showRuns;
		if (typeof parsed.runsMin === "number" && Number.isFinite(parsed.runsMin)) {
			config.runsMin = Math.max(0, Math.floor(parsed.runsMin));
		}
	} catch {
		// Missing or malformed config: defaults are fine.
	}
}

// =============================================================================
// Theme access (render() must never throw, so every theme call is guarded)
// =============================================================================

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
let currentTheme: Theme | undefined;

function refreshTheme(ctx?: ExtensionContext): void {
	try {
		const fromCtx = ctx?.ui?.theme;
		if (fromCtx) currentTheme = fromCtx;
	} catch {
		// ctx is invalidated after session-replacing dialogs; the cached theme is fine.
	}
	if (currentTheme) return;
	try {
		const global = (globalThis as Record<symbol, unknown>)[THEME_KEY];
		if (global) currentTheme = global as Theme;
	} catch {
		// Leave it undefined: labels fall back to unstyled text.
	}
}

function tint(color: string, text: string): string {
	if (!currentTheme) return text;
	try {
		return (currentTheme as any).fg(color, text);
	} catch {
		return text;
	}
}

function italic(text: string): string {
	if (!currentTheme) return text;
	try {
		return (currentTheme as any).italic(text);
	} catch {
		return text;
	}
}

// =============================================================================
// Message analysis
// =============================================================================

/**
 * Thinking runs in the message, in Pi's own rendering order: consecutive thinking
 * blocks joined, empty runs dropped (Pi only increments its run index for
 * non-empty runs, so our ordinals line up with the labels it creates).
 */
type RunAnalysis = { chars: number[]; textAfterLastRun: boolean };

function analyze(message: any): RunAnalysis {
	const content: any[] = Array.isArray(message?.content) ? message.content : [];
	const chars: number[] = [];
	let textAfterLastRun = false;

	for (let i = 0; i < content.length; i++) {
		const type = content[i]?.type;
		if (type === "thinking") {
			let run = 0;
			while (i < content.length && content[i]?.type === "thinking") {
				run += String(content[i].thinking ?? "").trim().length;
				i++;
			}
			i--;
			if (run > 0) {
				chars.push(run);
				textAfterLastRun = false;
			}
			continue;
		}
		if (type === "text") {
			textAfterLastRun = String(content[i].text ?? "").trim().length > 0;
			continue;
		}
		// Tool calls and anything else end the reasoning phase.
		textAfterLastRun = true;
	}

	return { chars, textAfterLastRun };
}

/**
 * Live run clock per assistant message. `doneDurations` remembers how long each run
 * that already finished took, so the label can freeze at "Thought for 7s" instead of
 * either ticking forever or forgetting the number.
 */
const liveClocks = new WeakMap<object, { ordinal: number; startedAt: number }>();
const doneDurations = new WeakMap<object, Map<number, number>>();

function labelOf(owner: any): string {
	const label = owner?.hiddenThinkingLabel;
	return typeof label === "string" && label.length > 0 ? label : "Thinking...";
}

function isLive(owner: any, runs: RunAnalysis, ordinal: number): boolean {
	return (
		config.enabled &&
		owner?.isStreaming === true &&
		runs.chars.length > 0 &&
		ordinal === runs.chars.length - 1 &&
		!runs.textAfterLastRun
	);
}

function liveElapsedMs(owner: any, ordinal: number): number | undefined {
	const clock = liveClocks.get(owner);
	if (!clock || clock.ordinal !== ordinal) return undefined;
	return Math.max(0, Date.now() - clock.startedAt);
}

function recordDone(owner: any, ordinal: number, durationMs: number): void {
	let done = doneDurations.get(owner);
	if (!done) {
		done = new Map();
		doneDurations.set(owner, done);
	}
	// First freeze wins: the moment thinking stopped is the truth, not a later repaint.
	if (!done.has(ordinal)) done.set(ordinal, Math.max(0, durationMs));
}

function syncRunState(owner: any, runs: RunAnalysis): void {
	const ordinal = runs.chars.length - 1;
	const clock = liveClocks.get(owner);

	if (isLive(owner, runs, ordinal)) {
		if (!clock) {
			liveClocks.set(owner, { ordinal, startedAt: Date.now() });
			return;
		}
		if (clock.ordinal !== ordinal) {
			// A previous run ended between two deltas: freeze it before tracking this one.
			recordDone(owner, clock.ordinal, Date.now() - clock.startedAt);
			liveClocks.set(owner, { ordinal, startedAt: Date.now() });
		}
		return;
	}

	if (clock) {
		// Thinking just stopped: answer text started, the message ended, or it aborted.
		recordDone(owner, clock.ordinal, Date.now() - clock.startedAt);
		liveClocks.delete(owner);
	}
}

function elapsedSeconds(owner: any, ordinal: number): number {
	return Math.floor((liveElapsedMs(owner, ordinal) ?? 0) / 1000);
}

/** "7s", or "1m 30s" once past a minute. Sub-second runs read as "1s", never "0s". */
function formatDuration(durationMs: number): string {
	const seconds = Math.max(1, Math.round(durationMs / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function formatCount(value: number): string {
	return value.toLocaleString("en-US");
}

// =============================================================================
// Animated label component
// =============================================================================

function shouldShowRuns(count: number | undefined): boolean {
	if (count === undefined || !config.showRuns) return false;
	return config.runsMin === 0 ? count > 0 : count >= config.runsMin;
}

function formatRuns(count: number): string {
	return `${count} run${count === 1 ? "" : "s"}`;
}

function metricSuffix(metrics: string[]): string {
	return metrics.length > 0 ? config.separator + tint("dim", metrics.join(" · ")) : "";
}

/** `⠹ Thinking... · 1,240 chars · 2 runs · 12s` — the pulse plus whatever is live. */
function liveLine(staticLabel: string, chars: number, runCount: number | undefined, elapsed: number): string {
	const frames = config.frames.length > 0 ? config.frames : DEFAULT_CONFIG.frames;
	const colors = config.colors.length > 0 ? config.colors : DEFAULT_CONFIG.colors;
	const tick = Math.floor(Date.now() / Math.max(16, config.intervalMs));
	const frame = frames[tick % frames.length] ?? "";
	const dot = tint(colors[tick % colors.length] ?? "dim", frame);

	const metrics: string[] = [];
	if (config.showChars) metrics.push(`${formatCount(chars)} chars`);
	if (shouldShowRuns(runCount)) metrics.push(formatRuns(runCount as number));
	// Sub-second reasoning is the common case for cached prompts: "0s" is noise.
	if (config.showElapsed && elapsed >= 1) metrics.push(`${elapsed}s`);

	return `${dot} ${staticLabel}${metricSuffix(metrics)}`;
}

/** `Thought for 7s · 2 runs` — duration and count frozen at the moment reasoning stopped. */
function finishedLine(staticLabel: string, totalMs: number | undefined, runCount: number | undefined): string {
	const runsSuffix = shouldShowRuns(runCount) ? metricSuffix([formatRuns(runCount as number)]) : "";
	// `undefined` means "nothing measured" (history); a measured 0ms still rounds up to 1s.
	if (totalMs !== undefined) {
		const text = config.finishedTemplate.replace("{duration}", formatDuration(totalMs));
		return italic(tint("thinkingText", text)) + runsSuffix;
	}
	if (config.finishedUnknownTemplate.length > 0) {
		return italic(tint("thinkingText", config.finishedUnknownTemplate)) + runsSuffix;
	}
	return staticLabel;
}

/** Totals for the whole exchange: completed runs plus the one currently reasoning. */
function composeRollUp(batch: Batch, staticLabel: string): string {
	let totalMs = 0;
	let chars = 0;
	let measured = false;
	for (const run of batch.runs.values()) {
		if (run.ms !== undefined) {
			measured = true;
			totalMs += run.ms;
		}
		chars += run.chars;
	}

	if (batch.liveKey !== undefined && batch.liveStart !== undefined) {
		const elapsed = Math.floor((totalMs + Math.max(0, Date.now() - batch.liveStart)) / 1000);
		return liveLine(staticLabel, chars, batch.runs.size, elapsed);
	}
	return finishedLine(staticLabel, measured ? totalMs : undefined, batch.runs.size);
}

function compose(owner: any, ordinal: number): string {
	const label = labelOf(owner);
	const staticLabel = italic(tint("thinkingText", label));

	if (config.rollUpTurns) {
		const batch = batches.get(exchangeOf(owner));
		// Only the exchange's summary line renders; every other label is a leftover.
		if (!batch || batch.owner !== owner || batch.ownerOrdinal !== ordinal) return "";
		return composeRollUp(batch, staticLabel);
	}

	const runs = analyze(owner?.lastMessage);
	if (isLive(owner, runs, ordinal)) {
		return liveLine(staticLabel, runs.chars[ordinal] ?? 0, undefined, elapsedSeconds(owner, ordinal));
	}

	const done = doneDurations.get(owner)?.get(ordinal);
	if (done !== undefined) return finishedLine(staticLabel, done, undefined);
	if (config.finishedUnknownTemplate.length > 0) {
		return italic(tint("thinkingText", config.finishedUnknownTemplate));
	}
	return staticLabel;
}

/**
 * Drop-in replacement for Pi's hidden-thinking label Text. Pi rebuilds the label
 * on every streaming delta, so this instance is short-lived; recomputing the line
 * per render is what makes the pulse move without owning a timer.
 */
class AnimatedThinkingLabel extends Text {
	private readonly owner: AssistantMessageComponent;
	private readonly ordinal: number;
	private composed: string | undefined;

	constructor(owner: AssistantMessageComponent, ordinal: number, paddingX: number) {
		super("", paddingX, 0);
		this.owner = owner;
		this.ordinal = ordinal;
	}

	render(width: number): string[] {
		let next: string;
		try {
			next = compose(this.owner, this.ordinal);
		} catch {
			// Theme or message shape surprised us: fall back to Pi's own label.
			next = labelOf(this.owner);
		}
		if (next !== this.composed) {
			this.composed = next;
			this.setText(next);
		}
		return super.render(width);
	}

	invalidate(): void {
		this.composed = undefined;
		super.invalidate();
	}
}

// =============================================================================
// Exchange roll-up
// =============================================================================

/**
 * Pi emits one label per reasoning run, so a tool loop stacks them between tool
 * cards. Instead, each run is counted into the user exchange it belongs to and only
 * the newest message with reasoning carries the line — the previous carrier drops
 * its labels. An exchange is delimited by user messages, which Pi adds to the chat
 * container itself and a message component cannot see, so we watch
 * `Container.addChild` (the technique lexlexlex-tool-groups uses too).
 */
type BatchRun = { chars: number; ms?: number };
type Batch = {
	/** Message whose label shows the exchange summary. */
	owner?: object;
	ownerOrdinal: number;
	/** Keyed by `message:ordinal`, so re-decorating never double counts. */
	runs: Map<string, BatchRun>;
	liveKey?: string;
	liveStart?: number;
};

const exchangeSeqs = new WeakMap<object, number>();
const arrivalOrders = new WeakMap<object, number>();
const batches = new Map<number, Batch>();
let exchangeSeq = 0;
let arrivalSeq = 0;

function exchangeOf(owner: any): number {
	let seq = exchangeSeqs.get(owner);
	if (seq === undefined) {
		// Assigned on first sight: for live messages that is after Pi added them to the
		// chat, for replayed ones during construction — both in chronological order.
		seq = exchangeSeq;
		exchangeSeqs.set(owner, seq);
	}
	return seq;
}

function arrivalOf(owner: any): number {
	if (!owner) return -1;
	let order = arrivalOrders.get(owner);
	if (order === undefined) {
		order = arrivalSeq++;
		arrivalOrders.set(owner, order);
	}
	return order;
}

function batchFor(exchange: number): Batch {
	let batch = batches.get(exchange);
	if (!batch) {
		batch = { ownerOrdinal: -1, runs: new Map() };
		batches.set(exchange, batch);
	}
	return batch;
}

function freezeLive(batch: Batch): void {
	if (batch.liveKey !== undefined && batch.liveStart !== undefined) {
		const run = batch.runs.get(batch.liveKey);
		if (run && run.ms === undefined) run.ms = Math.max(0, Date.now() - batch.liveStart);
	}
	batch.liveKey = undefined;
	batch.liveStart = undefined;
}

/**
 * Count this message's runs exactly once and keep the exchange clock live. Returns
 * the previous summary carrier when ownership moves, so its labels can be dropped.
 */
function trackBatch(owner: any, batch: Batch, runs: RunAnalysis): object | undefined {
	const id = arrivalOf(owner);

	for (let ordinal = 0; ordinal < runs.chars.length; ordinal++) {
		const key = `${id}:${ordinal}`;
		const chars = runs.chars[ordinal] ?? 0;
		const run = batch.runs.get(key);
		if (run) run.chars = chars;
		else batch.runs.set(key, { chars });

		if (isLive(owner, runs, ordinal)) {
			if (batch.liveKey !== key) {
				freezeLive(batch);
				batch.liveKey = key;
				batch.liveStart = Date.now();
			}
		} else if (batch.liveKey === key) {
			// Reasoning stopped: answer text started, the message ended, or it aborted.
			freezeLive(batch);
		}
	}

	if (runs.chars.length === 0 || !canCarrySummary(owner)) return undefined;
	if (arrivalOf(owner) <= arrivalOf(batch.owner)) return undefined;

	const previous = batch.owner;
	batch.owner = owner;
	batch.ownerOrdinal = runs.chars.length - 1;
	return previous;
}

/** Only a message with a collapsed label can host the summary line. */
function canCarrySummary(owner: any): boolean {
	const label = labelOf(owner);
	let found = false;
	forEachLabel(owner, (region) => {
		if (!found && isHiddenThinkingLabel((region as any).child, label)) found = true;
	});
	return found;
}

/**
 * Keep only the label at `keepOrdinal` (-1 = none). Dropped labels take one adjacent
 * spacer with them, otherwise Pi's blank line between runs stays behind; a message
 * left with nothing but spacers collapses to zero lines.
 */
function applyRollUpLayout(owner: any, keepOrdinal: number): void {
	const container = owner?.contentContainer;
	const children = container?.children;
	if (!Array.isArray(children)) return;

	const label = labelOf(owner);
	const paddingX = paddingOf(owner);
	const kept: any[] = [];
	let ordinal = -1;

	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (!(child instanceof MouseRegion)) {
			kept.push(child);
			continue;
		}
		ordinal++;
		const inner = (child as any).child;

		// Expanded runs render Markdown, not a label: leave those exactly as they are.
		if (!isHiddenThinkingLabel(inner, label)) {
			kept.push(child);
			continue;
		}

		if (ordinal !== keepOrdinal) {
			if (children[i + 1] instanceof Spacer) i++;
			else if (kept.length > 0 && kept[kept.length - 1] instanceof Spacer) kept.pop();
			continue;
		}

		if (!(inner instanceof AnimatedThinkingLabel)) {
			(child as any).child = new AnimatedThinkingLabel(owner, ordinal, paddingX);
		}
		kept.push(child);
	}

	const wanted = kept.every((child) => child instanceof Spacer) ? [] : kept;
	if (wanted.length === children.length && children.every((child, index) => child === wanted[index])) return;
	children.length = 0;
	for (const child of wanted) children.push(child);
	container.invalidate?.();
}

function decorateRollUp(owner: any, runs: RunAnalysis): void {
	const batch = batchFor(exchangeOf(owner));
	const previousOwner = trackBatch(owner, batch, runs);
	if (previousOwner) applyRollUpLayout(previousOwner, -1);
	const keep = batch.owner === owner && runs.chars.length > 0 ? batch.ownerOrdinal : -1;
	applyRollUpLayout(owner, keep);
}

// =============================================================================
// AssistantMessageComponent patch
// =============================================================================

type PatchState = { original: (...args: any[]) => any; installed: (...args: any[]) => any };
const PATCH_KEY = Symbol.for("lexlexlex.thinking-anim.patch");

function isHiddenThinkingLabel(inner: unknown, label: string): boolean {
	// Already ours from an earlier pass: its text is the composed line, not Pi's label,
	// so identity has to win over the text comparison.
	if (inner instanceof AnimatedThinkingLabel) return true;
	if (!(inner instanceof Text)) return false;
	const text = stripTerminalSequences(String((inner as any).text ?? "")).trim();
	return text.length > 0 && text === label.trim();
}

function paddingOf(owner: any): number {
	const pad = Number(owner?.outputPad);
	return Number.isFinite(pad) && pad >= 0 ? pad : 1;
}

/**
 * Every thinking run contributes exactly one MouseRegion child (hidden Text or
 * expanded Markdown), so counting them yields the same ordinal Pi used.
 */
function forEachLabel(owner: any, visit: (region: any, ordinal: number) => void): void {
	const children = owner?.contentContainer?.children;
	if (!Array.isArray(children)) return;
	let ordinal = -1;
	for (const child of children) {
		if (!(child instanceof MouseRegion)) continue;
		ordinal++;
		visit(child, ordinal);
	}
}

function decorate(owner: any): void {
	if (!config.enabled) return;
	const runs = analyze(owner?.lastMessage);
	if (config.rollUpTurns) decorateRollUp(owner, runs);
	else decoratePerRun(owner, runs);
}

/** Per-run labels (roll-up off): one line per reasoning run, frozen per run. */
function decoratePerRun(owner: any, runs: RunAnalysis): void {
	syncRunState(owner, runs);
	const label = labelOf(owner);
	const paddingX = paddingOf(owner);
	forEachLabel(owner, (region, ordinal) => {
		const inner = (region as any).child;
		if (inner instanceof AnimatedThinkingLabel) return;
		if (!isHiddenThinkingLabel(inner, label)) return;
		(region as any).child = new AnimatedThinkingLabel(owner, ordinal, paddingX);
	});
}

type ContainerPatchState = { original: (...args: any[]) => any; installed: (...args: any[]) => any };
const CONTAINER_PATCH_KEY = Symbol.for("lexlexlex.thinking-anim.container-patch");

/** User messages are the exchange boundaries: bump the counter whenever one lands. */
function installExchangeSniffer(): void {
	const host = globalThis as Record<symbol, unknown>;
	const prototype = Container.prototype as any;
	const previous = host[CONTAINER_PATCH_KEY] as ContainerPatchState | undefined;

	// Unwrap our own wrapper only — lexlexlex-tool-groups patches addChild too, and its
	// closure must stay in the chain.
	const original: (...args: any[]) => any =
		previous && prototype.addChild === previous.installed ? previous.original : prototype.addChild;

	const installed = function (this: any, component: any) {
		const result = original.call(this, component);
		try {
			if (component instanceof UserMessageComponent || component instanceof SkillInvocationMessageComponent) {
				exchangeSeq++;
			}
		} catch {
			// Cosmetic bookkeeping must never break the chat.
		}
		return result;
	};

	prototype.addChild = installed;
	host[CONTAINER_PATCH_KEY] = { original, installed };
}

function install(): void {
	installUpdateContentPatch();
	installExchangeSniffer();
}

function installUpdateContentPatch(): void {
	const host = globalThis as Record<symbol, unknown>;
	const prototype = AssistantMessageComponent.prototype as any;
	const previous = host[PATCH_KEY] as PatchState | undefined;

	// /reload keeps our wrapper on the prototype while module state resets, so
	// unwrap back to the true original before installing a fresh closure.
	const original: (...args: any[]) => any =
		previous && prototype.updateContent === previous.installed ? previous.original : prototype.updateContent;

	const installed = function (this: any, message: any, isStreaming: boolean = this.isStreaming) {
		const result = original.call(this, message, isStreaming);
		try {
			decorate(this);
		} catch {
			// Never take the chat down over a cosmetic label.
		}
		return result;
	};

	prototype.updateContent = installed;
	host[PATCH_KEY] = { original, installed };
}

// =============================================================================
// Extension entry
// =============================================================================

export default function lexlexlexThinkingAnim(pi: ExtensionAPI) {
	loadConfig();
	install();
	refreshTheme();

	pi.on("session_start", async (_event, ctx) => {
		loadConfig();
		refreshTheme(ctx);
		install();
	});

	pi.on("turn_start", async (_event, ctx) => {
		refreshTheme(ctx);
	});
}
