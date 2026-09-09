import type {
  Api,
  Model,
} from '@earendil-works/pi-ai'
import { calculateCost, hasApi } from '@earendil-works/pi-ai'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'

export const CODEX_FAST_SERVICE_TIER = 'priority'
export const CODEX_STANDARD_SERVICE_TIER = 'default'

export const CODEX_FAST_MODEL_IDS: ReadonlySet<string> = new Set([
  'gpt-5.4',
  'gpt-5.5',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
])

type MaybeModel = Model<Api> | undefined

export type CodexFastAvailability =
  | { kind: 'available'; enabled: boolean }
  | { kind: 'not-codex' }
  | { kind: 'unavailable'; reason: string }

export interface FastModeState {
  isEnabled(): boolean
  isEffective(model: MaybeModel): boolean
  reset(): void
  setEnabled(enabled: boolean): void
}

export interface FastModeRuntime {
  resetSession(): void
  toggle(ctx: ExtensionCommandContext): boolean
}

export function createFastModeState(): FastModeState {
  let enabled = false
  return {
    isEnabled: () => enabled,
    isEffective: (model) => codexFastIsEffective(model, enabled),
    reset: () => {
      enabled = false
    },
    setEnabled: (nextEnabled) => {
      enabled = nextEnabled
    },
  }
}

export function codexFastAvailability(
  model: MaybeModel,
  enabled: boolean,
): CodexFastAvailability {
  if (model?.provider !== 'openai-codex') return { kind: 'not-codex' }
  if (!isOfficialCodexModel(model)) {
    return {
      kind: 'unavailable',
      reason: 'Fast mode requires the official OpenAI Codex Responses endpoint.',
    }
  }
  if (!CODEX_FAST_MODEL_IDS.has(model.id)) {
    return {
      kind: 'unavailable',
      reason: `${model.id} does not advertise Codex Fast support.`,
    }
  }
  return { kind: 'available', enabled }
}

export function codexFastIsEffective(
  model: MaybeModel,
  enabled: boolean,
): boolean {
  return codexFastAvailability(model, enabled).kind === 'available' && enabled
}

export function codexFastRequestTier(
  model: MaybeModel,
  enabled: boolean,
): typeof CODEX_FAST_SERVICE_TIER | typeof CODEX_STANDARD_SERVICE_TIER | undefined {
  if (!isOfficialCodexModel(model)) return undefined
  return enabled && CODEX_FAST_MODEL_IDS.has(model.id)
    ? CODEX_FAST_SERVICE_TIER
    : CODEX_STANDARD_SERVICE_TIER
}

export function rewriteCodexFastPayload(
  payload: unknown,
  model: MaybeModel,
  enabled: boolean,
): unknown | undefined {
  const serviceTier = codexFastRequestTier(model, enabled)
  if (!serviceTier || !isRecord(payload)) return undefined
  return { ...payload, service_tier: serviceTier }
}

export function correctCodexFastMessageCost(
  message: unknown,
  model: MaybeModel,
  fastRequested: boolean,
): unknown | undefined {
  if (
    !codexFastIsEffective(model, fastRequested) ||
    !isRecord(message) ||
    message.role !== 'assistant' ||
    message.provider !== model?.provider ||
    message.model !== model?.id
  ) {
    return undefined
  }

  const usage = isRecord(message.usage) ? message.usage : undefined
  const cost = usage && isRecord(usage.cost) ? usage.cost : undefined
  if (
    !usage ||
    !cost ||
    !hasCompleteUsage(usage) ||
    !isOfficialCodexModel(model)
  ) {
    return undefined
  }

  const correctedUsage = structuredClone(usage) as typeof usage
  calculateCost(model, correctedUsage as never)
  const multiplier = model.id === 'gpt-5.5' ? 2.5 : 2
  const correctedCost = correctedUsage.cost as Record<string, number>
  for (const key of [
    'input',
    'output',
    'cacheRead',
    'cacheWrite',
    'total',
  ] as const) {
    correctedCost[key] *= multiplier
  }
  if (costsEqual(cost, correctedCost)) return undefined
  return { ...message, usage: correctedUsage }
}

export interface FastModeRegistrationOptions {
  rewriteRequests?: boolean
  registerCommand?: boolean
}

export function registerCodexFastMode(
  pi: ExtensionAPI,
  state: FastModeState,
  refreshStatus: (ctx: ExtensionContext) => void,
  options: FastModeRegistrationOptions = {},
): FastModeRuntime {
  const pendingFastRequests = new Map<string, PendingFastRequest>()

  const resetSession = (): void => {
    state.reset()
    pendingFastRequests.clear()
  }

  const toggle = (ctx: ExtensionCommandContext): boolean => {
    const availability = codexFastAvailability(ctx.model, state.isEnabled())
    if (availability.kind === 'not-codex') {
      ctx.ui.notify(
        '/fast is available only for the active OpenAI Codex model.',
        'warning',
      )
      return false
    }
    if (availability.kind === 'unavailable') {
      ctx.ui.notify(availability.reason, 'warning')
      return false
    }

    const enabled = !availability.enabled
    state.setEnabled(enabled)
    refreshStatus(ctx)
    ctx.ui.notify(
      enabled
        ? 'Codex Fast mode enabled for this session.'
        : 'Codex Fast mode disabled; standard routing will be used.',
      'info',
    )
    return true
  }

  if (options.registerCommand !== false) {
    pi.registerCommand('fast', {
      description: 'Toggle session-only Codex Fast mode',
      handler: async (args, ctx) => {
        if (args.trim()) {
          if (!ctx.hasUI) throw new Error('/fast does not accept arguments.')
          ctx.ui.notify('/fast does not accept arguments.', 'warning')
          return
        }
        if (!ctx.hasUI) throw new Error('/fast requires TUI or RPC mode.')
        toggle(ctx)
      },
    })
  }

  const recordFastRequest = (
    payload: unknown,
    ctx: ExtensionContext,
  ): void => {
    const key = activeRequestKey(ctx)
    if (key && ctx.model) {
      pendingFastRequests.set(key, {
        fastRequested:
          isRecord(payload) && payload.service_tier === CODEX_FAST_SERVICE_TIER,
        model: ctx.model,
      })
    }
  }

  pi.on('before_provider_request', (event, ctx) => {
    if (options.rewriteRequests === false) {
      // A native pi-subagents child already has a priority-tier hook. Observe
      // its final payload for cost correction without overwriting the tier.
      recordFastRequest(event.payload, ctx)
      return undefined
    }

    const rewritten = rewriteCodexFastPayload(
      event.payload,
      ctx.model,
      state.isEnabled(),
    )
    recordFastRequest(rewritten, ctx)
    return rewritten
  })

  pi.on('message_end', (event, ctx) => {
    const request = consumeFastRequest(ctx, event.message, pendingFastRequests)
    if (request === NO_FAST_REQUEST) return undefined
    const message = correctCodexFastMessageCost(
      event.message,
      request.model,
      request.fastRequested,
    )
    return message ? { message: message as never } : undefined
  })

  return { resetSession, toggle }
}

const NO_FAST_REQUEST = Symbol('no-fast-request')
type PendingFastRequest = { fastRequested: boolean; model: Model<Api> }

function activeRequestKey(ctx: ExtensionContext): string | undefined {
  const model = ctx.model
  return model
    ? `${ctx.sessionManager.getSessionId()}:${model.provider}/${model.id}`
    : undefined
}

function consumeFastRequest(
  ctx: ExtensionContext,
  message: unknown,
  pending: Map<string, PendingFastRequest>,
): PendingFastRequest | typeof NO_FAST_REQUEST {
  if (!isRecord(message) || message.role !== 'assistant') return NO_FAST_REQUEST
  const key = messageRequestKey(ctx, message)
  if (!key) return NO_FAST_REQUEST
  const request = pending.get(key)
  pending.delete(key)
  return request ?? NO_FAST_REQUEST
}

function messageRequestKey(
  ctx: ExtensionContext,
  message: Record<string, unknown>,
): string | undefined {
  if (typeof message.provider !== 'string' || typeof message.model !== 'string') {
    return undefined
  }
  return `${ctx.sessionManager.getSessionId()}:${message.provider}/${message.model}`
}

function isOfficialCodexModel(
  model: MaybeModel,
): model is Model<Api> & { api: 'openai-codex-responses' } {
  if (
    model?.provider !== 'openai-codex' ||
    !hasApi(model, 'openai-codex-responses')
  ) {
    return false
  }
  try {
    return new URL(model.baseUrl).origin === 'https://chatgpt.com'
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasCompleteUsage(value: Record<string, unknown>): boolean {
  return ['input', 'output', 'cacheRead', 'cacheWrite'].every(
    (key) => typeof value[key] === 'number' && Number.isFinite(value[key]),
  )
}

function costsEqual(
  left: Record<string, unknown>,
  right: Record<string, number>,
): boolean {
  return ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every(
    (key) => left[key] === right[key],
  )
}
