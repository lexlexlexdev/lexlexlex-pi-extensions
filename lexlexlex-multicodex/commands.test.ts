import { describe, expect, it, vi } from 'vitest'
import type { AccountManager } from './account-manager'
import { createOAuthInteraction, registerCommands } from './commands'
import type { createUsageStatusController } from './status'

function createStatusControllerMock() {
  return {
    refreshFor: vi.fn().mockResolvedValue(undefined),
    openPreferencesPanel: vi.fn().mockResolvedValue(undefined),
    loadPreferences: vi.fn().mockResolvedValue(undefined),
    getPreferences: vi.fn(() => ({
      usageMode: 'left',
      resetWindow: '7d',
      showAccount: true,
      showReset: true,
      order: 'account-first',
    })),
  } as unknown as ReturnType<typeof createUsageStatusController>
}

function createAccountManagerMock(emails: string[] = []) {
  return {
    getAccounts: () => emails.map((email) => ({ email })),
  } as unknown as AccountManager
}

describe('createOAuthInteraction', () => {
  it('maps provider prompts to the Pi UI and returns select ids', async () => {
    const input = vi.fn().mockResolvedValue('entered value')
    const select = vi.fn().mockResolvedValue('Browser')
    const notify = vi.fn()
    const signal = new AbortController().signal
    const interaction = createOAuthInteraction(
      { exec: vi.fn().mockResolvedValue(undefined) } as never,
      { signal, ui: { input, select, notify } } as never,
    )

    await expect(
      interaction.prompt({ type: 'text', message: 'Email' }),
    ).resolves.toBe('entered value')
    await expect(
      interaction.prompt({
        type: 'select',
        message: 'Login method',
        options: [
          { id: 'browser', label: 'Browser' },
          { id: 'device_code', label: 'Device code' },
        ],
      }),
    ).resolves.toBe('browser')

    expect(input).toHaveBeenCalledWith('Email', undefined, { signal })
    expect(select).toHaveBeenCalledWith(
      'Login method',
      ['Browser', 'Device code'],
      { signal },
    )
  })

  it('forwards current provider auth events to the UI', async () => {
    const exec = vi.fn().mockResolvedValue(undefined)
    const notify = vi.fn()
    const interaction = createOAuthInteraction(
      { exec } as never,
      {
        signal: new AbortController().signal,
        ui: { input: vi.fn(), select: vi.fn(), notify },
      } as never,
    )

    interaction.notify({
      type: 'auth_url',
      url: 'https://example.com/login',
      instructions: 'Continue in your browser.',
    })
    interaction.notify({
      type: 'device_code',
      userCode: 'ABC-123',
      verificationUri: 'https://example.com/device',
      expiresInSeconds: 60,
    })
    interaction.notify({ type: 'info', message: 'Signed in.' })
    interaction.notify({ type: 'progress', message: 'Waiting.' })
    await Promise.resolve()

    expect(exec).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenCalledWith(
      'Continue in your browser. URL: https://example.com/login',
      'info',
    )
    expect(notify).toHaveBeenCalledWith(
      'Open https://example.com/device and enter code ABC-123 (expires in 60s)',
      'info',
    )
    expect(notify).toHaveBeenCalledWith('Signed in.', 'info')
    expect(notify).toHaveBeenCalledWith('Waiting.', 'info')
  })
})

describe('registerCommands', () => {
  it('registers only the multicodex command', () => {
    const registerCommand = vi.fn()
    registerCommands(
      { registerCommand } as never,
      createAccountManagerMock(),
      createStatusControllerMock(),
    )

    expect(registerCommand).toHaveBeenCalledTimes(1)
    expect(registerCommand).toHaveBeenCalledWith(
      'multicodex',
      expect.objectContaining({
        description: expect.any(String),
        handler: expect.any(Function),
        getArgumentCompletions: expect.any(Function),
      }),
    )
  })

  it('returns dynamic autocomplete for subcommands and managed account identifiers', () => {
    const registerCommand = vi.fn()
    registerCommands(
      { registerCommand } as never,
      createAccountManagerMock(['alpha@example.com', 'beta@example.com']),
      createStatusControllerMock(),
    )

    const commandOptions = registerCommand.mock.calls[0]?.[1] as {
      getArgumentCompletions: (
        prefix: string,
      ) => Array<{ value: string; label: string }> | null
    }

    const subcommands = commandOptions.getArgumentCompletions('')
    expect(subcommands?.map((item) => item.value)).toContain('accounts')
    expect(subcommands?.map((item) => item.value)).toContain('show')
    expect(subcommands?.map((item) => item.value)).toContain('use')
    expect(subcommands?.map((item) => item.value)).toContain('alias')
    expect(subcommands?.map((item) => item.value)).toContain('refresh')
    expect(subcommands?.map((item) => item.value)).toContain('reauth')

    const useAccounts = commandOptions.getArgumentCompletions('use a')
    expect(useAccounts).toEqual([
      { value: 'use alpha@example.com', label: 'alpha@example.com' },
    ])

    const refreshAccounts = commandOptions.getArgumentCompletions('refresh a')
    expect(refreshAccounts).toContainEqual({
      value: 'refresh alpha@example.com',
      label: 'alpha@example.com',
    })

    const aliasAccounts = commandOptions.getArgumentCompletions('alias a')
    expect(aliasAccounts).toEqual([
      { value: 'alias alpha@example.com', label: 'alpha@example.com' },
    ])
  })

  it('sets an alias from the non-interactive alias command', async () => {
    const registerCommand = vi.fn()
    const setAccountAlias = vi.fn().mockReturnValue(true)
    const refreshFor = vi.fn().mockResolvedValue(undefined)
    registerCommands(
      { registerCommand } as never,
      {
        getAccounts: () => [],
        getAccount: () => ({
          email: 'alpha@example.com',
          accessToken: 'access',
          refreshToken: 'refresh',
          expiresAt: Date.now() + 3600_000,
        }),
        setAccountAlias,
      } as never,
      {
        ...createStatusControllerMock(),
        refreshFor,
      } as never,
    )

    const commandOptions = registerCommand.mock.calls[0]?.[1] as {
      handler: (args: string, ctx: unknown) => Promise<void>
    }
    const notify = vi.fn()
    await commandOptions.handler('alias alpha@example.com home', {
      hasUI: false,
      ui: { notify },
    })

    expect(setAccountAlias).toHaveBeenCalledWith('alpha@example.com', 'home')
    expect(notify).toHaveBeenCalledWith(
      'Alias for alpha@example.com is now home',
      'info',
    )
    expect(refreshFor).toHaveBeenCalledOnce()
  })

  it('returns to the main menu after a nested panel closes', async () => {
    const registerCommand = vi.fn()
    const select = vi
      .fn()
      .mockResolvedValueOnce('footer: footer settings panel')
      .mockResolvedValueOnce(undefined)
    const statusController = createStatusControllerMock()
    registerCommands(
      { registerCommand } as never,
      createAccountManagerMock(),
      statusController,
    )

    const commandOptions = registerCommand.mock.calls[0]?.[1] as {
      handler: (args: string, ctx: unknown) => Promise<void>
    }
    await commandOptions.handler('', {
      hasUI: true,
      ui: { select, notify: vi.fn() },
    })

    expect(select).toHaveBeenCalledTimes(2)
    expect(statusController.openPreferencesPanel).toHaveBeenCalledOnce()
  })

  it('shows a non-interactive warning when no subcommand is provided', async () => {
    const registerCommand = vi.fn()
    registerCommands(
      { registerCommand } as never,
      createAccountManagerMock(),
      createStatusControllerMock(),
    )

    const commandOptions = registerCommand.mock.calls[0]?.[1] as {
      handler: (args: string, ctx: unknown) => Promise<void>
    }
    const notify = vi.fn()
    await commandOptions.handler('', {
      hasUI: false,
      ui: { notify },
    })

    expect(notify).toHaveBeenCalledWith(
      '/multicodex requires a subcommand in non-interactive mode. Use /multicodex help.',
      'warning',
    )
  })
})
