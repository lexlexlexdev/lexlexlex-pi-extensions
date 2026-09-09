import {
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type StreamOptions,
} from '@earendil-works/pi-ai'
import {
  createErrorAssistantMessage,
  createLinkedAbortController,
  normalizeUnknownError,
  rewriteProviderOnEvent,
} from 'pi-provider-utils/streams'
import type { AccountManager } from './account-manager'
import { isQuotaErrorMessage } from './quota'

const MAX_ROTATION_RETRIES = 5

type ApiProviderRef<TOptions extends StreamOptions> = {
  streamSimple: (
    model: Model<'openai-codex-responses'>,
    context: Context,
    options?: TOptions,
  ) => AssistantMessageEventStream
}

function isAbortLikeError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (error instanceof Error && error.name === 'AbortError') return true
  return normalizeUnknownError(error).toLowerCase().includes('abort')
}

export function createStreamWrapper<
  TOptions extends StreamOptions = SimpleStreamOptions,
>(
  accountManager: AccountManager,
  baseProvider: ApiProviderRef<TOptions>,
): ApiProviderRef<TOptions>['streamSimple'] {
  return (
    model: Model<'openai-codex-responses'>,
    context: Context,
    options?: TOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream()

    ;(async () => {
      try {
        await accountManager.waitUntilReady()
        options?.signal?.throwIfAborted()
        const excludedEmails = new Set<string>()
        for (let attempt = 0; attempt <= MAX_ROTATION_RETRIES; attempt++) {
          options?.signal?.throwIfAborted()
          const now = Date.now()
          const manual = accountManager.getAvailableManualAccount({
            excludeEmails: excludedEmails,
            now,
          })
          const usingManual = Boolean(manual)
          let account = manual
          if (!account) {
            if (accountManager.hasManualAccount()) {
              accountManager.clearManualAccount()
            }
            account = await accountManager.activateBestAccount({
              excludeEmails: excludedEmails,
              signal: options?.signal,
            })
          }
          if (!account) {
            throw new Error(
              'No available Multicodex accounts. Please use /multicodex use <identifier>.',
            )
          }

          let token: string
          try {
            token = await accountManager.ensureValidToken(
              account,
              options?.signal,
            )
          } catch (error) {
            if (isAbortLikeError(error, options?.signal)) {
              throw error
            }
            accountManager.notifyRotationSkipForAuthFailure(account, error)
            if (usingManual) {
              accountManager.clearManualAccount()
            }
            excludedEmails.add(account.email)
            if (attempt < MAX_ROTATION_RETRIES) {
              continue
            }
            throw error
          }
          const abortController = createLinkedAbortController(options?.signal)

          const internalModel: Model<'openai-codex-responses'> = {
            ...(model as Model<'openai-codex-responses'>),
            provider: 'openai-codex',
            api: 'openai-codex-responses',
          }

          const inner = baseProvider.streamSimple(
            {
              ...internalModel,
              headers: {
                ...(internalModel.headers || {}),
                'X-Multicodex-Account': account.email,
              },
            },
            context,
            {
              ...options,
              apiKey: token,
              signal: abortController.signal,
            } as TOptions,
          )

          let forwardedAny = false
          let retry = false
          // The native WebSocket transport emits `start` before it knows
          // whether the response is a quota error. Hold that marker until a
          // later event proves that the attempt produced usable output.
          const pendingEvents: AssistantMessageEvent[] = []
          const forward = (event: AssistantMessageEvent): void => {
            stream.push(rewriteProviderOnEvent(event, model.provider))
            forwardedAny = true
          }
          const flushPending = (): void => {
            for (const event of pendingEvents) forward(event)
            pendingEvents.length = 0
          }

          for await (const event of inner) {
            if (event.type === 'error') {
              const msg = event.error.errorMessage || ''
              const isQuota = isQuotaErrorMessage(msg)

              if (isQuota && !forwardedAny) {
                await accountManager.handleQuotaExceeded(account, {
                  signal: options?.signal,
                })
                if (usingManual) {
                  accountManager.clearManualAccount()
                }
                excludedEmails.add(account.email)
                if (attempt < MAX_ROTATION_RETRIES) {
                  options?.signal?.throwIfAborted()
                  abortController.abort()
                  retry = true
                  break
                }
              }

              flushPending()
              forward(event)
              stream.end()
              return
            }

            if (event.type === 'start' && !forwardedAny) {
              pendingEvents.push(event)
              continue
            }

            flushPending()
            forward(event)

            if (event.type === 'done') {
              stream.end()
              return
            }
          }

          if (retry) {
            continue
          }

          flushPending()
          stream.end()
          return
        }
      } catch (error) {
        const message = normalizeUnknownError(error)
        const errorEvent: AssistantMessageEvent = {
          type: 'error',
          reason: 'error',
          error: createErrorAssistantMessage(
            model,
            `Multicodex failed: ${message}`,
          ),
        }
        stream.push(rewriteProviderOnEvent(errorEvent, model.provider))
        stream.end()
      }
    })()

    return stream
  }
}
