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
import { streamSimple } from "@earendil-works/pi-ai";

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
 * The ChatGPT codex backend is a subscription endpoint, not the OpenAI
 * platform API, so `openai-codex` stays out even though its API module would
 * accept the field.
 */
const SERVICE_TIER_APIS = new Set<string>([
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);

function supportsServiceTier(model: { api: string; provider: string }): boolean {
  return SERVICE_TIER_APIS.has(model.api) && model.provider !== "openai-codex";
}

export interface CompactionModelConfig {
  model: string;
  thinkingLevel?: ThinkingLevel;
  serviceTier?: ServiceTier;
  reasons: CompactionReason[];
}

type UnknownRecord = Record<string, unknown>;
type Warn = (message: string) => void;

function warn(message: string, error?: unknown): void {
  if (error === undefined) {
    console.warn(`[lexlexlex-compaction-fast] ${message}`);
  } else {
    console.warn(`[lexlexlex-compaction-fast] ${message}`, error);
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
type StreamRequestOptions = NonNullable<Parameters<typeof streamSimple>[2]>;

/**
 * Hand Pi's compaction summarization a stream that carries the service tier.
 *
 * `options.serviceTier` cannot be used here: the provider's `streamSimple`
 * rebuilds the option bag through `buildBaseOptions`, which whitelists fields
 * and drops anything else. `onPayload` is on that whitelist and is applied to
 * the request body right before it is sent, so the tier rides along while
 * everything else stays on Pi's normal summarization path. Pi's own cost
 * accounting then picks the tier up from the response (`service_tier`), which
 * is why `priority` is the default tier to send: it is the value Pi's cost
 * multiplier recognizes as 2x.
 */
export function createServiceTierStream(serviceTier: ServiceTier): CompactStreamFn {
  return (model, context, options) => {
    const previousOnPayload = options?.onPayload;
    const requestOptions = {
      ...options,
      onPayload: async (payload: Record<string, unknown>, target: typeof model) => {
        const base = ((await previousOnPayload?.(payload, target)) ?? payload) as Record<string, unknown>;
        return { ...base, service_tier: serviceTier };
      },
    } as StreamRequestOptions;
    return streamSimple(model, context, requestOptions);
  };
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
  pi.on("session_before_compact", async (event, ctx) => {
    const config = loadConfig(ctx);
    if (!config || !config.reasons.includes(event.reason)) return;

    const reference = parseModelReference(config.model);
    if (!reference) {
      warn(`Invalid model '${config.model}'; expected provider/model. Using Pi's active model.`);
      return;
    }

    const model = ctx.modelRegistry.find(reference.provider, reference.modelId);
    if (!model) {
      warn(`Model not found: ${config.model}. Using Pi's active model.`);
      return;
    }

    if (config.serviceTier && !supportsServiceTier(model)) {
      warn(
        `serviceTier '${config.serviceTier}' is not forwarded for ${model.provider}/${model.id} (api '${model.api}'); using the standard tier.`,
      );
    }
    const serviceTier = config.serviceTier && supportsServiceTier(model) ? config.serviceTier : undefined;

    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        warn(`Authentication failed for ${config.model}: ${auth.error}. Using Pi's active model.`);
        return;
      }

      restorePreviousFileOperations(event.preparation, event.branchEntries);

      const result = await compact(
        event.preparation,
        model,
        auth.apiKey,
        auth.headers,
        event.customInstructions,
        event.signal,
        config.thinkingLevel,
        serviceTier ? createServiceTierStream(serviceTier) : undefined,
        auth.env,
      );

      return { compaction: result };
    } catch (error) {
      if (!event.signal?.aborted) {
        warn(`Compaction with ${config.model} failed; using Pi's active model.`, error);
      }
      return;
    }
  });
}
