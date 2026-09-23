import {
  type Api,
  type AssistantMessageEvent,
  type Model,
  type ModelsSimpleStreamOptions,
  type ThinkingLevel,
  type UserMessage,
} from "@earendil-works/pi-ai";
import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** `provider/model-id`, the same reference Pi shows for a model. */
type GcmModelRef = string;

type CommitItem = { branch: string; message: string; hash: string; files: string[] };

const GCM_REPORT_TYPE = "lexlexlex-gcm-report";

const DEFAULT_GCM_MODEL: GcmModelRef = "openai-codex/gpt-6-luna";
const DEFAULT_THINKING: ThinkingLevel = "medium";

/** Ids the Codex Fast programme advertises. Mirrors `CODEX_FAST_MODEL_IDS` in
 * `lexlexlex-multicodex/fast.ts` and `lexlexlex-compaction-fast/index.ts`. */
const CODEX_FAST_MODEL_IDS: ReadonlySet<string> = new Set([
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-6-sol",
]);

type ServiceTierSetting = "fast" | "standard";

type ScopedModelEntry = { model: Model<Api>; thinkingLevel?: ThinkingLevel };

type GcmChoice = {
  ref: GcmModelRef;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Models Pi scoped for this session (`--models` / `enabledModels`, the set
 * `/scoped-models` shows). With no scoping configured every available model is
 * usable, so the picker falls back to that list instead of a hardcoded menu.
 */
export function gcmModelChoices(ctx: ExtensionContext): GcmChoice[] {
  const scoped = (ctx.scopedModels ?? []) as readonly ScopedModelEntry[];
  const entries: ScopedModelEntry[] =
    scoped.length > 0 ? [...scoped] : ctx.modelRegistry.getAvailable().map((model) => ({ model }));

  return entries
    .filter((entry) => isChatModel(entry.model))
    .map((entry) => ({
      ref: `${entry.model.provider}/${entry.model.id}`,
      model: entry.model,
      thinkingLevel: entry.thinkingLevel ?? DEFAULT_THINKING,
    }));
}

/** Providers also list embedding and image models; commits need a text model. */
function isChatModel(model: Model<Api>): boolean {
  if (Array.isArray(model.input) && !model.input.includes("text")) return false;
  return !/embedding|dall-e|whisper|tts|image/i.test(model.id);
}

export function readGcmSelection(ctx: ExtensionContext): GcmModelRef | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom" || entry.customType !== "gcm-model") continue;
    const selected = (entry.data as { selected?: unknown } | undefined)?.selected;
    if (typeof selected === "string" && selected.includes("/")) return selected;
  }
  return undefined;
}

/** Session pick, else the configured default, else the active model, else the first scoped one. */
export function resolveGcmChoice(ctx: ExtensionContext): GcmChoice | undefined {
  const choices = gcmModelChoices(ctx);
  if (choices.length === 0) return undefined;

  const active = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  for (const ref of [readGcmSelection(ctx), DEFAULT_GCM_MODEL, active]) {
    if (!ref) continue;
    const match = choices.find((choice) => choice.ref === ref);
    if (match) return match;
  }
  return choices[0];
}

/** Settings section `gcm`: `{ "gcm": { "serviceTier": "fast" | "standard" } }`. */
export function resolveGcmConfig(
  globalSettings: unknown,
  projectSettings: unknown,
): { serviceTier: ServiceTierSetting } {
  const read = (settings: unknown): unknown =>
    isRecord(settings) && isRecord(settings.gcm) ? settings.gcm.serviceTier : undefined;
  const raw = read(projectSettings) ?? read(globalSettings);
  return { serviceTier: raw === "standard" ? "standard" : "fast" };
}

export function loadGcmConfig(ctx: ExtensionContext): { serviceTier: ServiceTierSetting } {
  const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
    projectTrusted: ctx.isProjectTrusted(),
  });
  return resolveGcmConfig(
    settings.getGlobalSettings(),
    ctx.isProjectTrusted() ? settings.getProjectSettings() : undefined,
  );
}

function isOfficialCodexModel(model: Model<Api>): boolean {
  if (model.provider !== "openai-codex" || model.api !== "openai-codex-responses") return false;
  try {
    return new URL(model.baseUrl).origin === "https://chatgpt.com";
  } catch {
    return false;
  }
}

/** Only the advertised ids accept the tier; the others would fail the request. */
export function supportsFastTier(model: Model<Api>): boolean {
  return isOfficialCodexModel(model) && CODEX_FAST_MODEL_IDS.has(model.id);
}

/**
 * Live progress for one generation request. Pi consumes these streams through
 * `result()`, so events cannot be tapped at the iterator; `push` still sees
 * every event, and overriding it on our own stream instance leaves the stream's
 * completion, error, abort, and `result()` behaviour alone. Tokens are
 * estimated from delta length until the provider reports real usage.
 */
export type GcmProgress = {
  ref: GcmModelRef;
  fast: boolean;
  phase: string;
  /** Whole-run timer, for the final summary. */
  beganAt: number;
  chars: number;
  reportedTokens: number;
  /** Last time a tick was published, for throttling (no timers involved). */
  lastTickAt?: number;
};

export function beginProgress(ref: GcmModelRef, fast: boolean, phase = "starting"): GcmProgress {
  return { ref, fast, phase, beganAt: Date.now(), chars: 0, reportedTokens: 0 };
}

export function setProgressPhase(progress: GcmProgress, phase: string): void {
  progress.phase = phase;
  progress.chars = 0;
  progress.reportedTokens = 0;
  progress.lastTickAt = undefined;
}

export function progressTokens(progress: GcmProgress): number {
  if (progress.reportedTokens > 0) return progress.reportedTokens;
  return Math.ceil(progress.chars / 4);
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Formatting split: the widget line is phase · tokens · elapsed, the tool card
 * line (and the footer status of `/gcm`) prefixes the model and tier.
 */
export function formatProgressDetail(progress: GcmProgress, now = Date.now()): string {
  const elapsed = formatDuration(now - progress.beganAt);
  const tokens = progressTokens(progress);
  const estimated = progress.reportedTokens <= 0 && tokens > 0 ? "~" : "";
  return `${progress.phase} · ${estimated}${formatCount(tokens)} tok · ${elapsed}`;
}

/**
 * The two knobs that aren't the model name: tier and thinking level. Rendered
 * as a trailing parenthetical so the header stays one glance long.
 */
function modelQualifiers(fast: boolean, thinking: ThinkingLevel | undefined, canThink = true): string {
  const parts = [fast ? "fast" : undefined, thinking && canThink ? `thinking ${thinking}` : undefined].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

export function formatProgress(progress: GcmProgress, now = Date.now()): string {
  const tier = progress.fast ? " (fast)" : "";
  return `${progress.ref}${tier} · ${formatProgressDetail(progress, now)}`;
}

/**
 * Count text and thinking deltas, adopt real usage once the provider sends it,
 * and tick the caller while the model is talking. The tick is driven by the
 * stream itself and throttled, so live progress needs no timer of ours.
 */
export function observeStream(
  stream: { push: (event: AssistantMessageEvent) => void },
  progress: GcmProgress,
  onTick?: () => void,
  tickIntervalMs = 200,
): void {
  if (typeof stream.push !== "function") return;
  const originalPush = stream.push;
  stream.push = function (this: typeof stream, event: AssistantMessageEvent) {
    if (event.type === "text_delta" || event.type === "thinking_delta") {
      progress.chars += event.delta.length;
    }
    // Delta events carry the in-flight message as `partial`; the final ones as `message`.
    const carried = "partial" in event ? event.partial : "message" in event ? event.message : undefined;
    const usage = isRecord(carried) && isRecord(carried.usage) ? carried.usage : undefined;
    const output = usage?.output;
    if (typeof output === "number" && Number.isFinite(output) && output > 0) {
      progress.reportedTokens = Math.max(progress.reportedTokens, output);
    }

    if (onTick) {
      const now = Date.now();
      if (progress.lastTickAt === undefined || now - progress.lastTickAt >= tickIntervalMs) {
        progress.lastTickAt = now;
        onTick();
      }
    }
    return originalPush.call(this, event);
  };
}

/** A provider failure, as opposed to a repository problem the caller can fix. */
export class GcmProviderError extends Error {
  constructor(
    message: string,
    /** Repo-state context for the operator, e.g. what was already committed. */
    readonly hint?: string,
    /** The provider's own reason, carried through from the model layer. */
    readonly debug?: string,
  ) {
    super(message);
    this.name = "GcmProviderError";
  }
}

type AskContext = {
  ctx: ExtensionContext;
  model: Model<Api>;
  reasoning: ThinkingLevel;
  tier: ServiceTierSetting;
  progress: GcmProgress;
  signal?: AbortSignal;
  /** Called while the model streams, throttled, to refresh the progress line. */
  onTick?: () => void;
};

/**
 * One request through Pi's model runtime rather than pi-ai directly, so the
 * registered provider resolves credentials and a wrapper such as MultiCodex can
 * rotate accounts and refresh OAuth tokens. The Fast tier travels as
 * `service_tier` through `onPayload`, because the provider rebuilds its option
 * bag and drops unknown fields.
 */
async function askModel(ask: AskContext, systemPrompt: string, userText: string): Promise<string> {
  const { ctx, model, reasoning, progress, signal } = ask;
  const fast = ask.tier === "fast" && supportsFastTier(model);
  progress.fast = fast;

  const options: ModelsSimpleStreamOptions = {
    reasoning,
    signal,
    ...(fast
      ? {
          // The provider rebuilds its option bag, so the tier rides on the payload.
          onPayload: async (payload: unknown, _model: Model<Api>) => ({
            ...(isRecord(payload) ? payload : {}),
            service_tier: "priority",
          }),
        }
      : {}),
  };

  const stream = ctx.modelRegistry.streamSimple(
    model,
    {
      systemPrompt,
      messages: [
        {
          role: "user",
          timestamp: Date.now(),
          content: [{ type: "text", text: userText }],
        } as UserMessage,
      ],
    },
    options,
  );
  observeStream(stream, progress, ask.onTick);

  const message = await stream.result();
  const text = message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

  if (message.stopReason === "error") {
    throw new GcmProviderError(
      `Provider request failed for ${model.provider}/${model.id}.`,
      undefined,
      message.errorMessage ?? "provider returned an error",
    );
  }
  if (message.stopReason === "aborted" && signal?.aborted) return text;
  if (!text) {
    throw new GcmProviderError(
      `Provider returned no text for ${model.provider}/${model.id}.`,
      undefined,
      message.errorMessage ?? "empty response",
    );
  }
  return text;
}

const MESSAGE_PROMPT = `You generate one git commit message from a diff.
Rules:
- Output ONLY one commit message line.
- The example commit messages from this project's history are AUTHORITATIVE: copy their naming convention exactly (style, type prefixes, scope usage, tense, casing).
- Only if no history examples are provided, fall back to conventional commits format: type(scope): summary
- Keep <= 72 chars unless Custom instructions explicitly say otherwise.
- Use imperative mood.
- No markdown, no quotes.`;

const PLAN_PROMPT = `You split file changes into git commits.
Return STRICT JSON only:
{"commits":[{"files":["path/a","path/b"]}]}
Rules:
- YOU decide how many commits are appropriate. There is no preferred number.
- Group files by logical zone: separate features, bugfixes, refactors, docs, config/chores, generated artifacts.
- NEVER throw unrelated zones into one commit. When in doubt between one or two commits, split.
- A single commit is correct ONLY if all files truly belong to one logical change.
- Recent commit messages are provided so you can see what granularity and style this project uses.
- Use only provided file paths
- Cover all files exactly once`;

async function getRecentCommitSubjects(repoPath: string): Promise<string[]> {
  try {
    const log = await runGit(repoPath, ["log", "--pretty=format:%s", "-n", "10"]);
    return `${log.stdout || ""}`.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const ToolParams = Type.Object({
  repoPath: Type.String({ description: "Path to a git repository" }),
  customInstructions: Type.Optional(Type.String({ description: "Optional custom instructions for commit message generation" })),
  branchName: Type.Optional(Type.String({ description: "Optional branch name to commit to" })),
});

type ToolInput = { repoPath: string; customInstructions?: string; branchName?: string };

type GcmDetails = {
  repoPath: string;
  repoName?: string;
  branchRequested?: string;
  customInstructions?: string;
  branchUsed?: string;
  branchStatus?: string;
  commits?: CommitItem[];
  modelSelected: GcmModelRef;
  modelUsed?: string;
  /** Whether the Fast tier was sent for the request. */
  fast?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Latest progress line, while the run is in flight. */
  progress?: string;
  modelTried: string[];
  diffBytes?: number;
  errorCode?: string;
  debug?: string;
};

type GcmResult = { ok: boolean; message: string; details: GcmDetails };

async function runGit(repoPath: string, args: string[]) {
  return execFileAsync("git", ["-C", repoPath, ...args], { maxBuffer: 8 * 1024 * 1024 });
}

function parseArgs(raw: string): { repoPath: string; customInstructions?: string; branchName?: string } | null {
  const matches = raw.match(/"[^"]+"|'[^']+'|\S+/g);
  if (!matches || matches.length === 0) return null;
  const tokens = matches.map((t) => t.replace(/^['"]|['"]$/g, ""));
  const repoPath = tokens[0].startsWith("@") ? tokens[0].slice(1) : tokens[0];
  if (tokens.length === 1) return { repoPath };
  if (tokens.length === 2) return { repoPath, customInstructions: tokens[1] };
  return { repoPath, customInstructions: tokens[1], branchName: tokens[2] };
}

function buildErrorMessage(base: string, details: GcmDetails): string {
  const model = details.modelUsed ?? details.modelSelected;
  const lines = [
    base,
    `error_code=${details.errorCode ?? "unknown"}`,
    `model=${model}${details.fast ? " (fast)" : ""}`,
    `repo=${details.repoPath}`,
    `branch_requested=${details.branchRequested ?? "(none)"}`,
    `branch_used=${details.branchUsed ?? "(unknown)"}`,
    `diff_bytes=${details.diffBytes ?? 0}`,
    `tried=${details.modelTried.join(",") || "none"}`,
  ];
  if (details.commits?.length) {
    lines.push(`committed_before_failure=${details.commits.map((c) => `${c.hash} ${c.message}`).join(" | ")}`);
  }
  if (details.debug) lines.push(`debug=${details.debug}`);
  return lines.join("\n");
}

async function resolveBranch(repoPath: string, requested?: string): Promise<{ ok: true; branchUsed: string } | { ok: false; code: string; debug: string }> {
  if (requested) {
    try {
      await runGit(repoPath, ["checkout", requested]);
      return { ok: true, branchUsed: requested };
    } catch (e) {
      return { ok: false, code: "branch_checkout_failed", debug: e instanceof Error ? e.message : "checkout failed" };
    }
  }
  try {
    const head = await runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return { ok: true, branchUsed: `${head.stdout || ""}`.trim() || "HEAD" };
  } catch (e) {
    return { ok: false, code: "branch_detect_failed", debug: e instanceof Error ? e.message : "branch detect failed" };
  }
}

async function getAllChangedFiles(repoPath: string): Promise<string[]> {
  const [staged, unstaged, untracked] = await Promise.all([
    runGit(repoPath, ["diff", "--name-only", "--cached"]),
    runGit(repoPath, ["diff", "--name-only"]),
    runGit(repoPath, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  const files = new Set<string>();
  for (const chunk of [staged.stdout, unstaged.stdout, untracked.stdout]) {
    `${chunk || ""}`
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((f) => files.add(f));
  }
  return [...files];
}

async function generateMessage(
  ask: AskContext,
  diff: string,
  history: string[],
  customInstructions: string | undefined,
): Promise<string> {
  const sections: string[] = [];
  if (history.length > 0) {
    sections.push(`Example commit messages from this project (follow their convention):\n${history.map((h) => `- ${h}`).join("\n")}`);
  }
  if (customInstructions?.trim()) {
    sections.push(`Custom instructions:\n${customInstructions.trim()}`);
  }
  sections.push(`Diff:\n${diff.slice(0, 120000)}`);

  const text = await askModel(ask, MESSAGE_PROMPT, sections.join("\n\n"));
  return text.split("\n")[0]?.trim() || "";
}

async function buildPlan(ask: AskContext, files: string[], history: string[]): Promise<string[][]> {
  const payload: Record<string, unknown> = { files };
  if (history.length > 0) payload.recentCommits = history.slice(0, 20);

  const raw = (await askModel(ask, PLAN_PROMPT, JSON.stringify(payload))).trim();

  try {
    const parsed = JSON.parse(raw) as { commits?: Array<{ files?: string[] }> };
    const commits = (parsed.commits || []).map((c) => (c.files || []).filter(Boolean));
    if (commits.length === 0) return [files];

    const allowed = new Set(files);
    const seen = new Set<string>();
    for (const group of commits) {
      for (const f of group) {
        if (!allowed.has(f)) return [files];
        if (seen.has(f)) return [files];
        seen.add(f);
      }
    }
    if (seen.size !== files.length) return [files];
    return commits;
  } catch {
    return [files];
  }
}

async function getBranchStatus(repoPath: string): Promise<string> {
  try {
    const status = await runGit(repoPath, ["status", "--porcelain=2", "--branch"]);
    const lines = `${status.stdout || ""}`.split("\n").map((line) => line.trim());
    const abLine = lines.find((line) => line.startsWith("# branch.ab "));
    if (abLine) {
      const match = abLine.match(/# branch\.ab \+(-?\d+) -(-?\d+)/);
      if (match) return `ahead ${match[1]}, behind ${match[2]}`;
    }

    const upstreamLine = lines.find((line) => line.startsWith("# branch.upstream "));
    if (!upstreamLine) return "no upstream";
    return "up to date";
  } catch {
    return "unknown";
  }
}

async function stageFiles(repoPath: string, files: string[]): Promise<{ ok: true } | { ok: false; code: string; debug: string }> {
  try {
    await runGit(repoPath, ["reset", "--", "."]);
    if (files.length > 0) await runGit(repoPath, ["add", "-A", "--", ...files]);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: "git_stage_failed", debug: e instanceof Error ? e.message : "stage failed" };
  }
}

async function commitStaged(repoPath: string, message: string): Promise<{ ok: true; hash: string } | { ok: false; code: string; debug: string }> {
  try {
    await runGit(repoPath, ["commit", "-m", message]);
    const hash = await runGit(repoPath, ["rev-parse", "--short", "HEAD"]);
    return { ok: true, hash: `${hash.stdout || ""}`.trim() || "unknown" };
  } catch (e) {
    return { ok: false, code: "git_commit_failed", debug: e instanceof Error ? e.message : "commit failed" };
  }
}

type ProgressSink = (line: string) => void;

/**
 * Widget above the editor, so the run is visible even when the tool card is
 * folded away by lexlexlex-tool-groups. Two lines: what is running (model and
 * tier, which never change mid-run) and how far along it is.
 */
const WIDGET_KEY = "gcm";

function setGcmWidget(ctx: ExtensionContext, header: string, detail?: string): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, detail ? [header, detail] : [header], { placement: "aboveEditor" });
}

function clearGcmWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, undefined);
}

/** Elapsed time for the whole run, used by the final widget line. */
function totalElapsed(progress: GcmProgress, now = Date.now()): string {
  return formatDuration(now - progress.beganAt);
}

/**
 * Provider failures throw instead of returning a soft result: a commit run that
 * cannot reach the model means the provider is not answering, and the caller
 * decides how loudly to stop (the tool aborts the turn).
 */
/** Turn a model-layer failure into a loud, detailed error the caller must surface. */
function providerFailure(
  cause: unknown,
  baseDetails: GcmDetails,
  modelKey: GcmModelRef,
  progress: GcmProgress,
  commits: CommitItem[],
): GcmProviderError {
  const debug =
    cause instanceof GcmProviderError
      ? `${cause.message}${cause.debug ? ` (${cause.debug})` : ""}`
      : cause instanceof Error
        ? cause.message
        : String(cause);
  const details: GcmDetails = {
    ...baseDetails,
    modelUsed: modelKey,
    fast: progress.fast,
    errorCode: "model_request_failed",
    debug,
    commits,
  };
  const warning =
    commits.length > 0
      ? `${commits.length} commit(s) were created before this failure; the remaining files are still staged/unstaged.`
      : "Provider is not answering; nothing was committed.";
  return new GcmProviderError(
    buildErrorMessage("Model request failed.", details),
    warning,
    cause instanceof GcmProviderError ? cause.debug : undefined,
  );
}

async function generateAndCommit(
  repoPathRaw: string,
  customInstructions: string | undefined,
  branchName: string | undefined,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  onProgress: ProgressSink | undefined,
): Promise<GcmResult> {
  const repoPath = resolve(repoPathRaw);
  const normalizedInstructions = customInstructions?.trim() || undefined;
  const choice = resolveGcmChoice(ctx);
  const modelTried: string[] = [];
  const detailsForFailure = (): GcmDetails => ({ ...baseDetails });
  const { serviceTier } = loadGcmConfig(ctx);
  const modelSelected: GcmModelRef =
    choice?.ref ?? readGcmSelection(ctx) ?? DEFAULT_GCM_MODEL;
  const baseDetails: GcmDetails = {
    repoPath,
    repoName: basename(repoPath),
    branchRequested: branchName,
    customInstructions: normalizedInstructions,
    modelSelected,
    thinkingLevel: choice?.thinkingLevel,
    modelTried,
  };
  const progress = beginProgress(
    modelSelected,
    serviceTier === "fast" && Boolean(choice) && supportsFastTier(choice!.model),
  );
  // Rebuilt on every publish: the tier and thinking level only settle once the
  // target model is resolved, and both stay on screen after the run.
  const header = () => `gcm · ${modelSelected}${modelQualifiers(progress.fast, choice?.thinkingLevel, choice?.model.reasoning)}`;
  const publish = () => {
    setGcmWidget(ctx, header(), formatProgressDetail(progress));
    onProgress?.(formatProgress(progress));
  };
  const finishWidget = (detail: string) => setGcmWidget(ctx, header(), detail);

  try {
    if (!existsSync(repoPath)) {
      clearGcmWidget(ctx);
      const details = { ...baseDetails, errorCode: "path_missing" };
      return { ok: false, message: buildErrorMessage("Path does not exist.", details), details };
    }

    try {
      await runGit(repoPath, ["rev-parse", "--is-inside-work-tree"]);
    } catch (e) {
      clearGcmWidget(ctx);
      const details = { ...baseDetails, errorCode: "not_git_repo", debug: e instanceof Error ? e.message : "git check failed" };
      return { ok: false, message: buildErrorMessage("Invalid git repository path.", details), details };
    }

    const branchResult = await resolveBranch(repoPath, branchName);
    if (!branchResult.ok) {
      clearGcmWidget(ctx);
      const details = { ...baseDetails, errorCode: branchResult.code, debug: branchResult.debug };
      return { ok: false, message: buildErrorMessage("Failed to prepare branch.", details), details };
    }
    baseDetails.branchUsed = branchResult.branchUsed;

    const history = await getRecentCommitSubjects(repoPath);

    const files = await getAllChangedFiles(repoPath);
    if (files.length === 0) {
      clearGcmWidget(ctx);
      const details = { ...baseDetails, errorCode: "no_changes", diffBytes: 0 };
      return { ok: false, message: buildErrorMessage("No changes found.", details), details };
    }

    if (!choice) {
      clearGcmWidget(ctx);
      const details = { ...baseDetails, errorCode: "no_models_available" };
      return {
        ok: false,
        message: buildErrorMessage("No model is available in this session's scope.", details),
        details,
      };
    }

    const modelKey = choice.ref;
    modelTried.push(modelKey);
    setProgressPhase(progress, `splitting ${files.length} file(s)`);
    publish();

    const ask: AskContext = {
      ctx,
      model: choice.model,
      reasoning: choice.thinkingLevel,
      tier: serviceTier,
      progress,
      signal,
      onTick: publish,
    };

    let plan: string[][];
    try {
      plan = await buildPlan(ask, files, history);
    } catch (e) {
      throw providerFailure(e, baseDetails, modelKey, progress, []);
    }
    const commits: CommitItem[] = [];

    for (const [index, group] of plan.entries()) {
      const staged = await stageFiles(repoPath, group);
      if (!staged.ok) {
        finishWidget(`failed: ${staged.code} · ${totalElapsed(progress)}`);
        const details = { ...baseDetails, modelUsed: modelKey, errorCode: staged.code, debug: staged.debug, commits };
        return { ok: false, message: buildErrorMessage("Failed to stage files.", details), details };
      }

      const stagedDiff = await runGit(repoPath, ["diff", "--cached", "--", "."]);
      const diffText = `${stagedDiff.stdout || ""}`.trim();
      if (!diffText) continue;

      setProgressPhase(progress, `commit ${index + 1}/${plan.length} message`);
      publish();

      let message = "";
      try {
        message = await generateMessage(ask, diffText, history, normalizedInstructions);
      } catch (e) {
        throw providerFailure(e, baseDetails, modelKey, progress, commits);
      }

      if (!message) {
        finishWidget(`failed: empty_response · ${totalElapsed(progress)}`);
        const details = { ...baseDetails, modelUsed: modelKey, errorCode: "empty_response", commits };
        return { ok: false, message: buildErrorMessage("Model returned empty text response.", details), details };
      }

      const committed = await commitStaged(repoPath, message);
      if (!committed.ok) {
        finishWidget(`failed: ${committed.code} · ${totalElapsed(progress)}`);
        const details = { ...baseDetails, modelUsed: modelKey, errorCode: committed.code, debug: committed.debug, commits };
        return { ok: false, message: buildErrorMessage("git commit failed.", details), details };
      }

      commits.push({ branch: branchResult.branchUsed, message, hash: committed.hash, files: group });
      publish();
    }

    if (commits.length === 0) {
      clearGcmWidget(ctx);
      const details = { ...baseDetails, modelUsed: modelKey, errorCode: "no_commits_created" };
      return { ok: false, message: buildErrorMessage("No commits were created.", details), details };
    }

    const details: GcmDetails = {
      ...baseDetails,
      modelUsed: modelKey,
      fast: progress.fast,
      branchStatus: await getBranchStatus(repoPath),
      commits,
    };
    finishWidget(`${commits.length} commit(s) · ${totalElapsed(progress)} · ${details.branchUsed ?? "unknown branch"}`);
    const summary = commits.map((c, i) => `${i + 1}. ${c.message} (${c.hash})`).join("\n");
    return { ok: true, message: summary, details };
  } catch (e) {
    if (e instanceof GcmProviderError) {
      finishWidget(`failed after ${totalElapsed(progress)} · see transcript`);
      throw e;
    }
    const details = { ...detailsForFailure(), errorCode: "unexpected_exception", debug: e instanceof Error ? e.message : "unknown" };
    return { ok: false, message: buildErrorMessage("Unexpected error.", details), details };
  }
}

export default function gcmExtension(pi: ExtensionAPI) {
  pi.registerMessageRenderer(GCM_REPORT_TYPE, (message, _options, theme) => {
    const details = message.details as
      | { repoName?: string; branchUsed?: string; branchStatus?: string; commits?: CommitItem[]; model?: string; fast?: boolean }
      | undefined;
    const commits = details?.commits || [];

    let out = theme.fg("accent", theme.bold("GCM Report"));
    if (details?.model) out += `\n${theme.fg("dim", "model:")} ${theme.fg("text", `${details.model}${details.fast ? " fast" : ""}`)}`;
    if (details?.repoName) out += `\n${theme.fg("dim", "repo:")} ${theme.fg("text", details.repoName)}`;
    if (details?.branchUsed) out += `\n${theme.fg("dim", "branch:")} ${theme.fg("text", details.branchUsed)}`;
    if (details?.branchStatus) out += `\n${theme.fg("dim", "status:")} ${theme.fg("text", details.branchStatus)}`;
    if (commits.length === 0) {
      out += `\n${theme.fg("dim", "No commits to report")}`;
      return new Text(out, 0, 0);
    }

    for (const [idx, c] of commits.entries()) {
      out += `\n${theme.fg("muted", `#${idx + 1}`)}`;
      out += `\n${theme.fg("dim", "branch:")} ${theme.fg("text", c.branch)}`;
      out += `\n${theme.fg("dim", "message:")} ${theme.fg("text", c.message)}`;
      out += `\n${theme.fg("dim", "hash:")} ${theme.fg("text", c.hash)}`;
    }
    return new Text(out, 0, 0);
  });

  pi.registerTool({
    name: "get_commit_message",
    label: "Get Commit Message",
    description: "Generate commit message(s) and commit in repo (optional branch)",
    parameters: ToolParams,
    async execute(_toolCallId, params: ToolInput, signal, onUpdate, ctx) {
      const choice = resolveGcmChoice(ctx);
      const selected = choice?.ref ?? readGcmSelection(ctx) ?? DEFAULT_GCM_MODEL;
      let latest: GcmDetails["progress"];
      try {
        const result = await generateAndCommit(
          params.repoPath,
          params.customInstructions,
          params.branchName,
          ctx,
          signal,
          (line) => {
            latest = line;
            onUpdate?.({
              content: [{ type: "text", text: line }],
              details: { modelSelected: selected, modelUsed: selected, progress: line, modelTried: [selected] },
            });
          },
        );
        return { content: [{ type: "text", text: result.message }], details: result.details, isError: !result.ok };
      } catch (e) {
        // A provider failure is bigger than one commit run: report it in the
        // transcript, stop the turn, and let Pi render the tool as failed.
        const message = e instanceof Error ? e.message : "gcm failed";
        const hint = e instanceof GcmProviderError && e.hint ? `\n${e.hint}` : "";
        ctx.ui.notify(`[gcm] ${message}${hint}`, "error");
        ctx.abort();
        throw e instanceof Error ? e : new Error(message);
      } finally {
        latest = undefined;
      }
    },
    renderCall(args, theme) {
      const custom = args.customInstructions ? theme.fg("dim", " +custom") : "";
      const branch = args.branchName ? theme.fg("dim", ` @${args.branchName}`) : "";
      return new Text(theme.fg("toolTitle", theme.bold("gcm ")) + theme.fg("accent", args.repoPath) + custom + branch, 0, 0);
    },
    renderResult(result, _options, theme, context) {
      const details = result.details as GcmDetails | undefined;
      const label = details?.modelUsed ?? details?.modelSelected;
      const marker = label
        ? theme.fg("accent", `[${label}${details?.fast ? " fast" : ""}] `)
        : theme.fg("dim", "[no-model] ");
      if (context.isPartial && details?.progress) {
        return new Text(marker + theme.fg("muted", details.progress), 0, 0);
      }
      const text = result.content.find((c) => c.type === "text");
      const body = text?.type === "text" ? text.text : "";
      return new Text(marker + (context.isError ? theme.fg("error", body) : theme.fg("success", body)), 0, 0);
    },
  });

  pi.registerCommand("gcm", {
    description: "Generate+commit: /gcm [path-to-git-repo] ['initial custom instructions'] ['branch-name']",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args.trim());
      if (!parsed?.repoPath) {
        ctx.ui.notify("Usage: /gcm [path-to-git-repo] ['initial custom instructions'] ['branch-name']", "error");
        return;
      }

      let customInstructions = parsed.customInstructions?.trim() || "";
      if (ctx.hasUI) {
        const edited = await ctx.ui.editor(
          "GCM custom instructions",
          customInstructions,
        );
        if (edited === undefined) {
          ctx.ui.notify("/gcm cancelled", "info");
          return;
        }
        customInstructions = edited.trim();
      }

      const choice = resolveGcmChoice(ctx);
      if (!choice) {
        ctx.ui.notify("/gcm: no model is available in this session's scope", "error");
        return;
      }
      const customSuffix = customInstructions ? " +custom instructions" : "";
      const suffix = parsed.branchName ? ` on ${parsed.branchName}` : "";
      const { serviceTier } = loadGcmConfig(ctx);
      const fast = serviceTier === "fast" && supportsFastTier(choice.model);
      ctx.ui.notify(
        `Started /gcm: ${choice.ref}${modelQualifiers(fast, choice.thinkingLevel, choice.model.reasoning)}${customSuffix}${suffix}`,
        "info",
      );

      // Live state lives in the widget (set inside generateAndCommit), so both
      // the command and the tool show the same thing.
      void generateAndCommit(parsed.repoPath, customInstructions || undefined, parsed.branchName, ctx, undefined, undefined)
        .then((result) => {
          if (!result.ok) {
            ctx.ui.notify(result.message, "error");
            return;
          }

          pi.sendMessage({
            customType: GCM_REPORT_TYPE,
            content: "gcm report",
            details: {
              repoName: result.details.repoName,
              branchUsed: result.details.branchUsed,
              branchStatus: result.details.branchStatus,
              commits: result.details.commits || [],
              model: result.details.modelUsed ?? result.details.modelSelected,
              fast: result.details.fast,
            },
            display: true,
          });

          ctx.ui.notify(`Created ${result.details.commits?.length || 0} commit(s).`, "info");
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : "unknown";
          const hint = e instanceof GcmProviderError && e.hint ? `\n${e.hint}` : "";
          ctx.ui.notify(`[gcm] ${message}${hint}`, "error");
        });
    },
  });

  pi.registerCommand("gcm-model", {
    description: "Select the model /gcm commits with (defaults to the session's scoped models)",
    handler: async (args, ctx) => {
      const choices = gcmModelChoices(ctx);
      if (choices.length === 0) {
        ctx.ui.notify("/gcm-model: no model is available", "error");
        return;
      }

      const current = resolveGcmChoice(ctx)?.ref ?? DEFAULT_GCM_MODEL;
      const raw = args.trim().toLowerCase();
      const matches = raw
        ? choices.filter(
            (choice) =>
              choice.ref.toLowerCase() === raw ||
              choice.model.id.toLowerCase() === raw ||
              choice.ref.toLowerCase().endsWith(`/${raw}`),
          )
        : [];

      let selected: GcmModelRef | null = null;
      if (raw && matches.length === 1) {
        selected = matches[0].ref;
      } else if (raw && matches.length === 0) {
        ctx.ui.notify(`/gcm-model: no scoped model matches '${args.trim()}'`, "error");
        return;
      } else {
        const picked = await ctx.ui.select(
          "Select /gcm model",
          choices.map((choice) => `${choice.ref}${choice.ref === current ? " (current)" : ""}`),
        );
        if (!picked) return;
        selected = picksRef(picked, choices, current);
      }

      pi.appendEntry("gcm-model", { selected });
      ctx.ui.notify(`gcm model set to ${selected}`, "info");
    },
  });
}

/** The select() result is a label; match it back to its model reference. */
function picksRef(picked: string, choices: GcmChoice[], current: GcmModelRef): GcmModelRef {
  const label = picked.replace(/ \(current\)$/, "");
  const match = choices.find((choice) => choice.ref === label);
  return match?.ref ?? current;
}
