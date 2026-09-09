import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_FAST_MODEL_IDS,
  codexFastAvailability,
  codexFastRequestTier,
  correctCodexFastMessageCost,
  createFastModeState,
  registerCodexFastMode,
  rewriteCodexFastPayload,
} from './fast'

function createModel(
  id = 'gpt-5.4',
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    name: id,
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: 'https://chatgpt.com/backend-api',
    reasoning: true,
    input: ['text'],
    cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    ...overrides,
  }
}

const usage = {
  input: 100,
  output: 20,
  cacheRead: 10,
  cacheWrite: 0,
  totalTokens: 130,
  cost: {
    input: 0.00025,
    output: 0.0003,
    cacheRead: 0.0000025,
    cacheWrite: 0,
    total: 0.0005525,
  },
}

describe('Codex Fast eligibility and payloads', () => {
  it('matches the supported official Codex model set', () => {
    expect([...CODEX_FAST_MODEL_IDS].sort()).toEqual([
      'gpt-5.4',
      'gpt-5.5',
      'gpt-5.6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
    ])
    for (const id of CODEX_FAST_MODEL_IDS) {
      expect(codexFastAvailability(createModel(id) as never, true)).toEqual({
        kind: 'available',
        enabled: true,
      })
    }
    for (const id of ['gpt-5.4-mini', 'gpt-5.3-codex-spark']) {
      expect(codexFastAvailability(createModel(id) as never, true)).toMatchObject(
        { kind: 'unavailable' },
      )
    }
  })

  it('requires the official provider, API, and origin', () => {
    expect(codexFastAvailability(createModel() as never, false)).toEqual({
      kind: 'available',
      enabled: false,
    })
    expect(
      codexFastAvailability(
        createModel('gpt-5.4', { provider: 'openai' }) as never,
        true,
      ),
    ).toEqual({ kind: 'not-codex' })
    expect(
      codexFastAvailability(
        createModel('gpt-5.4', { api: 'openai-responses' }) as never,
        true,
      ),
    ).toMatchObject({ kind: 'unavailable' })
    expect(
      codexFastAvailability(
        createModel('gpt-5.4', { baseUrl: 'https://proxy.example.test' }) as never,
        true,
      ),
    ).toMatchObject({ kind: 'unavailable' })
  })

  it('uses priority only for enabled supported models', () => {
    expect(codexFastRequestTier(createModel() as never, true)).toBe('priority')
    expect(codexFastRequestTier(createModel() as never, false)).toBe('default')
    expect(codexFastRequestTier(createModel('gpt-5.4-mini') as never, true)).toBe(
      'default',
    )
    expect(
      codexFastRequestTier(
        createModel('gpt-5.4', { provider: 'openai' }) as never,
        true,
      ),
    ).toBeUndefined()
  })

  it('rewrites payloads immutably and preserves all other fields', () => {
    const payload = {
      model: 'gpt-5.4',
      input: [{ type: 'message' }],
      service_tier: 'flex',
    }

    expect(rewriteCodexFastPayload(payload, createModel() as never, true)).toEqual(
      { ...payload, service_tier: 'priority' },
    )
    expect(payload.service_tier).toBe('flex')
    expect(rewriteCodexFastPayload(payload, createModel() as never, false)).toEqual(
      { ...payload, service_tier: 'default' },
    )
    expect(rewriteCodexFastPayload([], createModel() as never, true)).toBeUndefined()
  })
})

describe('Codex Fast runtime', () => {
  it('keeps state in memory and clears it when the session resets', async () => {
    const registerCommand = vi.fn()
    const handlers = new Map<string, (event: never, ctx: never) => unknown>()
    const pi = {
      registerCommand,
      on: vi.fn((event: string, handler: (event: never, ctx: never) => unknown) => {
        handlers.set(event, handler)
      }),
    }
    const state = createFastModeState()
    const refreshStatus = vi.fn()
    const runtime = registerCodexFastMode(
      pi as never,
      state,
      refreshStatus,
    )
    const notify = vi.fn()
    const ctx = {
      hasUI: true,
      model: createModel(),
      sessionManager: { getSessionId: () => 'session-1' },
      ui: { notify },
    }
    const command = registerCommand.mock.calls[0]?.[1] as {
      handler: (args: string, context: never) => Promise<void>
    }

    await command.handler('', ctx as never)
    expect(state.isEnabled()).toBe(true)
    expect(refreshStatus).toHaveBeenCalledWith(ctx)
    expect(notify).toHaveBeenCalledWith(
      'Codex Fast mode enabled for this session.',
      'info',
    )

    const beforeProviderRequest = handlers.get('before_provider_request')
    expect(
      beforeProviderRequest?.(
        { payload: { model: 'gpt-5.4' } } as never,
        ctx as never,
      ),
    ).toMatchObject({ service_tier: 'priority' })

    runtime.resetSession()
    expect(state.isEnabled()).toBe(false)
    expect(
      beforeProviderRequest?.(
        { payload: { model: 'gpt-5.4' } } as never,
        ctx as never,
      ),
    ).toMatchObject({ service_tier: 'default' })
  })

  it('tracks native child priority without rewriting the request', () => {
    const registerCommand = vi.fn()
    const handlers = new Map<string, (event: never, ctx: never) => unknown>()
    const pi = {
      registerCommand,
      on: vi.fn((event: string, handler: (event: never, ctx: never) => unknown) => {
        handlers.set(event, handler)
      }),
    }
    const ctx = {
      model: createModel(),
      sessionManager: { getSessionId: () => 'session-1' },
    }

    registerCodexFastMode(
      pi as never,
      createFastModeState(),
      vi.fn(),
      { rewriteRequests: false, registerCommand: false },
    )

    expect(registerCommand).not.toHaveBeenCalled()
    const beforeProviderRequest = handlers.get('before_provider_request')
    expect(
      beforeProviderRequest?.(
        {
          payload: {
            model: 'gpt-5.4',
            service_tier: 'priority',
          },
        } as never,
        ctx as never,
      ),
    ).toBeUndefined()

    const message = {
      role: 'assistant',
      provider: 'openai-codex',
      model: 'gpt-5.4',
      usage,
    }
    const messageEnd = handlers.get('message_end')
    const corrected = messageEnd?.(
      { message } as never,
      ctx as never,
    ) as { message: { usage: typeof usage } } | undefined
    expect(corrected?.message.usage.cost.total).toBe(usage.cost.total * 2)
  })

  it('corrects priority usage cost without mutating the original message', () => {
    const message = {
      role: 'assistant',
      provider: 'openai-codex',
      model: 'gpt-5.4',
      usage,
    }
    const corrected = correctCodexFastMessageCost(
      message,
      createModel() as never,
      true,
    ) as { usage: typeof usage }

    expect(corrected.usage.cost.total).toBe(usage.cost.total * 2)
    expect(message.usage.cost.total).toBe(usage.cost.total)
    expect(
      correctCodexFastMessageCost(corrected, createModel() as never, true),
    ).toBeUndefined()

    const gpt55Usage = {
      ...usage,
      cost: {
        ...usage.cost,
        total: 0.001105,
      },
    }
    const corrected55 = correctCodexFastMessageCost(
      {
        ...message,
        model: 'gpt-5.5',
        usage: gpt55Usage,
      },
      createModel('gpt-5.5', {
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
      }) as never,
      true,
    ) as { usage: typeof gpt55Usage }
    expect(corrected55.usage.cost.total).toBe(gpt55Usage.cost.total * 2.5)
  })
})
