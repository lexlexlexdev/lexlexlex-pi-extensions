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
 * finishes), so each thinking run has three states:
 *   - reasoning now      -> animated pulse + "· 1,240 chars · 12s"
 *   - reasoning finished -> "Thought for 7s" (duration frozen the moment thinking
 *                           stopped, so it never keeps ticking)
 *   - resumed session    -> "Thought" (nothing is persisted, so a reloaded session
 *                           has no timing data; set `finishedUnknownTemplate` to ""
 *                           to fall back to Pi's own label instead)
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
 *     "finishedUnknownTemplate": "Thought"            // resumed sessions; "" = Pi's label
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
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { MouseRegion, Text, stripTerminalSequences } from "@earendil-works/pi-tui";
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

function compose(owner: any, ordinal: number): string {
	const label = labelOf(owner);
	const staticLabel = italic(tint("thinkingText", label));
	const runs = analyze(owner?.lastMessage);

	if (isLive(owner, runs, ordinal)) {
		const frames = config.frames.length > 0 ? config.frames : DEFAULT_CONFIG.frames;
		const colors = config.colors.length > 0 ? config.colors : DEFAULT_CONFIG.colors;
		const tick = Math.floor(Date.now() / Math.max(16, config.intervalMs));
		const frame = frames[tick % frames.length] ?? "";
		const dot = tint(colors[tick % colors.length] ?? "dim", frame);

		const metrics: string[] = [];
		if (config.showChars) metrics.push(`${formatCount(runs.chars[ordinal] ?? 0)} chars`);
		// Sub-second reasoning is the common case for cached prompts: "0s" is noise.
		const elapsed = elapsedSeconds(owner, ordinal);
		if (config.showElapsed && elapsed >= 1) metrics.push(`${elapsed}s`);
		const suffix = metrics.length > 0 ? config.separator + tint("dim", metrics.join(" · ")) : "";

		return `${dot} ${staticLabel}${suffix}`;
	}

	const done = doneDurations.get(owner)?.get(ordinal);
	if (done !== undefined) {
		return italic(tint("thinkingText", config.finishedTemplate.replace("{duration}", formatDuration(done))));
	}
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
// AssistantMessageComponent patch
// =============================================================================

type PatchState = { original: (...args: any[]) => any; installed: (...args: any[]) => any };
const PATCH_KEY = Symbol.for("lexlexlex.thinking-anim.patch");

function isHiddenThinkingLabel(inner: unknown, label: string): boolean {
	if (!(inner instanceof Text)) return false;
	const text = stripTerminalSequences(String((inner as any).text ?? "")).trim();
	return text.length > 0 && text === label.trim();
}

function decorate(owner: any): void {
	if (!config.enabled) return;
	const children = owner?.contentContainer?.children;
	if (!Array.isArray(children)) return;

	const runs = analyze(owner?.lastMessage);
	syncRunState(owner, runs);

	const label = labelOf(owner);
	const pad = Number(owner?.outputPad);
	const paddingX = Number.isFinite(pad) && pad >= 0 ? pad : 1;

	// Every thinking run contributes exactly one MouseRegion child (hidden Text or
	// expanded Markdown), so counting them yields the same ordinal Pi used.
	let ordinal = -1;
	for (const child of children) {
		if (!(child instanceof MouseRegion)) continue;
		ordinal++;
		const inner = (child as any).child;
		if (inner instanceof AnimatedThinkingLabel) continue;
		if (!isHiddenThinkingLabel(inner, label)) continue;
		(child as any).child = new AnimatedThinkingLabel(owner, ordinal, paddingX);
	}
}

function install(): void {
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
