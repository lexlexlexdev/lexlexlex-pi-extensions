interface CodexUsageWindow {
  usedPercent?: number
  resetAt?: number
}

export interface CodexUsageSnapshot {
  primary?: CodexUsageWindow
  secondary?: CodexUsageWindow
  allowed?: boolean
  limitReached?: boolean
  fetchedAt: number
}

interface WhamUsageResponse {
  rate_limit?: {
    allowed?: boolean
    limit_reached?: boolean
    primary_window?: WhamUsageWindow
    secondary_window?: WhamUsageWindow
  }
}

type WhamUsageWindow = {
  reset_at?: number
  used_percent?: number
}

function normalizeUsedPercent(value?: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(100, Math.max(0, value))
}

function normalizeResetAt(value?: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value * 1000
}

function parseUsageWindow(
  window?: WhamUsageWindow,
): CodexUsageWindow | undefined {
  if (!window) return undefined
  const usedPercent = normalizeUsedPercent(window.used_percent)
  const resetAt = normalizeResetAt(window.reset_at)
  if (usedPercent === undefined && resetAt === undefined) return undefined
  return { usedPercent, resetAt }
}

export function parseCodexUsageResponse(
  data: WhamUsageResponse,
): Omit<CodexUsageSnapshot, 'fetchedAt'> {
  const rateLimit = data.rate_limit
  return {
    primary: parseUsageWindow(rateLimit?.primary_window),
    secondary: parseUsageWindow(rateLimit?.secondary_window),
    allowed: typeof rateLimit?.allowed === 'boolean' ? rateLimit.allowed : undefined,
    limitReached:
      typeof rateLimit?.limit_reached === 'boolean'
        ? rateLimit.limit_reached
        : undefined,
  }
}

/**
 * True only when the API says the account can send a request right now.
 * An absent snapshot, or an absent `allowed` field, returns false so that
 * callers keep an existing cooldown instead of guessing.
 */
export function isUsageAvailable(usage?: CodexUsageSnapshot): boolean {
  return usage?.allowed === true && usage.limitReached === false
}

/** True when the API reports that the account is out of capacity. */
export function isUsageBlocked(usage?: CodexUsageSnapshot): boolean {
  return usage?.allowed === false || usage?.limitReached === true
}

/**
 * Reset time of the usage windows that are fully used. An account stays
 * blocked until the last exhausted window resets, so return the latest of
 * those reset times. Returns undefined when no window is exhausted.
 */
export function getExhaustedResetAt(
  usage?: CodexUsageSnapshot,
): number | undefined {
  const resets = [usage?.primary, usage?.secondary]
    .filter(
      (window) =>
        window?.usedPercent !== undefined && window.usedPercent >= 100,
    )
    .map((window) => window?.resetAt)
    .filter((resetAt): resetAt is number => typeof resetAt === 'number')

  if (resets.length === 0) return undefined
  return Math.max(...resets)
}

export function isUsageUntouched(usage?: CodexUsageSnapshot): boolean {
  const primary = usage?.primary?.usedPercent
  const secondary = usage?.secondary?.usedPercent
  if (primary === undefined || secondary === undefined) return false
  return primary === 0 && secondary === 0
}

export function getNextResetAt(usage?: CodexUsageSnapshot): number | undefined {
  const candidates = [
    usage?.primary?.resetAt,
    usage?.secondary?.resetAt,
  ].filter((value): value is number => typeof value === 'number')
  if (candidates.length === 0) return undefined
  return Math.min(...candidates)
}

export function getMaxUsedPercent(
  usage?: CodexUsageSnapshot,
): number | undefined {
  const candidates = [
    usage?.primary?.usedPercent,
    usage?.secondary?.usedPercent,
  ].filter((value): value is number => typeof value === 'number')
  if (candidates.length === 0) return undefined
  return Math.max(...candidates)
}

export function getWeeklyResetAt(
  usage?: CodexUsageSnapshot,
): number | undefined {
  const resetAt = usage?.secondary?.resetAt
  return typeof resetAt === 'number' ? resetAt : undefined
}

export function formatResetAt(resetAt?: number): string {
  if (!resetAt) return 'unknown'
  const diffMs = resetAt - Date.now()
  if (diffMs <= 0) return 'now'
  const diffMinutes = Math.max(1, Math.round(diffMs / 60000))
  if (diffMinutes < 60) return `in ${diffMinutes}m`
  const diffHours = Math.round(diffMinutes / 60)
  if (diffHours < 48) return `in ${diffHours}h`
  const diffDays = Math.round(diffHours / 24)
  return `in ${diffDays}d`
}
