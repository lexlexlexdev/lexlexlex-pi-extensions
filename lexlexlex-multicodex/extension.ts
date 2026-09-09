import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { AccountManager } from './account-manager'
import { registerCommands } from './commands'
import {
  createFastModeState,
  registerCodexFastMode,
} from './fast'
import { handleNewSessionSwitch, handleSessionStart } from './hooks'
import {
  buildMulticodexProviderConfig,
  getOpenAICodexOAuth,
  getOpenAICodexProvider,
} from './provider'
import { createUsageStatusController } from './status'

function contextHasUI(ctx: ExtensionContext): boolean {
  try {
    return ctx.hasUI
  } catch {
    return false
  }
}

function notifyWarning(ctx: ExtensionContext, message: string): void {
  if (!contextHasUI(ctx)) return
  try {
    ctx.ui.notify(message, 'warning')
  } catch {
    // The session may have ended before the background account task.
  }
}

export default function multicodexExtension(pi: ExtensionAPI) {
  const baseProvider = getOpenAICodexProvider()
  const accountManager = new AccountManager(getOpenAICodexOAuth(baseProvider))
  const fastMode = createFastModeState()
  const statusController = createUsageStatusController(accountManager, fastMode)
  let lastContext: ExtensionContext | undefined

  accountManager.setWarningHandler((message) => {
    if (lastContext) notifyWarning(lastContext, message)
  })

  const refreshStatus = (ctx: ExtensionContext): void => {
    if (!contextHasUI(ctx)) return
    void Promise.resolve(statusController.refreshFor(ctx)).catch(() => {})
  }

  // pi-subagents adds its own priority-tier hook for child launches with
  // `fast: true`. Do not register our session toggle in those children: the
  // standard hook would otherwise run after it and overwrite `priority` with
  // `default`, disabling the role-level fast setting.
  const fastRuntime = registerCodexFastMode(
    pi,
    fastMode,
    refreshStatus,
    process.env.PI_SUBAGENT_CHILD === '1'
      ? { rewriteRequests: false, registerCommand: false }
      : undefined,
  )

  pi.registerProvider(
    buildMulticodexProviderConfig(accountManager, baseProvider),
  )

  registerCommands(pi, accountManager, statusController)

  pi.on('session_start', (_event: unknown, ctx: ExtensionContext) => {
    fastRuntime.resetSession()
    lastContext = ctx
    accountManager.resetSessionWarnings()
    handleSessionStart(accountManager, (msg) => notifyWarning(ctx, msg))
    if (!contextHasUI(ctx)) return
    statusController.startAutoRefresh()
    void (async () => {
      try {
        await statusController.loadPreferences(ctx)
        await statusController.refreshFor(ctx)
      } catch {
        // Status is best effort and must not outlive its session context.
      }
    })()
  })

  ;(pi.on as (...args: unknown[]) => void)(
    'session_switch',
    (event: { reason?: string }, ctx: ExtensionContext) => {
      fastRuntime.resetSession()
      lastContext = ctx
      if (event.reason === 'new') {
        accountManager.resetSessionWarnings()
        handleNewSessionSwitch(accountManager, (msg) =>
          notifyWarning(ctx, msg),
        )
      }
      refreshStatus(ctx)
    },
  )

  pi.on('turn_end', (_event: unknown, ctx: ExtensionContext) => {
    lastContext = ctx
    refreshStatus(ctx)
  })

  pi.on('model_select', (_event: unknown, ctx: ExtensionContext) => {
    lastContext = ctx
    if (contextHasUI(ctx)) {
      try {
        statusController.scheduleModelSelectRefresh(ctx)
      } catch {
        // The session may have been replaced before the debounce started.
      }
    }
  })

  pi.on('session_shutdown', (_event: unknown, ctx: ExtensionContext) => {
    fastRuntime.resetSession()
    try {
      statusController.stopAutoRefresh(
        contextHasUI(ctx) ? ctx : undefined,
      )
    } catch {
      // Cleanup must not fail when Pi has already replaced the context.
    }
  })
}
