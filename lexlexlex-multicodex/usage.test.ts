import { describe, expect, it } from 'vitest'
import {
  getExhaustedResetAt,
  getNextResetAt,
  isUsageAvailable,
  isUsageBlocked,
  parseCodexUsageResponse,
} from './usage'

describe('parseCodexUsageResponse', () => {
  it('reads the availability flags', () => {
    const parsed = parseCodexUsageResponse({
      rate_limit: {
        allowed: false,
        limit_reached: true,
        primary_window: { used_percent: 68, reset_at: 1000 },
        secondary_window: { used_percent: 100, reset_at: 2000 },
      },
    })

    expect(parsed.allowed).toBe(false)
    expect(parsed.limitReached).toBe(true)
    expect(parsed.primary).toEqual({ usedPercent: 68, resetAt: 1000 * 1000 })
    expect(parsed.secondary).toEqual({ usedPercent: 100, resetAt: 2000 * 1000 })
  })

  it('leaves the flags undefined when the response omits them', () => {
    const parsed = parseCodexUsageResponse({
      rate_limit: { primary_window: { used_percent: 0 } },
    })

    expect(parsed.allowed).toBeUndefined()
    expect(parsed.limitReached).toBeUndefined()
  })
})

describe('isUsageAvailable', () => {
  it('is true only when the API reports capacity', () => {
    expect(
      isUsageAvailable({ allowed: true, limitReached: false, fetchedAt: 0 }),
    ).toBe(true)
  })

  it('is false for a limited account, a missing field, or no snapshot', () => {
    expect(
      isUsageAvailable({ allowed: false, limitReached: true, fetchedAt: 0 }),
    ).toBe(false)
    expect(isUsageAvailable({ allowed: true, fetchedAt: 0 })).toBe(false)
    expect(isUsageAvailable({ fetchedAt: 0 })).toBe(false)
    expect(isUsageAvailable(undefined)).toBe(false)
  })
})

describe('isUsageBlocked', () => {
  it('is true when the API reports no capacity', () => {
    expect(
      isUsageBlocked({ allowed: false, limitReached: false, fetchedAt: 0 }),
    ).toBe(true)
    expect(
      isUsageBlocked({ allowed: true, limitReached: true, fetchedAt: 0 }),
    ).toBe(true)
  })

  it('is false when the API reports capacity or says nothing', () => {
    expect(
      isUsageBlocked({ allowed: true, limitReached: false, fetchedAt: 0 }),
    ).toBe(false)
    expect(isUsageBlocked({ fetchedAt: 0 })).toBe(false)
    expect(isUsageBlocked(undefined)).toBe(false)
  })
})

describe('getExhaustedResetAt', () => {
  it('uses the weekly reset when only the weekly window is exhausted', () => {
    expect(
      getExhaustedResetAt({
        primary: { usedPercent: 68, resetAt: 1_000 },
        secondary: { usedPercent: 100, resetAt: 900_000 },
        fetchedAt: 0,
      }),
    ).toBe(900_000)
  })

  it('uses the latest reset when both windows are exhausted', () => {
    expect(
      getExhaustedResetAt({
        primary: { usedPercent: 100, resetAt: 5_000 },
        secondary: { usedPercent: 100, resetAt: 900_000 },
        fetchedAt: 0,
      }),
    ).toBe(900_000)
  })

  it('returns undefined when no window is exhausted', () => {
    expect(
      getExhaustedResetAt({
        primary: { usedPercent: 99, resetAt: 5_000 },
        secondary: { usedPercent: 12, resetAt: 900_000 },
        fetchedAt: 0,
      }),
    ).toBeUndefined()
    expect(getExhaustedResetAt(undefined)).toBeUndefined()
  })

  it('ignores an exhausted window without a reset time', () => {
    expect(
      getExhaustedResetAt({
        primary: { usedPercent: 100 },
        secondary: undefined,
        fetchedAt: 0,
      }),
    ).toBeUndefined()
    expect(
      getNextResetAt({
        primary: { usedPercent: 100 },
        secondary: { usedPercent: 100, resetAt: 900_000 },
        fetchedAt: 0,
      }),
    ).toBe(900_000)
  })
})
