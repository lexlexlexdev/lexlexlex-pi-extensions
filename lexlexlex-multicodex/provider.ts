import type {
  ApiKeyAuth,
  OAuthAuth,
  OpenAICodexResponsesOptions,
  Provider,
} from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { AccountManager } from './account-manager'
import { createStreamWrapper } from './stream-wrapper'

export const PROVIDER_ID = 'openai-codex'
export type OpenAICodexProvider = Provider<'openai-codex-responses'>

/**
 * Return the built-in Codex provider from pi's public provider registry.
 *
 * The provider owns the OAuth implementation and the Codex API stream. Keep
 * both on the same provider instance so MultiCodex never copies auth logic.
 */
export function getOpenAICodexProvider(): OpenAICodexProvider {
  const provider = builtinProviders().find((entry) => entry.id === PROVIDER_ID)
  if (!provider) {
    throw new Error('openai-codex provider is unavailable')
  }
  return provider as OpenAICodexProvider
}

export function getOpenAICodexOAuth(
  provider: Provider = getOpenAICodexProvider(),
): OAuthAuth {
  const oauth = provider.auth?.oauth
  if (!oauth) {
    throw new Error('openai-codex OAuth provider is unavailable')
  }
  return oauth
}

export interface ProviderModelDef {
  id: string
  name: string
  reasoning: boolean
  input: ('text' | 'image')[]
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  contextWindow: number
  maxTokens: number
}

export function getOpenAICodexMirror(
  provider: OpenAICodexProvider = getOpenAICodexProvider(),
): {
  baseUrl: string
  models: ProviderModelDef[]
} {
  const sourceModels = provider.getModels()
  if (sourceModels.length === 0) {
    return {
      baseUrl: provider.baseUrl ?? 'https://chatgpt.com/backend-api',
      models: [],
    }
  }
  const baseUrl =
    sourceModels[0]?.baseUrl ?? provider.baseUrl ?? 'https://chatgpt.com/backend-api'
  return {
    baseUrl,
    models: sourceModels.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: [...m.input],
      cost: { ...m.cost },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    })),
  }
}

function getActiveApiKey(accountManager: AccountManager): string {
  const active = accountManager.getActiveAccount()
  if (active && !active.needsReauth) {
    return active.accessToken
  }
  // Fallback: first available account with a valid token.
  for (const account of accountManager.getAccounts()) {
    if (!account.needsReauth && account.accessToken) {
      return account.accessToken
    }
  }
  // Fallback placeholder until MultiCodex resolves a usable managed account.
  return 'pending-login'
}

function createMulticodexApiKeyAuth(
  accountManager: AccountManager,
): ApiKeyAuth {
  return {
    name: 'MultiCodex',
    check: async ({ signal }) => {
      signal.throwIfAborted()
      return { type: 'api_key', source: 'MultiCodex' }
    },
    resolve: async ({ signal }) => {
      signal.throwIfAborted()
      return {
        auth: { apiKey: getActiveApiKey(accountManager) },
        source: 'MultiCodex',
      }
    },
  }
}

/**
 * Build a native provider replacement with the same id and model catalog as
 * the built-in provider. Only request authentication and streaming are
 * wrapped; the built-in OAuth and Codex API implementations remain intact.
 */
export function buildMulticodexProviderConfig(
  accountManager: AccountManager,
  baseProvider: OpenAICodexProvider = getOpenAICodexProvider(),
): OpenAICodexProvider {
  const oauth = getOpenAICodexOAuth(baseProvider)
  const streamSimple = createStreamWrapper(accountManager, baseProvider)
  const stream = createStreamWrapper<OpenAICodexResponsesOptions>(
    accountManager,
    {
      streamSimple: (model, context, options) =>
        baseProvider.stream(model, context, options),
    },
  )

  return {
    ...baseProvider,
    auth: {
      ...baseProvider.auth,
      apiKey: createMulticodexApiKeyAuth(accountManager),
      oauth,
    },
    stream,
    streamSimple,
  }
}
