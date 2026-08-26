import type { ExtensionAPI, ExtensionContext, SessionEntry, ToolCallEventResult, UserBashEventResult } from '@earendil-works/pi-coding-agent';
import { createBashTool, getSettingsListTheme, isToolCallEventType } from '@earendil-works/pi-coding-agent';
import { Container, type SettingItem, SettingsList, Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { cardRenderCall, cardRenderResult } from '../lexlexlex-tool-cards.ts';

const MAC_SOUND_FILE = '/Users/aveaxii/.pi/agent/sounds/ping-sound.mp3';
const ENTRY_TYPE = 'permission-gates';

const SESSION_ALLOW_LABEL = 'Allow by default for this session';
const ALLOW_ONCE_LABEL = 'Allow once';
const BLOCK_LABEL = 'Block';

const EXPLANATION_FALLBACK = '(no explanation provided)';
const EXPLANATION_REQUIRED_REASON = 'Explanation required: retry this exact command with an `explanation` field — one or two short sentences on what it does and why it is needed.';

const BASH_SCHEMA = Type.Object({
  command: Type.String({ description: 'The bash command to execute' }),
  timeout: Type.Optional(Type.Number({ description: 'Optional timeout in milliseconds' })),
  // Mandatory for the model (risky commands without it are rejected while we
  // own this schema), advisory for the gate: if another extension owns the
  // schema and strips this field, commands are allowed through unblocked.
  explanation: Type.Optional(Type.String({
    description: 'REQUIRED: one or two short sentences describing what this command does and why it is needed. Shown to the user before any risky command runs.',
  })),
});

type GateMode = 'safe' | 'full';
type SessionAllowance = 'sensitive-read' | 'dangerous-delete' | 'git-mutation';
type RiskLevel = 'high' | 'medium';

interface RiskPattern {
  label: string;
  regex: RegExp;
  level: RiskLevel;
  sessionAllowance?: SessionAllowance;
}

interface CriticalPattern {
  label: string;
  regex: RegExp;
}

type PermissionGateEntry =
  | { kind: 'allow-session'; category: SessionAllowance }
  | { kind: 'mode'; mode: GateMode };

type PermissionGateMessage = {
  kind: 'mode-change';
  mode: GateMode;
};

const CRITICAL_PATTERNS: CriticalPattern[] = [
  { label: 'Refusing recursive forced delete of root', regex: /(?:^|[;&|\s])(?:sudo\s+)?rm\s+(?=[^;&|]*-[^;&|\s]*r)(?=[^;&|]*-[^;&|\s]*f)[^;&|]*(?:\s|=)(?:--\s*)?(?:\/|\/\*)(?:$|[\s;&|])/i },
  { label: 'Refusing recursive forced delete of home', regex: /(?:^|[;&|\s])(?:sudo\s+)?rm\s+(?=[^;&|]*-[^;&|\s]*r)(?=[^;&|]*-[^;&|\s]*f)[^;&|]*(?:\s|=)(?:--\s*)?(?:~\/?|~\/\*|\$HOME\/?|\$HOME\/\*|\$\{HOME\}\/?|\$\{HOME\}\/\*|(?:\/home|\/Users)\/[^\s;&|]+\/?)(?:$|[\s;&|])/i },
  { label: 'Refusing recursive forced delete of current directory', regex: /(?:^|[;&|\s])(?:sudo\s+)?rm\s+(?=[^;&|]*-[^;&|\s]*r)(?=[^;&|]*-[^;&|\s]*f)[^;&|]*(?:\s|=)(?:\.|\.\/|\*|\.\*)(?:$|[\s;&|])/i },
  { label: 'Refusing fork bomb', regex: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*}\s*;?\s*:/ },
  { label: 'Refusing disk overwrite', regex: /\bdd\b[^;&|]*(?:of=\/dev\/(?:disk|rdisk|sd|hd|nvme)|if=\/dev\/(?:zero|random|urandom)[^;&|]*of=\/dev\/)/i },
  { label: 'Refusing filesystem format', regex: /\bmkfs(?:\.\w+)?\b[^;&|]*\/dev\//i },
  { label: 'Refusing recursive permission change on root/home', regex: /\b(?:chmod|chown|chgrp)\b[^;&|]*\s-R\s+[^;&|]*(?:\s|=)(?:\/|~|~\/|\$HOME|\$\{HOME\})(?:$|[\s;&|])/i },
];

const RISK_PATTERNS: RiskPattern[] = [
  { label: 'Privilege escalation', regex: /\b(sudo|su|doas)\b/i, level: 'high' },
  { label: 'Dangerous delete', regex: /\brm\s+[^;&|]*-(?:[^;&|]*r|[^;&|]*f)[^;&|]*/i, level: 'high', sessionAllowance: 'dangerous-delete' },
  { label: 'find delete', regex: /\bfind\b[^;&|]*\b-delete\b/i, level: 'high', sessionAllowance: 'dangerous-delete' },
  { label: 'Disk overwrite / format', regex: /\b(dd|mkfs(?:\.\w+)?)\b/i, level: 'high' },
  { label: 'Execute remote script', regex: /\b(curl|wget)\b[^\n\r|]*\|\s*(sh|bash|zsh)\b/i, level: 'high' },
  { label: 'Bash process substitution remote exec', regex: /\bbash\s*<\(\s*(curl|wget)\b/i, level: 'high' },
  { label: 'DB destructive operation', regex: /\b(drop\s+table|drop\s+database|truncate\s+table)\b/i, level: 'high' },
  { label: 'Sensitive path access', regex: sensitivePathRegex(), level: 'high', sessionAllowance: 'sensitive-read' },
  { label: 'Environment read', regex: /(?:^|[;&|\s])(?:printenv|env)(?:$|[\s;&|])/i, level: 'medium', sessionAllowance: 'sensitive-read' },

  { label: 'System package changes', regex: /\b(apt|apt-get|yum|dnf|brew)\s+(install|remove|upgrade|uninstall)\b/i, level: 'medium' },
  { label: 'Global package install', regex: /\b(npm|pnpm|yarn)\s+.*\s-g\b/i, level: 'medium' },
  { label: 'Force kill process', regex: /\b(kill\s+-9|pkill|killall)\b/i, level: 'medium' },
  { label: 'Bulk in-place edit', regex: /\bsed\s+-i\b/i, level: 'medium' },
  { label: 'Git commit', regex: /\bgit\s+commit\b/i, level: 'medium', sessionAllowance: 'git-mutation' },
  { label: 'Git push', regex: /\bgit\s+push\b/i, level: 'medium', sessionAllowance: 'git-mutation' },
  { label: 'Git destructive operation', regex: /\bgit\s+(?:reset\s+--hard|clean\s+-[df]|checkout\s+--|restore\s+.*(?:--staged\s+)?\.)\b/i, level: 'high', sessionAllowance: 'git-mutation' },
];

function sensitivePathRegex(): RegExp {
  // Matched against raw commands AND read-like tool inputs; bash commands are
  // additionally tested quote-stripped/wrapper-unwrapped (see gateSubjects),
  // so quoted forms like "~/.ssh" are covered even though this literal has
  // no quote handling itself.
  return /(?:^|[\s'"=:.\/])(?:\.env(?:[.\s'"\/]|$)|[^\s'";&|]*\.pem\b|(?:id_rsa|id_ed25519|authorized_keys|known_hosts)\b|\.ssh(?:\/|$)|\.aws(?:\/|$)|(?:~|\$\{?HOME\}?|\/root|(?:\/home|\/Users)\/[^\s'";&|]+)\/(?:\.ssh|\.aws|\.gnupg|\.config\/gh)(?:\/|$)|\/etc\/|\/usr\/local\/etc\/)/i;
}

function normalize(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}

function modeLabel(mode: GateMode): string {
  return mode === 'safe' ? 'Safe mode' : 'Full approval';
}

function playPermissionGateSound(pi: ExtensionAPI): void {
  void pi.exec('afplay', [MAC_SOUND_FILE]).catch(() => {
    process.stdout.write('\x07');
  });
}

function restoreState(entries: SessionEntry[]): { mode: GateMode; allowances: Set<SessionAllowance> } {
  let mode: GateMode = 'safe';
  const allowances = new Set<SessionAllowance>();

  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== ENTRY_TYPE) continue;
    const data = entry.data as PermissionGateEntry | undefined;
    if (data?.kind === 'allow-session') allowances.add(data.category);
    if (data?.kind === 'mode') mode = data.mode;
  }

  return { mode, allowances };
}

/**
 * Matching subjects for a command line. Gate regexes run against every
 * subject so shell-quote tricks and `sh -c` wrappers cannot hide payloads:
 *   rm -rf "$HOME"     -> quote-stripped -> rm -rf $HOME
 *   sudo bash -lc 'rm -rf ~' -> unwrapped -> rm -rf ~
 */
function gateSubjects(command: string): string[] {
  const stripped = command.replace(/["'`]/g, "");
  const subjects = [command, stripped];
  const WRAPPER = /\b(?:sudo\s+)?(?:bash|z?sh|ksh|dash)\s+(?:-\w+\s+)*-c\s+/i;
  let cur = stripped;
  for (let i = 0; i < 3 && WRAPPER.test(cur); i++) {
    cur = cur.replace(WRAPPER, "").trim();
    subjects.push(cur);
  }
  return [...new Set(subjects)];
}

function findCriticalRiskAny(subjects: string[]): CriticalPattern | undefined {
  return CRITICAL_PATTERNS.find((pattern) => subjects.some((subject) => pattern.regex.test(subject)));
}

/**
 * All distinct risk patterns hit across subjects, merged into one:
 * labels joined, level escalated to worst, first session allowance kept so
 * e.g. `sudo git push` offers git-mutation instead of being masked by sudo.
 */
function collectRisks(subjects: string[]): RiskPattern | undefined {
  const seen = new Set<string>();
  const matched: RiskPattern[] = [];
  for (const pattern of RISK_PATTERNS) {
    if (subjects.some((subject) => pattern.regex.test(subject)) && !seen.has(pattern.label)) {
      seen.add(pattern.label);
      matched.push(pattern);
    }
  }
  if (matched.length === 0) return undefined;
  return {
    ...matched[0],
    label: matched.map((risk) => risk.label).join(", "),
    level: matched.some((risk) => risk.level === "high") ? "high" : "medium",
    sessionAllowance: matched.find((risk) => risk.sessionAllowance)?.sessionAllowance,
  };
}

function inputTextForReadLikeTool(toolName: string, input: Record<string, unknown>): string {
  const parts = [toolName];
  for (const key of ['path', 'pattern', 'glob', 'command']) {
    const value = input[key];
    if (typeof value === 'string') parts.push(value);
  }
  return normalize(parts.join(' '));
}

function findReadRisk(toolName: string, input: Record<string, unknown>): RiskPattern | undefined {
  if (!['read', 'grep', 'find', 'ls'].includes(toolName)) return;
  const text = inputTextForReadLikeTool(toolName, input);
  if (!sensitivePathRegex().test(text)) return;
  return {
    label: 'Sensitive read',
    regex: sensitivePathRegex(),
    level: 'high',
    sessionAllowance: 'sensitive-read',
  };
}

function updateStatus(ctx: ExtensionContext, mode: GateMode): void {
  const marker = mode === 'safe'
    ? ctx.ui.theme.fg('success', 'S')
    : ctx.ui.theme.fg('warning', 'F');
  ctx.ui.setStatus('permission-gates', marker);
}

async function confirmRisk(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  risk: RiskPattern,
  subject: string,
  explanation?: string,
): Promise<{ block: true; reason: string } | { rememberSession: true } | undefined> {
  if (!ctx.hasUI) return { block: true, reason: `Blocked: ${risk.label} (no UI confirmation available)` };

  playPermissionGateSound(pi);
  const why = `Why: ${explanation?.trim() || EXPLANATION_FALLBACK}\n\n`;

  if (risk.sessionAllowance) {
    const choice = await ctx.ui.select(
      `${risk.level === 'high' ? 'High-risk action' : 'Confirm action'}\n\nReason: ${risk.label}\n\n${why}Target:\n${subject}\n\nChoose how to proceed.`,
      [ALLOW_ONCE_LABEL, BLOCK_LABEL, SESSION_ALLOW_LABEL],
    );

    if (choice === SESSION_ALLOW_LABEL) {
      pi.appendEntry<PermissionGateEntry>(ENTRY_TYPE, { kind: 'allow-session', category: risk.sessionAllowance });
      return { rememberSession: true };
    }

    if (choice !== ALLOW_ONCE_LABEL) return { block: true, reason: `Blocked: ${risk.label}` };
    return;
  }

  const ok = await ctx.ui.confirm(
    risk.level === 'high' ? 'High-risk action' : 'Confirm action',
    `Reason: ${risk.label}\n\n${why}Target:\n${subject}\n\nProceed?`,
  );
  if (!ok) return { block: true, reason: `Blocked: ${risk.label}` };
  return;
}

function blockedUserBashResult(reason: string): UserBashEventResult {
  return {
    result: {
      output: reason,
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  };
}

// Named exports exist so the matching pipeline can be unit-tested in isolation.
export { gateSubjects, findCriticalRiskAny, collectRisks, sensitivePathRegex };

export default function permissionGates(pi: ExtensionAPI) {
  let loadedSessionId: string | undefined;
  let mode: GateMode = 'safe';
  let sessionAllowances = new Set<SessionAllowance>();

  function ensureSession(ctx: ExtensionContext): void {
    const sessionId = ctx.sessionManager.getSessionId();
    if (sessionId === loadedSessionId) return;
    loadedSessionId = sessionId;
    const restored = restoreState(ctx.sessionManager.getEntries());
    mode = restored.mode;
    sessionAllowances = restored.allowances;
    updateStatus(ctx, mode);
  }

  function hasExplanation(input: Record<string, unknown>): boolean {
    return typeof input.explanation === 'string' && input.explanation.trim().length > 0;
  }

  /** True when OUR enhanced bash is the currently registered definition. */
  function bashIsOurs(): boolean {
    const bash = pi.getAllTools().find((tool) => tool.name === 'bash');
    return Boolean(bash && (bash.sourceInfo?.source ?? '').includes('permission-gates'));
  }

  /**
   * Self-healing ownership: other extensions that also override bash may load
   * after us and re-register it with the plain builtin schema, wiping the
   * explanation parameter. Re-assert whenever bash isn't ours. Registration
   * order between extensions is racy, so we hook both session_start (early)
   * and before_agent_start (fires after every extension has loaded). The
   * explanation field is advisory — losing it never blocks commands.
   */
  function ensureEnhancedBash(ctx: ExtensionContext): void {
    if (bashIsOurs()) return;
    registerEnhancedBash(ctx);
  }

  function registerEnhancedBash(ctx: ExtensionContext): void {
    const base = createBashTool(ctx.cwd);
    pi.registerTool({
      ...base,
      name: 'bash',
      parameters: BASH_SCHEMA,
      promptGuidelines: [
        ...((base as { promptGuidelines?: readonly string[] }).promptGuidelines ?? []),
        'ALWAYS include the `explanation` parameter on every call: one or two short sentences describing what the command does and why it is needed. Risky commands without it are rejected.',
      ],
      async execute(toolCallId: string, params: { command: string; timeout?: number; explanation?: string }, signal?: AbortSignal, onUpdate?: never) {
        const { explanation: _explanation, ...input } = params;
        return base.execute(toolCallId, input, signal, onUpdate);
      },
      renderCall: (args: unknown, theme: unknown, context: unknown) => cardRenderCall('bash', args, theme, context),
      renderResult: (result: unknown, options: unknown, theme: unknown, context: unknown) => cardRenderResult('bash', result, options, theme, context),
    });
  }

  function setMode(ctx: ExtensionContext, nextMode: GateMode): void {
    mode = nextMode;
    updateStatus(ctx, mode);
    pi.appendEntry<PermissionGateEntry>(ENTRY_TYPE, { kind: 'mode', mode });
    pi.sendMessage<PermissionGateMessage>({
      customType: ENTRY_TYPE,
      content: `Permission mode: ${modeLabel(mode)}`,
      display: true,
      details: { kind: 'mode-change', mode },
    });
  }

  pi.registerMessageRenderer<PermissionGateMessage>(ENTRY_TYPE, (message, _options, theme) => {
    if (message.details?.kind !== 'mode-change') return;
    const color = message.details.mode === 'safe' ? 'success' : 'warning';
    return new Text(theme.fg(color, String(message.content)), 0, 0);
  });

  pi.registerCommand('gates', {
    description: 'Configure permission gates',
    handler: async (args, ctx) => {
      ensureSession(ctx);

      const requested = args.trim().toLowerCase();
      if (requested === 'safe' || requested === 'full') {
        setMode(ctx, requested as GateMode);
        return;
      }
      if (requested) {
        ctx.ui.notify('Usage: /gates [safe|full]', 'error');
        return;
      }

      if (ctx.mode === 'tui') {
        const modeValues = ['Safe mode', 'Full approval'];
        const items: SettingItem[] = [
          {
            id: 'mode',
            label: 'Permission mode',
            currentValue: modeLabel(mode),
            values: modeValues,
          },
        ];

        await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
          const container = new Container();
          container.addChild(new Text(theme.fg('accent', theme.bold('Permission Gates')), 1, 1));

          const settings = new SettingsList(
            items,
            4,
            getSettingsListTheme(),
            (_id, newValue) => {
              setMode(ctx, newValue === 'Full approval' ? 'full' : 'safe');
            },
            () => done(),
            { enableSearch: false },
          );
          container.addChild(settings);
          container.addChild(new Text(theme.fg('dim', 'enter/space change • esc close'), 1, 0));

          return {
            render: (width: number) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => settings.handleInput?.(data),
          };
        });
        return;
      }

      if (ctx.hasUI) {
        const choice = await ctx.ui.select('Permission Gates', ['Safe mode', 'Full approval']);
        if (choice) setMode(ctx, choice === 'Full approval' ? 'full' : 'safe');
        return;
      }

      ctx.ui.notify(`Permission mode: ${modeLabel(mode)}`, 'info');
    },
  });

  pi.on('session_start', (_event, ctx) => {
    loadedSessionId = undefined;
    ensureSession(ctx);
    ensureEnhancedBash(ctx);
  });

  pi.on('before_agent_start', (_event, ctx) => {
    ensureEnhancedBash(ctx);
  });

  pi.on('tool_call', async (event, ctx): Promise<ToolCallEventResult | void> => {
    ensureSession(ctx);

    if (isToolCallEventType('bash', event)) {
      const cmd = normalize(event.input.command);
      const subjects = gateSubjects(cmd);
      const critical = findCriticalRiskAny(subjects);
      if (critical) return { block: true, reason: critical.label };

      const risk = collectRisks(subjects);
      if (!risk) return;
      // Demand an explanation only while WE own the schema (i.e. the model
      // can actually provide it). If another extension stripped the field,
      // demanding it would deadlock every risky command.
      if (!hasExplanation(event.input as Record<string, unknown>) && bashIsOurs()) {
        return { block: true, reason: EXPLANATION_REQUIRED_REASON };
      }
      if (mode === 'full') return;
      if (risk.sessionAllowance && sessionAllowances.has(risk.sessionAllowance)) return;

      const result = await confirmRisk(pi, ctx, risk, cmd, event.input.explanation as string | undefined);
      if (result && 'block' in result) return result;
      if (result && 'rememberSession' in result && risk.sessionAllowance) {
        sessionAllowances.add(risk.sessionAllowance);
      }
      return;
    }

    const readRisk = findReadRisk(event.toolName, event.input as Record<string, unknown>);
    if (!readRisk) return;
    if (mode === 'full') return;
    if (readRisk.sessionAllowance && sessionAllowances.has(readRisk.sessionAllowance)) return;

    const subject = inputTextForReadLikeTool(event.toolName, event.input as Record<string, unknown>);
    const result = await confirmRisk(pi, ctx, readRisk, subject);
    if (result && 'block' in result) return result;
    if (result && 'rememberSession' in result && readRisk.sessionAllowance) {
      sessionAllowances.add(readRisk.sessionAllowance);
    }
  });

  pi.on('user_bash', async (event, ctx): Promise<UserBashEventResult | void> => {
    ensureSession(ctx);

    const cmd = normalize(event.command);
    const subjects = gateSubjects(cmd);
    const critical = findCriticalRiskAny(subjects);
    if (critical) return blockedUserBashResult(critical.label);

    const risk = collectRisks(subjects);
    if (!risk || mode === 'full') return;
    if (risk.sessionAllowance && sessionAllowances.has(risk.sessionAllowance)) return;

    const result = await confirmRisk(pi, ctx, risk, cmd);
    if (result && 'block' in result) return blockedUserBashResult(result.reason);
    if (result && 'rememberSession' in result && risk.sessionAllowance) {
      sessionAllowances.add(risk.sessionAllowance);
    }
  });
}
