/**
 * Verifies that concurrent calls to ensureValidToken for the same expired
 * account only fire one real refresh request — not two.
 *
 * This is the race condition that caused:
 *   "Your refresh token has already been used to generate a new access token"
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}))

vi.mock('./provider', () => ({
  getOpenAICodexOAuth: () => ({
    login: vi.fn(),
    refresh: mocks.refresh,
    toAuth: vi.fn(),
    name: 'test OAuth',
  }),
}))

import { AccountManager } from './account-manager'

// Mock storage so no disk I/O.
vi.mock('./storage', () => ({
  loadStorage: () => ({
    accounts: [],
    activeEmail: undefined,
  }),
  saveStorage: vi.fn(),
}))

// Mock auth helpers so tests never touch the real ~/.pi/agent/auth.json.
vi.mock('./auth', () => ({
  loadImportedOpenAICodexAuth: vi.fn().mockResolvedValue(undefined),
}))

describe('AccountManager.ensureValidToken — concurrent refresh deduplication', () => {
  let manager: AccountManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new AccountManager()
  })

  it('fires only one refresh when two callers race on an expired token', async () => {
    // Arrange: account whose token expired 1 minute ago.
    const expiredAccount = {
      email: 'test@example.com',
      accessToken: 'old-access',
      refreshToken: 'the-refresh-token',
      expiresAt: Date.now() - 60_000,
    }

    let resolveRefresh!: (val: unknown) => void
    const refreshBarrier = new Promise((r) => {
      resolveRefresh = r
    })

    let callCount = 0
    mocks.refresh.mockImplementation(async () => {
      callCount++
      await refreshBarrier // hold until we release
      return {
        type: 'oauth',
        access: 'new-access',
        refresh: 'new-refresh',
        expires: Date.now() + 3_600_000,
        accountId: 'acc-123',
      }
    })

    // Act: fire two concurrent ensureValidToken calls before the refresh resolves.
    const [p1, p2] = [
      manager.ensureValidToken(expiredAccount as never),
      manager.ensureValidToken(expiredAccount as never),
    ]

    // Release the refresh.
    resolveRefresh(undefined)

    const [t1, t2] = await Promise.all([p1, p2])

    // Assert: both callers get the new token.
    expect(t1).toBe('new-access')
    expect(t2).toBe('new-access')

    // Critical: the underlying refresh was called exactly ONCE, not twice.
    expect(callCount).toBe(1)
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    expect(mocks.refresh).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'oauth',
        refresh: 'the-refresh-token',
      }),
      expect.any(AbortSignal),
    )
  })

  it('does not refresh when token is still valid', async () => {
    const validAccount = {
      email: 'test@example.com',
      accessToken: 'valid-access',
      refreshToken: 'the-refresh-token',
      expiresAt: Date.now() + 3_600_000, // 1h from now
    }

    const token = await manager.ensureValidToken(validAccount as never)

    expect(token).toBe('valid-access')
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('allows independent refreshes for different accounts', async () => {
    const makeExpired = (email: string, refreshToken: string) => ({
      email,
      accessToken: 'old',
      refreshToken,
      expiresAt: Date.now() - 60_000,
    })

    mocks.refresh.mockImplementation(async (credential) => ({
      type: 'oauth',
      access: `new-${credential.refresh}`,
      refresh: `refreshed-${credential.refresh}`,
      expires: Date.now() + 3_600_000,
    }))

    const a = makeExpired('a@example.com', 'rt-a')
    const b = makeExpired('b@example.com', 'rt-b')

    const [ta, tb] = await Promise.all([
      manager.ensureValidToken(a as never),
      manager.ensureValidToken(b as never),
    ])

    expect(ta).toBe('new-rt-a')
    expect(tb).toBe('new-rt-b')
    // Two separate accounts → two separate refresh calls.
    expect(mocks.refresh).toHaveBeenCalledTimes(2)
  })
})
