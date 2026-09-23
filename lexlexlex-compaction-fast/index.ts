/**
 * Local fork of pi-compaction-model (JMHSV, MIT, v0.1.0) adding Fast mode
 * support. Fast mode is OpenAI's `service_tier: "priority" | "fast"`, renamed
 * from Priority processing on 2026-07-30 and billed at 2x standard rates.
 *
 * Everything from upstream is unchanged: a dedicated model handles Pi's native
 * compaction (same prompts, same algorithm) and the active model is kept as a
 * fallback for every failure path. The addition is an optional
 * `compactionModel.serviceTier` that is injected into the compaction request
 * through Pi's `streamFn` hook, so Pi's own service-tier cost accounting still
 * applies (its multiplier only recognizes `priority` and `flex`).
 *
 * Settings (global or project):
 *   { "compactionModel": {
 *       "model": "openai/gpt-6-luna",
 *       "thinkingLevel": "high",
 *       "serviceTier": "priority",   // default | flex | priority | fast
 *       "reasons": ["manual", "threshold", "overflow"]
 *   } }
 *
 * Omit `serviceTier` to send the standard tier. `false` as the section value
 * disables the extension entirely.
 */
import {
  compact,
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { calculateCost, type Api, type Model } from "@earendil-works/pi-ai";
import { Loader } from "@earendil-works/pi-tui";

export const COMPACTION_REASONS = ["manual", "threshold", "overflow"] as const;
export type CompactionReason = (typeof COMPACTION_REASONS)[number];

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const SERVICE_TIERS = ["default", "flex", "priority", "fast"] as const;
export type ServiceTier = (typeof SERVICE_TIERS)[number];

/**
 * APIs whose request builder forwards a service tier into the request body
 * (see pi-ai `api/openai-responses.js` and `api/openai-codex-responses.js`).
 * The ChatGPT Codex backend behind `openai-codex` accepts `priority` as well —
 * that is what MultiCodex's `/fast` sends — so both endpoints qualify here.
 */
const SERVICE_TIER_APIS = new Set<string>([
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);

function supportsServiceTier(model: Model<Api>): boolean {
  if (!SERVICE_TIER_APIS.has(model.api)) return false;
  return model.api === "openai-codex-responses" ? isOfficialCodexModel(model) : true;
}

/**
 * Only the official ChatGPT Codex endpoint accepts a Codex service tier, and only
the advertised model ids carry the Fast credit multipliers. Mirrors
`isOfficialCodexModel` and `CODEX_FAST_MODEL_IDS` in `lexlexlex-multicodex/fast.ts`.
 */
export function isOfficialCodexModel(model: Model<Api>): boolean {
  if (model.provider !== "openai-codex" || model.api !== "openai-codex-responses") return false;
  try {
    return new URL(String(model.baseUrl)).origin === "https://chatgpt.com";
  } catch {
    return false;
  }
}

/**
 * `fast` and `priority` name the same tier. Sending `priority` keeps Pi's own
 * Codex accounting in step, since its multiplier table only knows that value.
 */
export function requestServiceTier(serviceTier: ServiceTier, model: Model<Api>): ServiceTier {
  return serviceTier === "fast" && model.provider === "openai-codex" ? "priority" : serviceTier;
}

export interface CompactionModelConfig {
  model: string;
  thinkingLevel?: ThinkingLevel;
  serviceTier?: ServiceTier;
  reasons: CompactionReason[];
}

type UnknownRecord = Record<string, unknown>;
type Warn = (message: string) => void;
type NoticeLevel = "warning" | "error";

/**
 * Pi renders a notification inside the transcript: `warning` and `error` become
 * `Warning: ...` / `Error: ...` lines above the composer, so a compaction problem
 * stays readable in the chat instead of fighting the TUI. A later successful
 * compaction redraws the transcript from session entries and clears them, which
 * is why nothing here pretends to be durable.
 */
function notice(ctx: ExtensionContext, level: NoticeLevel, message: string, error?: unknown): void {
  const detail = error instanceof Error ? error.message : error === undefined ? "" : String(error);
  const text = (detail ? `${message} ${detail}` : message).replace(/\s+/g, " ").slice(0, 500);
  if (ctx.hasUI) {
    ctx.ui.notify(`[compaction-fast] ${text}`, level);
  } else {
    console.warn(`[lexlexlex-compaction-fast] ${text}`);
  }
}

function warn(ctx: ExtensionContext, message: string, error?: unknown): void {
  notice(ctx, "warning", message, error);
}

function fail(ctx: ExtensionContext, message: string, error?: unknown): void {
  notice(ctx, "error", message, error);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The line Pi shows while a compaction runs ("Compacting context... (esc to
 * cancel)") is built inside Pi's own `CompactionStatusIndicator`, whose message
 * is not reachable from the public extension UI context. `Loader.updateDisplay`
 * reads `this.message` on every paint and is resolved through the prototype, so
 * wrapping that one method is enough to relabel the indicator while it spins —
 * the spinner repaints on its own interval, so no extra render request is
 * needed. The wrapper is inert unless a compaction of ours is in flight.
 */
const loaderPrototype = Loader.prototype as unknown as {
  updateDisplay: (this: { message?: unknown }, ...args: unknown[]) => unknown;
  __compactionFastLabeling?: boolean;
};

let indicatorLabel: string | undefined;

export function setCompactionIndicatorLabel(label: string | undefined): void {
  indicatorLabel = label;
}

function isCompactionMessage(message: string): boolean {
  return (
    message.startsWith("Compacting context") ||
    message.startsWith("Auto-compacting") ||
    message.startsWith("Context overflow detected")
  );
}

function describeCompactionMessage(message: string, descriptor: string): string {
  if (message.startsWith("Compacting context")) {
    return message.replace("Compacting context", `Compacting with ${descriptor}`);
  }
  return message.replace("Auto-compacting", `Auto-compacting with ${descriptor}`);
}

export function installCompactionIndicatorLabeling(): void {
  if (loaderPrototype.__compactionFastLabeling) return;
  const original = loaderPrototype.updateDisplay;
  if (typeof original !== "function") return;

  loaderPrototype.__compactionFastLabeling = true;
  loaderPrototype.updateDisplay = function (this: { message?: unknown }, ...args: unknown[]) {
    const label = indicatorLabel;
    const message = this.message;
    if (!label || typeof message !== "string" || !isCompactionMessage(message)) {
      return original.apply(this, args);
    }
    this.message = describeCompactionMessage(message, label);
    try {
      return original.apply(this, args);
    } finally {
      this.message = message;
    }
  };
}

/**
 * Drop null-valued header entries. pi's provider auth resolves a missing header
 * to null to mark it deleted, and `compact()` takes a plain string map.
 */
function definedHeaders(
  headers: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const defined = Object.entries(headers).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return defined.length > 0 ? Object.fromEntries(defined) : undefined;
}

function section(settings: unknown): unknown {
  return isRecord(settings) ? settings.compactionModel : undefined;
}

export function resolveConfig(
  globalSettings: unknown,
  projectSettings: unknown,
  warnFn: Warn = (message) => console.warn(`[lexlexlex-compaction-fast] ${message}`),
): CompactionModelConfig | null {
  const globalSection = section(globalSettings);
  const projectSection = section(projectSettings);

  if (projectSection === false) return null;
  if (globalSection === false && projectSection === undefined) return null;

  const raw: UnknownRecord = {
    ...(isRecord(globalSection) ? globalSection : {}),
    ...(isRecord(projectSection) ? projectSection : {}),
  };

  if (raw.enabled === false) return null;

  if (typeof raw.model !== "string" || !raw.model.trim()) {
    if (globalSection !== undefined || projectSection !== undefined) {
      warnFn("compactionModel.model must be a non-empty provider/model string; using Pi's active model.");
    }
    return null;
  }

  let thinkingLevel: ThinkingLevel | undefined;
  if (raw.thinkingLevel !== undefined && raw.thinkingLevel !== null) {
    if (
      typeof raw.thinkingLevel === "string" &&
      (THINKING_LEVELS as readonly string[]).includes(raw.thinkingLevel)
    ) {
      thinkingLevel = raw.thinkingLevel as ThinkingLevel;
    } else {
      warnFn(`Invalid thinkingLevel '${String(raw.thinkingLevel)}'; using the provider default.`);
    }
  }

  let serviceTier: ServiceTier | undefined;
  if (raw.serviceTier !== undefined && raw.serviceTier !== null) {
    if (
      typeof raw.serviceTier === "string" &&
      (SERVICE_TIERS as readonly string[]).includes(raw.serviceTier)
    ) {
      serviceTier = raw.serviceTier as ServiceTier;
    } else {
      warnFn(
        `Invalid serviceTier '${String(raw.serviceTier)}'; expected ${SERVICE_TIERS.join(", ")}. Using the standard tier.`,
      );
    }
  }

  let reasons: CompactionReason[] = [...COMPACTION_REASONS];
  if (raw.reasons !== undefined) {
    if (
      Array.isArray(raw.reasons) &&
      raw.reasons.every(
        (reason) =>
          typeof reason === "string" &&
          (COMPACTION_REASONS as readonly string[]).includes(reason),
      )
    ) {
      reasons = [...new Set(raw.reasons)] as CompactionReason[];
    } else {
      warnFn("reasons must contain only manual, threshold, or overflow; handling all reasons.");
    }
  }

  return {
    model: raw.model.trim(),
    thinkingLevel,
    serviceTier,
    reasons,
  };
}

export function loadConfig(ctx: ExtensionContext): CompactionModelConfig | null {
  const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
    projectTrusted: ctx.isProjectTrusted(),
  });

  return resolveConfig(
    settings.getGlobalSettings(),
    ctx.isProjectTrusted() ? settings.getProjectSettings() : undefined,
    (message) => warn(ctx, message),
  );
}

export function parseModelReference(reference: string): { provider: string; modelId: string } | null {
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) return null;

  const provider = reference.slice(0, separator).trim();
  const modelId = reference.slice(separator + 1).trim();
  return provider && modelId ? { provider, modelId } : null;
}

type CompactStreamFn = NonNullable<Parameters<typeof compact>[7]>;
type RegistryStreamOptions = NonNullable<
  Parameters<ExtensionContext["modelRegistry"]["streamSimple"]>[2]
>;

/**
 * Codex Fast bills 2.5x Standard credits for the GPT-6, GPT-5.6, and GPT-5.5
 * families and 2x for GPT-5.4. Mirrors `codexFastCreditMultiplier` in
 * `lexlexlex-multicodex/fast.ts`, which owns the same table for session
 * requests; Pi's own Codex adapter only knows a flat 2x.
 */
export const CODEX_FAST_CREDIT_MULTIPLIERS: Readonly<Record<string, number>> = {
  "gpt-5.4": 2,
  "gpt-5.5": 2.5,
  "gpt-5.6-luna": 2.5,
  "gpt-5.6-sol": 2.5,
  "gpt-5.6-terra": 2.5,
  "gpt-6-astra": 2.5,
  "gpt-6-luna": 2.5,
  "gpt-6-sol": 2.5,
};

const DEFAULT_CODEX_FAST_CREDIT_MULTIPLIER = 2.5;

export function codexFastCreditMultiplier(modelId: string): number {
  return CODEX_FAST_CREDIT_MULTIPLIERS[modelId] ?? DEFAULT_CODEX_FAST_CREDIT_MULTIPLIER;
}

/**
 * Route the summarization request through Pi's model runtime instead of calling
 * pi-ai's `streamSimple` directly.
 *
 * Auth and transport stay with the registered provider, so a wrapper such as
 * MultiCodex rotates ChatGPT Codex accounts and refreshes its OAuth tokens for
 * this request exactly as it does for session requests: `openai-codex/gpt-6-luna`
 * needs no OpenAI API key. The service tier still cannot travel as
 * `options.serviceTier`, because the provider's `streamSimple` rebuilds the
 * option bag through `buildBaseOptions`, which whitelists fields and drops
 * anything else; `onPayload` is on that whitelist and runs on the request body
 * right before it is sent.
 */
export function createCompactionStream(
  ctx: ExtensionContext,
  serviceTier?: ServiceTier,
): CompactStreamFn {
  return (model, context, options) => {
    if (!serviceTier) {
      return ctx.modelRegistry.streamSimple(model, context, options as RegistryStreamOptions);
    }

    const previousOnPayload = options?.onPayload;
    const requestOptions = {
      ...options,
      onPayload: async (payload: Record<string, unknown>, target: typeof model) => {
        const base = ((await previousOnPayload?.(payload, target)) ?? payload) as Record<string, unknown>;
        return { ...base, service_tier: serviceTier };
      },
    } as RegistryStreamOptions;
    return ctx.modelRegistry.streamSimple(model, context, requestOptions);
  };
}

/**
 * Pi's Codex adapter prices a `priority` request at a flat 2x, but Fast billing
 * is 2.5x for GPT-6, GPT-5.6, and GPT-5.5 and 2x for GPT-5.4, and the adapter
 * only applies a multiplier when the tier travelled through
 * `options.serviceTier`, which the provider drops. Recompute the summary cost
 * from the model's own rates and apply the real multiplier, the way MultiCodex
 * corrects session messages.
 */
export function applyCodexFastCost<T extends { usage?: unknown }>(
  model: Model<Api>,
  result: T,
  serviceTier: ServiceTier | undefined,
): T {
  if (serviceTier !== "priority" && serviceTier !== "fast") return result;
  if (!isOfficialCodexModel(model)) return result;
  if (!(model.id in CODEX_FAST_CREDIT_MULTIPLIERS)) return result;

  const usage = isRecord(result.usage) ? result.usage : undefined;
  const cost = usage && isRecord(usage.cost) ? usage.cost : undefined;
  if (
    !usage ||
    !cost ||
    !["input", "output", "cacheRead", "cacheWrite"].every(
      (key) => typeof usage[key] === "number" && Number.isFinite(usage[key]),
    )
  ) {
    return result;
  }

  const correctedUsage = structuredClone(usage);
  calculateCost(model, correctedUsage as never);
  const correctedCost = (correctedUsage as { cost: Record<string, number> }).cost;
  const multiplier = codexFastCreditMultiplier(model.id);
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    correctedCost[key] *= multiplier;
  }
  return { ...result, usage: correctedUsage };
}

/**
 * Hook-provided compactions are marked as extension-generated by Pi. Native
 * preparation intentionally does not trust arbitrary extension details, so it
 * will not carry their file lists into a later compaction. Since this extension
 * returns Pi's own details shape, restore those lists before calling native
 * compact() again. Sets make this harmless for native previous entries too.
 */
function restorePreviousFileOperations(
  preparation: {
    fileOps: { read: Set<string>; edited: Set<string> };
  },
  branchEntries: Array<{ type: string; details?: unknown }>,
): void {
  const previous = [...branchEntries].reverse().find((entry) => entry.type === "compaction");
  if (!previous || typeof previous.details !== "object" || previous.details === null) return;

  const details = previous.details as {
    readFiles?: unknown;
    modifiedFiles?: unknown;
  };

  if (Array.isArray(details.readFiles)) {
    for (const path of details.readFiles) {
      if (typeof path === "string") preparation.fileOps.read.add(path);
    }
  }

  if (Array.isArray(details.modifiedFiles)) {
    for (const path of details.modifiedFiles) {
      if (typeof path === "string") preparation.fileOps.edited.add(path);
    }
  }
}

export default function compactionModelFast(pi: ExtensionAPI): void {
  installCompactionIndicatorLabeling();

  pi.on("session_before_compact", async (event, ctx) => {
    const config = loadConfig(ctx);
    if (!config || !config.reasons.includes(event.reason)) return;

    const reference = parseModelReference(config.model);
    if (!reference) {
      warn(ctx, `Invalid model '${config.model}'; expected provider/model. Using Pi's active model.`);
      return;
    }

    const model = ctx.modelRegistry.find(reference.provider, reference.modelId);
    if (!model) {
      warn(ctx, `Model not found: ${config.model}. Using Pi's active model.`);
      return;
    }

    if (config.serviceTier && !supportsServiceTier(model)) {
      warn(
        ctx,
        `serviceTier '${config.serviceTier}' is not forwarded for ${model.provider}/${model.id} (api '${model.api}'); using the standard tier.`,
      );
    }
    const serviceTier =
      config.serviceTier && supportsServiceTier(model)
        ? requestServiceTier(config.serviceTier, model)
        : undefined;

    // Label the spinner with what is actually about to run. Pi builds that line
    // before this hook fires, so the first frames still read as Pi wrote them.
    const descriptor = `${model.provider}/${model.id}${serviceTier ? " (fast)" : ""}`;

    try {
      setCompactionIndicatorLabel(descriptor);
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      // Codex requests are authenticated by the provider at request time - a
      // wrapper such as MultiCodex rotates managed accounts and refreshes its
      // own OAuth tokens - so a stale stored Codex credential must not veto the
      // route here. Other providers keep the preflight, which turns a missing
      // credential into one clear message instead of a stream error.
      if (!auth.ok && model.provider !== "openai-codex") {
        const hint =
          model.provider === "openai"
            ? " Run /login openai for an API key, or point compactionModel at openai-codex/<model> to use MultiCodex accounts."
            : "";
        warn(ctx, `Authentication failed for ${config.model}: ${auth.error}. Using Pi's active model.${hint}`);
        return;
      }

      restorePreviousFileOperations(event.preparation, event.branchEntries);

      const result = await compact(
        event.preparation,
        model,
        auth.ok ? auth.apiKey : undefined,
        auth.ok ? definedHeaders(auth.headers) : undefined,
        event.customInstructions,
        event.signal,
        config.thinkingLevel,
        createCompactionStream(ctx, serviceTier),
        auth.ok ? auth.env : undefined,
      );

      return { compaction: applyCodexFastCost(model, result, serviceTier) };
    } catch (error) {
      if (!event.signal?.aborted) {
        fail(ctx, `Compaction with ${config.model} failed; using Pi's active model.`, error);
      }
      return;
    } finally {
      setCompactionIndicatorLabel(undefined);
    }
  });
}
