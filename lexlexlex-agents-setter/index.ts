/**
 * lexlexlex-agents-setter
 *
 * TUI control for subagents.agentOverrides in settings.json.
 * Lists agents, lets you edit model/thinking/extended options.
 *
 * Command: /agents-setter (or /ags)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	matchesKey,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { Api, Model } from "@earendil-works/pi-ai";

// ── Types ──────────────────────────────────────────────────────────────────

interface AgentOverride {
	model?: string;
	thinking?: string;
	inheritProjectContext?: boolean;
	defaultContext?: "fresh" | "fork";
	disabled?: boolean;
	fallbackModels?: string[];
}

interface AgentOverrides {
	[name: string]: AgentOverride | undefined;
}

interface ProviderGroup {
	provider: string;
	models: Model<Api>[];
}

// ── Constants ──────────────────────────────────────────────────────────────

const BUILTIN_AGENTS = [
	"scout",
	"planner",
	"worker",
	"reviewer",
	"context-builder",
	"researcher",
	"delegate",
	"oracle",
] as const;

const THINKING_LEVELS = [
	{ value: "", label: "(inherit default)" },
	{ value: "off", label: "off" },
	{ value: "minimal", label: "minimal" },
	{ value: "low", label: "low" },
	{ value: "medium", label: "medium" },
	{ value: "high", label: "high" },
	{ value: "xhigh", label: "xhigh" },
] as const;

const DEFAULT_CONTEXT_OPTIONS = [
	{ value: "", label: "(inherit default)" },
	{ value: "fresh", label: "fresh" },
	{ value: "fork", label: "fork" },
] as const;

// ── Settings I/O ───────────────────────────────────────────────────────────

function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

function readSettings(): Record<string, unknown> {
	try {
		const p = getSettingsPath();
		if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
	} catch {
		/* empty */
	}
	return {};
}

function writeSettings(data: Record<string, unknown>): boolean {
	try {
		writeFileSync(getSettingsPath(), JSON.stringify(data, null, 2) + "\n", "utf-8");
		return true;
	} catch {
		return false;
	}
}

function loadOverrides(): AgentOverrides {
	const s = readSettings();
	const o = (s as any)?.subagents?.agentOverrides;
	return o && typeof o === "object" ? (o as AgentOverrides) : {};
}

function saveOverrides(overrides: AgentOverrides): boolean {
	const s = readSettings();
	if (!s.subagents || typeof s.subagents !== "object") s.subagents = {};
	(s.subagents as any).agentOverrides = overrides;
	return writeSettings(s);
}

// ── Model helpers ──────────────────────────────────────────────────────────

function groupModels(models: Model<Api>[]): ProviderGroup[] {
	const map = new Map<string, Model<Api>[]>();
	for (const m of models) {
		const p = m.provider ?? "unknown";
		if (!map.has(p)) map.set(p, []);
		map.get(p)!.push(m);
	}
	return [...map.entries()]
		.map(([provider, ms]) => ({
			provider,
			models: ms.sort((a, b) => a.id.localeCompare(b.id)),
		}))
		.sort((a, b) => a.provider.localeCompare(b.provider));
}

// ── Component state machine ────────────────────────────────────────────────

type Screen = "list" | "config" | "model-picker" | "preview";

const DESCRIPTIONS: Record<string, string> = {
	disabled: "Hide this agent from /run.",
	model: "Force a specific provider/model for this agent.",
	thinking: "Reasoning level (xhigh -> max on DeepSeek).",
	inheritProjectContext: "Include project context (AGENTS.md, skills, settings).",
	defaultContext: "fresh = clean start, fork = inherit parent history.",
	fallbackModels: "Comma-separated backups if primary model fails.",
};

// ── Main UI Component ──────────────────────────────────────────────────────

class AgentsTUI implements Focusable {
	focused = false;

	// State
	private screen: Screen = "list";
	private overrides: AgentOverrides;
	private agentNames: string[];
	private selAgent = 0;
	private selField = 0;
	private selProvider = 0;
	private selModel = 0;
	private filterText = "";
	private previewScroll = 0;
	private statusMessage = "";
	private applyArmed = false;

	// Working data
	private editAgent = "";
	private editConfig: AgentOverride;
	private providers: ProviderGroup[];

	private done: (result: AgentOverrides | undefined) => void;

	constructor(
		private allModels: Model<Api>[],
		private theme: Theme,
		initialOverrides: AgentOverrides,
		done: (result: AgentOverrides | undefined) => void,
	) {
		this.overrides = structuredClone(initialOverrides);
		this.providers = groupModels(allModels);
		const all = new Set([...BUILTIN_AGENTS, ...Object.keys(this.overrides)]);
		this.agentNames = [...all].sort();
		this.editConfig = {};
		this.done = done;
	}

	// ── Input ───────────────────────────────────────────────────────────

	handleInput(data: string): void {
		switch (this.screen) {
			case "list":
				return this.handleListInput(data);
			case "config":
				return this.handleConfigInput(data);
			case "model-picker":
				return this.handleModelPickerInput(data);
			case "preview":
				return this.handlePreviewInput(data);
		}
	}

	private handleListInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.selAgent = Math.max(0, this.selAgent - 1);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.selAgent = Math.min(this.agentNames.length - 1, this.selAgent + 1);
			return;
		}
		if (matchesKey(data, "return")) {
			this.editAgent = this.agentNames[this.selAgent]!;
			this.editConfig = structuredClone(this.overrides[this.editAgent] ?? {});
			this.selField = 0;
			this.screen = "config";
			return;
		}
		if (data === " ") {
			const name = this.agentNames[this.selAgent]!;
			const cur = this.overrides[name] ?? {};
			this.overrides[name] = { ...cur, disabled: !(cur.disabled ?? false) };
			return;
		}
		if (data === "d") {
			const name = this.agentNames[this.selAgent]!;
			if (name in this.overrides) delete this.overrides[name];
			return;
		}
		if (data === "p") {
			this.previewScroll = 0;
			this.applyArmed = false;
			this.screen = "preview";
			return;
		}
		// Add new agent
		if (data === "n") {
			// We'll prompt inline — for now, enter a dummy name
			this.editAgent = "new-agent";
			this.editConfig = {};
			this.selField = 0;
			this.screen = "config";
			return;
		}
	}

	private handleConfigInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.commitConfig();
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.selField = Math.max(0, this.selField - 1);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.selField = Math.min(this.fields().length - 1, this.selField + 1);
			return;
		}
		if (matchesKey(data, "return")) {
			const f = this.fields()[this.selField];
			if (!f) return;
			if (f.key === "model") {
				this.selProvider = 0;
				this.selModel = 0;
				this.filterText = "";
				this.screen = "model-picker";
				return;
			}
			if (f.key === "thinking") {
				const idx = THINKING_LEVELS.findIndex((l) => l.value === this.editConfig.thinking);
				this.editConfig.thinking = THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length]!.value;
				return;
			}
			if (f.key === "defaultContext") {
				const idx = DEFAULT_CONTEXT_OPTIONS.findIndex((o) => o.value === (this.editConfig.defaultContext ?? ""));
				const next = (idx + 1) % DEFAULT_CONTEXT_OPTIONS.length;
				this.editConfig.defaultContext = (next === 0 ? undefined : DEFAULT_CONTEXT_OPTIONS[next]!.value) as any;
				return;
			}
			if (f.key === "inheritProjectContext") {
				this.editConfig.inheritProjectContext = !(this.editConfig.inheritProjectContext ?? false);
				return;
			}
			if (f.key === "disabled") {
				this.editConfig.disabled = !(this.editConfig.disabled ?? false);
				return;
			}
			// Confirm and save this agent's config
			this.commitConfig();
			return;
		}
		// Space for toggles
		if (data === " ") {
			const f = this.fields()[this.selField];
			if (!f) return;
			if (f.type === "toggle") {
				if (f.key === "disabled") this.editConfig.disabled = !(this.editConfig.disabled ?? false);
				if (f.key === "inheritProjectContext") this.editConfig.inheritProjectContext = !(this.editConfig.inheritProjectContext ?? false);
			}
			return;
		}
		// Text input for fallbackModels
		if (this.fields()[this.selField]?.key === "fallbackModels") {
			if (matchesKey(data, "backspace")) {
				const cur = this.editConfig.fallbackModels?.join(", ") ?? "";
				this.editConfig.fallbackModels = cur.slice(0, -1).split(",").map((s) => s.trim()).filter(Boolean);
				return;
			}
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				const cur = this.editConfig.fallbackModels?.join(", ") ?? "";
				const next = cur + data;
				this.editConfig.fallbackModels = next.split(",").map((s) => s.trim()).filter(Boolean);
				return;
			}
		}
		// Agent name edit (first field)
		if (this.selField === 0) {
			if (matchesKey(data, "backspace")) {
				if (this.editAgent.length > 0) this.editAgent = this.editAgent.slice(0, -1);
				return;
			}
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.editAgent += data;
				return;
			}
		}
	}

	private handlePreviewInput(data: string): void {
		const before = this.getDiskOverrides();
		const after = this.overrides;
		const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
		const changed = names.filter((n) => stableStringify(before[n]) !== stableStringify(after[n]));
		const maxIndex = Math.max(0, changed.length - 1);

		if (matchesKey(data, "escape") || data === "q") {
			this.applyArmed = false;
			this.screen = "list";
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.previewScroll = Math.max(0, this.previewScroll - 1);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.previewScroll = Math.min(maxIndex, this.previewScroll + 1);
			return;
		}
		if (data === "a") {
			if (!this.applyArmed) {
				this.applyArmed = true;
				this.statusMessage = "Press 'a' again to apply changes.";
				return;
			}
			this.saveCurrentOverrides();
			this.applyArmed = false;
			return;
		}
		if (data === "r") {
			this.applyArmed = false;
			this.discardAllChanges();
			this.previewScroll = 0;
			return;
		}
	}

	private handleModelPickerInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.screen = "config";
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.selModel = Math.max(0, this.selModel - 1);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			const models = this.filteredModels();
			this.selModel = Math.min(models.length - 1, this.selModel + 1);
			return;
		}
		if (matchesKey(data, "return")) {
			const models = this.filteredModels();
			const m = models[this.selModel];
			if (m) {
				this.editConfig.model = `${m.provider}/${m.id}`;
				this.screen = "config";
			}
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.filterText = this.filterText.slice(0, -1);
			this.selModel = 0;
			return;
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.filterText += data;
			this.selModel = 0;
			return;
		}
	}

	private getDiskOverrides(): AgentOverrides {
		return loadOverrides();
	}

	private isDirty(): boolean {
		return stableStringify(this.overrides) !== stableStringify(this.getDiskOverrides());
	}

	private saveCurrentOverrides(): void {
		if (!this.isDirty()) {
			this.statusMessage = "No unsaved changes.";
			return;
		}
		const ok = saveOverrides(this.overrides);
		this.statusMessage = ok ? `Applied to ${getSettingsPath()}` : "Apply failed.";
	}

	private discardAllChanges(): void {
		this.overrides = structuredClone(this.getDiskOverrides());
		const all = new Set([...BUILTIN_AGENTS, ...Object.keys(this.overrides)]);
		this.agentNames = [...all].sort();
		this.selAgent = Math.min(this.selAgent, Math.max(0, this.agentNames.length - 1));
		this.statusMessage = "Discarded staged changes.";
	}

	private commitConfig(): void {
		// Clean out empties
		const c = this.editConfig;
		if (!c.model) delete c.model;
		if (!c.thinking) delete c.thinking;
		if (!c.defaultContext) delete c.defaultContext;
		if (!c.fallbackModels || c.fallbackModels.length === 0) delete c.fallbackModels;
		if (c.inheritProjectContext === false) delete c.inheritProjectContext;
		if (c.disabled === false) delete c.disabled;

		// Rename if changed
		const oldName = this.agentNames[this.selAgent] ?? this.editAgent;
		if (this.editAgent !== oldName) {
			delete this.overrides[oldName];
		}

		if (Object.keys(c).length > 0) {
			this.overrides[this.editAgent] = c;
		} else {
			delete this.overrides[this.editAgent];
		}

		// Rebuild agent list
		const all = new Set([...BUILTIN_AGENTS, ...Object.keys(this.overrides)]);
		this.agentNames = [...all].sort();
		this.selAgent = this.agentNames.indexOf(this.editAgent);
		if (this.selAgent === -1) this.selAgent = 0;
		this.screen = "list";
	}

	// ── Fields definition ──────────────────────────────────────────────

	private fields(): Array<{ key: string; label: string; type: string }> {
		return [
			{ key: "_name", label: "Agent Name", type: "text" },
			{ key: "disabled", label: "Disabled", type: "toggle" },
			{ key: "model", label: "Model", type: "model" },
			{ key: "thinking", label: "Thinking", type: "select" },
			{ key: "inheritProjectContext", label: "Inherit Project Context", type: "toggle" },
			{ key: "defaultContext", label: "Default Context", type: "select" },
			{ key: "fallbackModels", label: "Fallback Models", type: "text" },
		];
	}

	private filteredModels(): Array<{ provider: string; id: string }> {
		const f = this.filterText.toLowerCase();
		const result: Array<{ provider: string; id: string }> = [];
		for (const g of this.providers) {
			for (const m of g.models) {
				const label = `${g.provider}/${m.id}`;
				if (!f || label.toLowerCase().includes(f) || m.id.toLowerCase().includes(f) || g.provider.toLowerCase().includes(f)) {
					result.push({ provider: g.provider, id: m.id });
				}
			}
		}
		return result;
	}

	// ── Render ─────────────────────────────────────────────────────────

	render(width: number): string[] {
		switch (this.screen) {
			case "list":
				return this.renderList(width);
			case "config":
				return this.renderConfig(width);
			case "model-picker":
				return this.renderModelPicker(width);
			case "preview":
				return this.renderPreview(width);
		}
	}

	private renderList(w: number): string[] {
		const iw = w - 2;
		const th = this.theme;
		const rows: string[] = [];

		const b = (s: string) => th.fg("border", s);
		const r = (s: string) => b("│") + pad(trun(s, iw), iw) + b("│");

		rows.push(b(`╭${"─".repeat(iw)}╮`));
		const dirty = this.isDirty() ? th.fg("warning", "DIRTY") : th.fg("success", "CLEAN");
		rows.push(r(` ${th.fg("accent", bold(th, "Agents Setter"))} [${dirty}]`));
		rows.push(r(` ${th.fg("dim", "Dashboard · Enter detail · p preview/apply · d delete · q exit")}`));
		rows.push(r(""));

		rows.push(r(` ${th.fg("dim", "D Agent           Model                       T i d")}`));
		rows.push(r(` ${th.fg("dim", "─".repeat(Math.max(1, iw - 2)))}`));

		const maxRows = 12;
		const start = Math.max(0, Math.min(this.selAgent - Math.floor(maxRows / 2), Math.max(0, this.agentNames.length - maxRows)));
		const end = Math.min(this.agentNames.length, start + maxRows);

		for (let i = start; i < end; i++) {
			const name = this.agentNames[i]!;
			const ov = this.overrides[name];
			const sel = i === this.selAgent;
			const isBuiltin = (BUILTIN_AGENTS as readonly string[]).includes(name);

			const selM = sel ? th.fg("accent", "▶") : " ";
			const disM = ov?.disabled ? th.fg("error", "✗") : th.fg("success", "✓");
			const nStr = sel ? th.fg("accent", trun(name, 14)) : trun(name, 14);
			const tag = isBuiltin ? "" : th.fg("warning", "+");
			const modelS = ov?.model ? trun(ov.model, 27) : th.fg("dim", "─");
			const thinkS = ov?.thinking ? th.fg("accent", trun(ov.thinking, 5)) : th.fg("dim", "·");
			const inhS = ov?.inheritProjectContext ? th.fg("success", "✓") : th.fg("dim", "·");
			const dcS = ov?.defaultContext === "fork" ? th.fg("accent", "F") : ov?.defaultContext === "fresh" ? "f" : th.fg("dim", "·");

			rows.push(r(`${selM}${disM} ${pad(`${nStr}${tag}`, 16)} ${pad(modelS, 27)} ${pad(thinkS, 5)} ${inhS} ${dcS}`));
		}

		if (this.agentNames.length > maxRows) {
			rows.push(r(` ${th.fg("dim", `Showing ${start + 1}-${end} of ${this.agentNames.length}`)}`));
		}

		rows.push(r(""));
		if (this.statusMessage) rows.push(r(` ${th.fg("dim", trun(this.statusMessage, iw - 2))}`));
		rows.push(r(` ${th.fg("dim", "↑↓/jk nav · Enter detail · p preview/apply · d delete")}`));
		rows.push(b(`╰${"─".repeat(iw)}╯`));
		return rows;
	}

	private renderConfig(w: number): string[] {
		const iw = w - 2;
		const th = this.theme;
		const rows: string[] = [];

		const b = (s: string) => th.fg("border", s);
		const r = (s: string) => b("│") + pad(trun(s, iw), iw) + b("│");

		rows.push(b(`╭${"─".repeat(iw)}╮`));
		rows.push(r(` ${th.fg("accent", bold(th, `Detail: ${this.editAgent}`))}`));
		rows.push(r(` ${th.fg("dim", "Dashboard -> Detail flow · Enter apply/toggle · Esc back")}`));
		rows.push(r(""));

		const fields = this.fields();
		for (let i = 0; i < fields.length; i++) {
			const f = fields[i]!;
			const sel = i === this.selField;
			const p = sel ? th.fg("accent", "▶") : " ";

			let val = "";
			if (f.key === "_name") val = this.editAgent + (sel ? th.fg("accent", "█") : "");
			else if (f.key === "disabled") val = this.editConfig.disabled ? th.fg("error", "disabled") : th.fg("success", "enabled");
			else if (f.key === "model") val = this.editConfig.model ? trun(String(this.editConfig.model), 34) : th.fg("dim", "(inherit)");
			else if (f.key === "thinking") val = THINKING_LEVELS.find((l) => l.value === this.editConfig.thinking)?.label ?? "(inherit)";
			else if (f.key === "inheritProjectContext") val = this.editConfig.inheritProjectContext ? "yes" : "no";
			else if (f.key === "defaultContext") val = DEFAULT_CONTEXT_OPTIONS.find((o) => o.value === (this.editConfig.defaultContext ?? ""))?.label ?? "(inherit)";
			else if (f.key === "fallbackModels") val = trun(this.editConfig.fallbackModels?.join(", ") ?? "", 34) + (sel ? th.fg("accent", "█") : "");

			const labelStr = sel ? th.fg("accent", f.label) : f.label;
			rows.push(r(` ${p} ${pad(labelStr, 24)} ${val}`));
		}

		const selected = fields[this.selField];
		if (selected) {
			const key = selected.key === "_name" ? "model" : selected.key;
			const help = DESCRIPTIONS[key];
			if (help) rows.push(r(` ${th.fg("dim", trun(`Help: ${help}`, iw - 2))}`));
		}

		rows.push(r(""));
		rows.push(r(` ${th.fg("dim", "↑↓/jk nav · Enter apply/cycle · Esc back")}`));
		if (this.statusMessage) rows.push(r(` ${th.fg("dim", trun(this.statusMessage, iw - 2))}`));
		rows.push(b(`╰${"─".repeat(iw)}╯`));
		return rows;
	}

	private renderModelPicker(w: number): string[] {
		const iw = w - 2;
		const th = this.theme;
		const rows: string[] = [];

		const b = (s: string) => th.fg("border", s);
		const r = (s: string) => b("│") + pad(trun(s, iw), iw) + b("│");

		const models = this.filteredModels();
		const maxShow = 12;
		const start = Math.max(0, Math.min(this.selModel - Math.floor(maxShow / 2), Math.max(0, models.length - maxShow)));
		const end = Math.min(models.length, start + maxShow);

		rows.push(b(`╭${"─".repeat(iw)}╮`));
		rows.push(r(` ${th.fg("accent", bold(th, "Pick a Model"))}`));
		rows.push(r(` ${th.fg("accent", `Filter: ${this.filterText}█`)}`));
		rows.push(r(""));

		for (let i = start; i < end; i++) {
			const m = models[i]!;
			const sel = i === this.selModel;
			const p = sel ? th.fg("accent", "▶") : " ";
			const label = sel ? th.fg("accent", trun(`${m.provider}/${m.id}`, iw - 4)) : trun(`${m.provider}/${m.id}`, iw - 4);
			rows.push(r(` ${p} ${label}`));
		}
		if (models.length > maxShow) {
			rows.push(r(` ${th.fg("dim", `Showing ${start + 1}-${end} of ${models.length}`)}`));
		}

		rows.push(r(""));
		rows.push(r(` ${th.fg("dim", "↑↓/jk nav · Enter select · Esc back · Type to filter")}`));
		rows.push(b(`╰${"─".repeat(iw)}╯`));
		return rows;
	}

	private renderPreview(w: number): string[] {
		const iw = w - 2;
		const th = this.theme;
		const rows: string[] = [];
		const b = (s: string) => th.fg("border", s);
		const r = (s: string) => b("│") + pad(trun(s, iw), iw) + b("│");

		const before = this.getDiskOverrides();
		const after = this.overrides;
		const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
		const changed = names.filter((n) => stableStringify(before[n]) !== stableStringify(after[n]));
		const maxIndex = Math.max(0, changed.length - 1);
		this.previewScroll = Math.max(0, Math.min(this.previewScroll, maxIndex));

		rows.push(b(`╭${"─".repeat(iw)}╮`));
		rows.push(r(` ${th.fg("accent", bold(th, "Preview Changes"))}`));
		rows.push(r(` ${th.fg("dim", `${changed.length} changed agent(s) · scope: ${getSettingsPath()}`)}`));
		rows.push(r(""));

		const listRows = 8;
		const start = Math.max(0, Math.min(this.previewScroll - Math.floor(listRows / 2), Math.max(0, changed.length - listRows)));
		const end = Math.min(changed.length, start + listRows);
		for (let i = start; i < end; i++) {
			const agent = changed[i]!;
			const sel = i === this.previewScroll;
			const prefix = sel ? th.fg("accent", "▶") : " ";
			const marker = before[agent] ? "M" : "+";
			const name = sel ? th.fg("accent", agent) : agent;
			rows.push(r(` ${prefix} ${marker} ${name}`));
		}
		if (changed.length === 0) rows.push(r(` ${th.fg("success", "No pending changes.")}`));
		if (changed.length > listRows) rows.push(r(` ${th.fg("dim", `List ${start + 1}-${end}/${changed.length}`)}`));

		rows.push(r(` ${th.fg("dim", "─".repeat(Math.max(1, iw - 2)))}`));
		const selectedAgent = changed[this.previewScroll];
		if (selectedAgent) {
			const beforeObj = (before[selectedAgent] ?? {}) as Record<string, unknown>;
			const afterObj = (after[selectedAgent] ?? {}) as Record<string, unknown>;
			const keySet = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
			const changedKeys = [...keySet].filter((k) => stableStringify(beforeObj[k]) !== stableStringify(afterObj[k]));

			const beforeJson = before[selectedAgent] ? JSON.stringify(before[selectedAgent], null, 2) : "(none)";
			const afterJson = after[selectedAgent] ? JSON.stringify(after[selectedAgent], null, 2) : "(none)";
			rows.push(r(` ${th.fg("accent", selectedAgent)}`));
			rows.push(r(` ${th.fg("dim", `Changed keys: ${changedKeys.join(", ") || "(none)"}`)}`));
			rows.push(r(` ${th.fg("dim", "BEFORE")}`));
			for (const line of compactBlock(beforeJson, iw - 2, 6)) rows.push(r(` ${th.fg("dim", line)}`));
			rows.push(r(` ${th.fg("dim", "AFTER")}`));
			for (const line of compactBlock(afterJson, iw - 2, 6)) rows.push(r(` ${line}`));
		}

		rows.push(r(""));
		rows.push(r(` ${th.fg("dim", "↑↓/jk select · a arm/apply · r discard all · Esc back")}`));
		if (this.statusMessage) rows.push(r(` ${th.fg("dim", trun(this.statusMessage, iw - 2))}`));
		rows.push(b(`╰${"─".repeat(iw)}╯`));
		return rows;
	}

	invalidate(): void {}
	dispose(): void {}
}

// ── Helpers ────────────────────────────────────────────────────────────────

function pad(s: string, w: number): string {
	const v = visibleWidth(s);
	return s + " ".repeat(Math.max(0, w - v));
}

function trun(s: string, w: number): string {
	return visibleWidth(s) > w ? s.slice(0, w - 1) + "…" : s;
}

function bold(th: Theme, s: string): string {
	return th.bold(s);
}

function stableStringify(value: unknown): string {
	if (value === null || value === undefined) return String(value);
	if (typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function compactBlock(input: string, width: number, maxLines: number): string[] {
	const lines = input.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		if (out.length >= maxLines) break;
		if (visibleWidth(line) <= width) out.push(line);
		else out.push(trun(line, width));
	}
	if (lines.length > maxLines) out.push("...");
	return out;
}

// ── Entry Point ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let models: Model<Api>[] = [];

	function refresh(ctx: { modelRegistry: { getAll: () => Model<Api>[] } }) {
		try {
			models = ctx.modelRegistry.getAll() ?? [];
		} catch {
			models = [];
		}
	}

	async function run(_args: string, ctx: ExtensionCommandContext) {
		refresh(ctx);

		const overrides = loadOverrides();
		const result = await ctx.ui.custom<AgentOverrides | undefined>(
			(_tui, theme, _kb, done) => new AgentsTUI(models, theme, overrides, done),
			{ overlay: true },
		);

	}

	pi.registerCommand("agents-setter", {
		description: "Manage subagents.agentOverrides in settings.json",
		handler: run,
	});

	pi.registerCommand("ags", {
		description: "Alias for /agents-setter",
		handler: run,
	});

	pi.on("session_start", (_event, ctx) => {
		refresh(ctx);
	});
}
