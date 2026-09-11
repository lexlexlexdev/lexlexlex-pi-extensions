import { describe, expect, it, vi } from 'vitest'
import {
  type Account,
  type AccountManager,
  buildMulticodexProviderConfig,
  createStreamWrapper,
  getNextResetAt,
  getOpenAICodexMirror,
  getOpenAICodexProvider,
  getWeeklyResetAt,
  isQuotaErrorMessage,
  isUsageUntouched,
  parseCodexUsageResponse,
  pickBestAccount,
} from './index'

describe('isQuotaErrorMessage', () => {
  it('matches 429', () => {
    expect(isQuotaErrorMessage('HTTP 429 Too Many Requests')).toBe(true)
  })

  it('matches common quota / usage limit messages', () => {
    expect(isQuotaErrorMessage('You have hit your ChatGPT usage limit.')).toBe(
      true,
    )
    expect(isQuotaErrorMessage('Quota exceeded')).toBe(true)
  })

  it('matches rate limit phrasing', () => {
    expect(isQuotaErrorMessage('rate limit exceeded')).toBe(true)
    expect(isQuotaErrorMessage('Rate-Limit: exceeded')).toBe(true)
  })

  it('does not match unrelated errors', () => {
    expect(isQuotaErrorMessage('network error')).toBe(false)
    expect(isQuotaErrorMessage('bad request')).toBe(false)
  })
})

describe('getOpenAICodexMirror', () => {
  it('mirrors the openai-codex provider models exactly (metadata)', () => {
    const sourceModels = getOpenAICodexProvider().getModels()
    const expected = {
      baseUrl: sourceModels[0]?.baseUrl || 'https://chatgpt.com/backend-api',
      models: sourceModels.map((m) => ({
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        input: m.input,
        cost: m.cost,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      })),
    }

    expect(getOpenAICodexMirror()).toEqual(expected)
  })
})

describe('buildMulticodexProviderConfig', () => {
  it('keeps the built-in provider id, models, OAuth, and stream methods', async () => {
    const sourceProvider = getOpenAICodexProvider()
    const fakeManager = {
      getActiveAccount: () => ({
        accessToken: 'test-jwt.eyJ0ZXN0IjoxfQ.sig',
        needsReauth: false,
      }),
      getAccounts: () => [],
    } as unknown as AccountManager
    const config = buildMulticodexProviderConfig(fakeManager, sourceProvider)

    expect(config.id).toBe('openai-codex')
    expect(config.getModels().map((model) => model.id)).toEqual(
      sourceProvider.getModels().map((model) => model.id),
    )
    expect(config.auth.oauth).toBe(sourceProvider.auth.oauth)
    expect(typeof config.stream).toBe('function')
    expect(typeof config.streamSimple).toBe('function')

    const resolved = await config.auth.apiKey?.resolve({
      ctx: {
        env: async () => undefined,
        fileExists: async () => false,
      },
      signal: new AbortController().signal,
    })
    expect(resolved?.auth.apiKey).toBe('test-jwt.eyJ0ZXN0IjoxfQ.sig')
  })
})

function makeAccount(email: string, overrides?: Partial<Account>): Account {
  return {
    email,
    accessToken: 'token',
    refreshToken: 'refresh',
    expiresAt: 0,
    ...overrides,
  }
}

type StreamWrapper = ReturnType<typeof createStreamWrapper>
type StreamModel = Parameters<StreamWrapper>[0]
type StreamContext = Parameters<StreamWrapper>[1]
type BaseProvider = Parameters<typeof createStreamWrapper>[1]

describe('usage helpers', () => {
  it('parses usage response windows', () => {
    const response = parseCodexUsageResponse({
      rate_limit: {
        primary_window: {
          reset_at: 1700000000,
          used_percent: 12.5,
        },
        secondary_window: {
          reset_at: 1700003600,
          used_percent: 0,
        },
      },
    })

    expect(response.primary?.usedPercent).toBe(12.5)
    expect(response.primary?.resetAt).toBe(1700000000 * 1000)
    expect(response.secondary?.usedPercent).toBe(0)
    expect(response.secondary?.resetAt).toBe(1700003600 * 1000)
  })

  it('detects untouched usage', () => {
    expect(
      isUsageUntouched({
        primary: { usedPercent: 0, resetAt: 1 },
        secondary: { usedPercent: 0, resetAt: 2 },
        fetchedAt: 0,
      }),
    ).toBe(true)
    expect(
      isUsageUntouched({
        primary: { usedPercent: 0, resetAt: 1 },
        secondary: { usedPercent: 5, resetAt: 2 },
        fetchedAt: 0,
      }),
    ).toBe(false)
  })

  it('picks earliest reset from usage', () => {
    expect(
      getNextResetAt({
        primary: { resetAt: 2000 },
        secondary: { resetAt: 1000 },
        fetchedAt: 0,
      }),
    ).toBe(1000)
  })

  it('picks weekly reset from usage', () => {
    expect(
      getWeeklyResetAt({
        primary: { resetAt: 2000 },
        secondary: { resetAt: 1000 },
        fetchedAt: 0,
      }),
    ).toBe(1000)
  })
})

describe('pickBestAccount', () => {
  it('prefers untouched accounts when available', () => {
    const accounts = [makeAccount('a'), makeAccount('b')]
    const usage = new Map([
      [
        'a',
        {
          primary: { usedPercent: 10, resetAt: 5000 },
          secondary: { usedPercent: 10, resetAt: 6000 },
          fetchedAt: 0,
        },
      ],
      [
        'b',
        {
          primary: { usedPercent: 0, resetAt: 4000 },
          secondary: { usedPercent: 0, resetAt: 7000 },
          fetchedAt: 0,
        },
      ],
    ])

    const selected = pickBestAccount(accounts, usage, { now: 0 })
    expect(selected?.email).toBe('b')
  })

  it('prefers earliest weekly reset when all accounts touched', () => {
    const accounts = [makeAccount('a'), makeAccount('b')]
    const usage = new Map([
      [
        'a',
        {
          primary: { usedPercent: 10, resetAt: 5000 },
          secondary: { usedPercent: 10, resetAt: 8000 },
          fetchedAt: 0,
        },
      ],
      [
        'b',
        {
          primary: { usedPercent: 20, resetAt: 3000 },
          secondary: { usedPercent: 20, resetAt: 9000 },
          fetchedAt: 0,
        },
      ],
    ])

    const selected = pickBestAccount(accounts, usage, { now: 0 })
    expect(selected?.email).toBe('a')
  })

  it('ignores 5h reset and prefers earliest weekly reset', () => {
    const accounts = [makeAccount('sh01'), makeAccount('hind')]
    const usage = new Map([
      [
        'sh01',
        {
          primary: { usedPercent: 0, resetAt: 60 * 60 * 1000 },
          secondary: { usedPercent: 9, resetAt: 5 * 24 * 60 * 60 * 1000 },
          fetchedAt: 0,
        },
      ],
      [
        'hind',
        {
          primary: { usedPercent: 24, resetAt: 55 * 60 * 1000 },
          secondary: { usedPercent: 13, resetAt: 6 * 24 * 60 * 60 * 1000 },
          fetchedAt: 0,
        },
      ],
    ])

    const selected = pickBestAccount(accounts, usage, { now: 0 })
    expect(selected?.email).toBe('sh01')
  })

  it('falls back to available account when usage is unknown', () => {
    const accounts = [makeAccount('a'), makeAccount('b')]
    const selected = pickBestAccount(accounts, new Map(), { now: 0 })
    expect(['a', 'b']).toContain(selected?.email)
  })

  it('skips accounts the API reports as out of capacity', () => {
    const accounts = [makeAccount('a'), makeAccount('b')]
    const usage = new Map([
      [
        'a',
        {
          primary: { usedPercent: 0, resetAt: 1000 },
          secondary: { usedPercent: 0, resetAt: 2000 },
          allowed: false,
          limitReached: true,
          fetchedAt: 0,
        },
      ],
      [
        'b',
        {
          primary: { usedPercent: 30, resetAt: 3000 },
          secondary: { usedPercent: 30, resetAt: 4000 },
          allowed: true,
          limitReached: false,
          fetchedAt: 0,
        },
      ],
    ])

    expect(pickBestAccount(accounts, usage, { now: 0 })?.email).toBe('b')
  })

  it('still returns a limited account when every account is limited', () => {
    const accounts = [makeAccount('a'), makeAccount('b')]
    const blocked = {
      primary: { usedPercent: 100, resetAt: 1000 },
      secondary: { usedPercent: 100, resetAt: 2000 },
      allowed: false,
      limitReached: true,
      fetchedAt: 0,
    }
    const usage = new Map([
      ['a', blocked],
      ['b', blocked],
    ])

    expect(['a', 'b']).toContain(
      pickBestAccount(accounts, usage, { now: 0 })?.email,
    )
  })

  it('ignores exhausted accounts', () => {
    const accounts = [
      makeAccount('a', { quotaExhaustedUntil: 2000 }),
      makeAccount('b'),
    ]
    const usage = new Map([
      [
        'a',
        {
          primary: { usedPercent: 0, resetAt: 1000 },
          secondary: { usedPercent: 0, resetAt: 1000 },
          fetchedAt: 0,
        },
      ],
    ])

    const selected = pickBestAccount(accounts, usage, { now: 1000 })
    expect(selected?.email).toBe('b')
  })

  it('prefers lower usage over earlier weekly reset', () => {
    const accounts = [makeAccount('a'), makeAccount('b')]
    const usage = new Map([
      [
        'a',
        {
          primary: { usedPercent: 90, resetAt: 5000 },
          secondary: { usedPercent: 80, resetAt: 6000 },
          fetchedAt: 0,
        },
      ],
      [
        'b',
        {
          primary: { usedPercent: 5, resetAt: 5000 },
          secondary: { usedPercent: 10, resetAt: 9000 },
          fetchedAt: 0,
        },
      ],
    ])

    // Account b has much lower usage (10%) even though its weekly
    // reset is later (9000 vs 6000). Should pick b.
    const selected = pickBestAccount(accounts, usage, { now: 0 })
    expect(selected?.email).toBe('b')
  })

  it('uses weekly reset as tiebreaker when usage is equal', () => {
    const accounts = [makeAccount('a'), makeAccount('b')]
    const usage = new Map([
      [
        'a',
        {
          primary: { usedPercent: 30, resetAt: 5000 },
          secondary: { usedPercent: 30, resetAt: 8000 },
          fetchedAt: 0,
        },
      ],
      [
        'b',
        {
          primary: { usedPercent: 30, resetAt: 5000 },
          secondary: { usedPercent: 30, resetAt: 7000 },
          fetchedAt: 0,
        },
      ],
    ])

    // Same max usage (30%), so tiebreak on weekly reset.
    // b resets at 7000 < a at 8000, so pick b.
    const selected = pickBestAccount(accounts, usage, { now: 0 })
    expect(selected?.email).toBe('b')
  })
})

describe('manual account selection', () => {
  it('prefers the manual account in stream wrapper', async () => {
    const manual = makeAccount('manual@example.com')
    let activateCalled = false
    let headerEmail: string | undefined

    const accountManager = {
      waitUntilReady: async () => {},
      syncImportedOpenAICodexAuth: async () => false,
      getAvailableManualAccount: () => manual,
      hasManualAccount: () => true,
      clearManualAccount: () => {},
      activateBestAccount: async () => {
        activateCalled = true
        return undefined
      },
      ensureValidToken: async () => 'manual-token',
      handleQuotaExceeded: async () => {},
    } as unknown as AccountManager

    const baseProvider = {
      streamSimple: (
        model: { headers?: Record<string, string> },
        _context: unknown,
        _options?: unknown,
      ) => {
        headerEmail = model.headers?.['X-Multicodex-Account']
        async function* inner() {
          yield { type: 'done' }
        }
        return inner() as unknown as AsyncIterable<unknown>
      },
    }

    const stream = createStreamWrapper(
      accountManager,
      baseProvider as unknown as BaseProvider,
    )(
      {
        id: 'test',
        provider: 'openai-codex',
        api: 'openai-codex-responses',
      } as StreamModel,
      {} as StreamContext,
    )

    for await (const _event of stream) {
      // drain
    }

    expect(activateCalled).toBe(false)
    expect(headerEmail).toBe('manual@example.com')
  })

  it('falls back to auto selection when manual is unavailable', async () => {
    const auto = makeAccount('auto@example.com')
    let cleared = false
    let headerEmail: string | undefined

    const accountManager = {
      waitUntilReady: async () => {},
      syncImportedOpenAICodexAuth: async () => false,
      getAvailableManualAccount: () => undefined,
      hasManualAccount: () => true,
      clearManualAccount: () => {
        cleared = true
      },
      activateBestAccount: async () => auto,
      ensureValidToken: async () => 'auto-token',
      handleQuotaExceeded: async () => {},
    } as unknown as AccountManager

    const baseProvider = {
      streamSimple: (
        model: { headers?: Record<string, string> },
        _context: unknown,
        _options?: unknown,
      ) => {
        headerEmail = model.headers?.['X-Multicodex-Account']
        async function* inner() {
          yield { type: 'done' }
        }
        return inner() as unknown as AsyncIterable<unknown>
      },
    }

    const stream = createStreamWrapper(
      accountManager,
      baseProvider as unknown as BaseProvider,
    )(
      {
        id: 'test',
        provider: 'openai-codex',
        api: 'openai-codex-responses',
      } as StreamModel,
      {} as StreamContext,
    )

    for await (const _event of stream) {
      // drain
    }

    expect(cleared).toBe(true)
    expect(headerEmail).toBe('auto@example.com')
  })

  it('clears manual on quota and retries with auto account', async () => {
    const manual = makeAccount('manual@example.com')
    const auto = makeAccount('auto@example.com')
    let cleared = false
    let activateCount = 0
    const headers: string[] = []
    let streamCalls = 0

    const accountManager = {
      waitUntilReady: async () => {},
      syncImportedOpenAICodexAuth: async () => false,
      getAvailableManualAccount: () => (cleared ? undefined : manual),
      hasManualAccount: () => !cleared,
      clearManualAccount: () => {
        cleared = true
      },
      activateBestAccount: async () => {
        activateCount += 1
        return auto
      },
      ensureValidToken: async (account: Account) => `${account.email}-token`,
      handleQuotaExceeded: async () => {},
    } as unknown as AccountManager

    const baseProvider = {
      streamSimple: (
        model: { headers?: Record<string, string> },
        _context: unknown,
        _options?: unknown,
      ) => {
        headers.push(model.headers?.['X-Multicodex-Account'] || '')
        streamCalls += 1
        async function* inner() {
          if (streamCalls === 1) {
            yield { type: 'error', error: { errorMessage: 'quota exceeded' } }
            return
          }
          yield { type: 'done' }
        }
        return inner() as unknown as AsyncIterable<unknown>
      },
    }

    const stream = createStreamWrapper(
      accountManager,
      baseProvider as unknown as BaseProvider,
    )(
      {
        id: 'test',
        provider: 'openai-codex',
        api: 'openai-codex-responses',
      } as StreamModel,
      {} as StreamContext,
    )

    for await (const _event of stream) {
      // drain
    }

    expect(cleared).toBe(true)
    expect(headers[0]).toBe('manual@example.com')
    expect(headers[1]).toBe('auto@example.com')
    expect(activateCount).toBe(1)
  })

  it('marks the final quota account before surfacing the error', async () => {
    const accounts = Array.from({ length: 6 }, (_, index) =>
      makeAccount(`account-${index}@example.com`),
    )
    const headers: string[] = []
    const quotaAccounts: Account[] = []
    const events: Array<{ type?: string }> = []

    const accountManager = {
      waitUntilReady: async () => {},
      getAvailableManualAccount: () => undefined,
      hasManualAccount: () => false,
      clearManualAccount: vi.fn(),
      activateBestAccount: async (options?: {
        excludeEmails?: Set<string>
      }) => accounts.find((account) => !options?.excludeEmails?.has(account.email)),
      ensureValidToken: async (account: Account) => `${account.email}-token`,
      handleQuotaExceeded: vi.fn(async (account: Account) => {
        quotaAccounts.push(account)
      }),
    } as unknown as AccountManager

    const baseProvider = {
      streamSimple: (
        model: { headers?: Record<string, string> },
        _context: unknown,
        _options?: unknown,
      ) => {
        headers.push(model.headers?.['X-Multicodex-Account'] || '')
        async function* inner() {
          yield { type: 'error', error: { errorMessage: 'quota exceeded' } }
        }
        return inner() as unknown as AsyncIterable<unknown>
      },
    }

    const stream = createStreamWrapper(
      accountManager,
      baseProvider as unknown as BaseProvider,
    )(
      {
        id: 'test',
        provider: 'openai-codex',
        api: 'openai-codex-responses',
      } as StreamModel,
      {} as StreamContext,
    )

    for await (const event of stream) {
      events.push(event as { type?: string })
    }

    expect(headers).toHaveLength(6)
    expect(quotaAccounts.map((account) => account.email)).toEqual(
      accounts.map((account) => account.email),
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('error')
  })

  it('retries a quota error that follows only the provider start marker', async () => {
    const accounts = [makeAccount('first@example.com'), makeAccount('second@example.com')]
    const headers: string[] = []
    let streamCalls = 0
    const quotaAccounts: Account[] = []

    const accountManager = {
      waitUntilReady: async () => {},
      getAvailableManualAccount: () => undefined,
      hasManualAccount: () => false,
      clearManualAccount: vi.fn(),
      activateBestAccount: async (options?: {
        excludeEmails?: Set<string>
      }) => accounts.find((account) => !options?.excludeEmails?.has(account.email)),
      ensureValidToken: async (account: Account) => `${account.email}-token`,
      handleQuotaExceeded: vi.fn(async (account: Account) => {
        quotaAccounts.push(account)
      }),
    } as unknown as AccountManager

    const baseProvider = {
      streamSimple: (
        model: { headers?: Record<string, string> },
        _context: unknown,
        _options?: unknown,
      ) => {
        headers.push(model.headers?.['X-Multicodex-Account'] || '')
        streamCalls += 1
        async function* inner() {
          yield { type: 'start' }
          if (streamCalls === 1) {
            yield { type: 'error', error: { errorMessage: '429 quota exceeded' } }
            return
          }
          yield { type: 'done' }
        }
        return inner() as unknown as AsyncIterable<unknown>
      },
    }

    const stream = createStreamWrapper(
      accountManager,
      baseProvider as unknown as BaseProvider,
    )(
      {
        id: 'test',
        provider: 'openai-codex',
        api: 'openai-codex-responses',
      } as StreamModel,
      {} as StreamContext,
    )

    const events: Array<{ type?: string }> = []
    for await (const event of stream) {
      events.push(event as { type?: string })
    }

    expect(headers).toEqual(['first@example.com', 'second@example.com'])
    expect(quotaAccounts.map((account) => account.email)).toEqual([
      'first@example.com',
    ])
    expect(events.map((event) => event.type)).toEqual(['start', 'done'])
  })

  it('does not rotate or warn when token validation is aborted', async () => {
    const manual = makeAccount('manual@example.com')
    const controller = new AbortController()
    const clearManualAccount = vi.fn()
    const notifyRotationSkipForAuthFailure = vi.fn()
    const activateBestAccount = vi.fn()
    const streamProvider = vi.fn()
    const abortError = new Error('This operation was aborted')
    abortError.name = 'AbortError'

    const accountManager = {
      waitUntilReady: async () => {},
      getAvailableManualAccount: () => manual,
      hasManualAccount: () => true,
      clearManualAccount,
      activateBestAccount,
      ensureValidToken: async () => {
        controller.abort()
        throw abortError
      },
      notifyRotationSkipForAuthFailure,
      handleQuotaExceeded: vi.fn(),
    } as unknown as AccountManager

    const stream = createStreamWrapper(
      accountManager,
      { streamSimple: streamProvider } as unknown as BaseProvider,
    )(
      {
        id: 'test',
        provider: 'openai-codex',
        api: 'openai-codex-responses',
      } as StreamModel,
      {} as StreamContext,
      { signal: controller.signal } as never,
    )

    const events: Array<{ type?: string }> = []
    for await (const event of stream) {
      events.push(event as { type?: string })
    }

    expect(activateBestAccount).not.toHaveBeenCalled()
    expect(clearManualAccount).not.toHaveBeenCalled()
    expect(notifyRotationSkipForAuthFailure).not.toHaveBeenCalled()
    expect(streamProvider).not.toHaveBeenCalled()
    expect(events[0]?.type).toBe('error')
  })

  it('skips auth-broken accounts before streaming and retries a healthy one', async () => {
    const broken = makeAccount('broken@example.com')
    const healthy = makeAccount('healthy@example.com')
    let activateCount = 0
    const headers: string[] = []
    const events: Array<{ type?: string }> = []

    const notifyRotationSkipForAuthFailure = vi.fn()
    const accountManager = {
      waitUntilReady: async () => {},
      syncImportedOpenAICodexAuth: async () => false,
      getAvailableManualAccount: () => undefined,
      hasManualAccount: () => false,
      clearManualAccount: () => {},
      activateBestAccount: async (options?: {
        excludeEmails?: Set<string>
      }) => {
        activateCount += 1
        return options?.excludeEmails?.has(broken.email) ? healthy : broken
      },
      ensureValidToken: async (account: Account) => {
        if (account.email === broken.email) {
          throw new Error('refresh failed')
        }
        return 'healthy-token'
      },
      notifyRotationSkipForAuthFailure,
      handleQuotaExceeded: async () => {},
    } as unknown as AccountManager

    const baseProvider = {
      streamSimple: (
        model: { headers?: Record<string, string> },
        _context: unknown,
        _options?: unknown,
      ) => {
        headers.push(model.headers?.['X-Multicodex-Account'] || '')
        async function* inner() {
          yield { type: 'done' }
        }
        return inner() as unknown as AsyncIterable<{ type: string }>
      },
    }

    const stream = createStreamWrapper(
      accountManager,
      baseProvider as unknown as BaseProvider,
    )(
      {
        id: 'test',
        provider: 'openai-codex',
        api: 'openai-codex-responses',
      } as StreamModel,
      {} as StreamContext,
    )

    for await (const event of stream) {
      events.push(event as { type?: string })
    }

    expect(activateCount).toBe(2)
    expect(headers).toEqual(['healthy@example.com'])
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(notifyRotationSkipForAuthFailure).toHaveBeenCalledWith(
      broken,
      expect.any(Error),
    )
  })
})
