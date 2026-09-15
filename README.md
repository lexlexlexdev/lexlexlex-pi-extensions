# lexlexlex-pi-extensions

Personal extensions for the [pi coding agent](https://github.com/earendil-works/pi-mono).

| Extension | What it does |
|---|---|
| `lexlexlex-permission-gates/` | Two-tier permission gates on bash commands & sensitive reads. Critical patterns (`rm -rf ~`, fork bombs, `dd`, `mkfs`) always blocked; risky patterns require user confirmation in safe mode, with per-session allowances and a `/gates` mode toggle. Matching is hardened against quote tricks and `sh -c` wrappers (see `SECURITY-REVIEW.md`). Owns the overridden `bash` tool, which carries an optional agent-supplied `explanation` shown in gate prompts and tool cards (advisory only, never blocks). |
| `lexlexlex-tool-cards.ts` | Shared card renderers used by both tool-render and permission-gates (single source of truth for the UI). Library module — not an extension itself. |
| `lexlexlex-tool-render.ts` | Custom compact "card" rendering for built-in tools (read/grep/find/ls). Skips tools owned by other extensions to avoid registration clobbering. |
| `lexlexlex-tool-groups.ts` | Folds runs of consecutive tool calls into one collapsible block without owning any tool — it wraps the native `ToolExecutionComponent`s instead of re-registering the built-ins, so pi-code-previews, tool-render and permission-gates keep rendering their own cards. Mutations (`edit`/`write`, mutating shell commands) stay unfolded so their live previews keep painting. Config: `~/.pi/agent/tool-groups.json`. |
| `lexlexlex-thinking-anim.ts` | Keeps the collapsed thinking label alive: `● Thinking... · 1,240 chars · 7s` while the model reasons, then freezes to `Thought for 7s`. Wall-clock driven off Pi's own repaints, so it adds no timers or requestRender plumbing. Config: `~/.pi/agent/thinking-anim.json`. |
| `lexlexlex-gcm/` | Git commit message generation. |
| `lexlexlex-multicodex/` | Multiple ChatGPT Codex accounts with automatic quota rotation: imports the Codex auth pi already has, picks the best account per request, and switches + retries when one runs dry mid-session. `/multicodex` panel for accounts, usage and selection. Has its own README, schema and test suite. |
| `lexlexlex-sound-on-complete/` | Plays a sound when the agent finishes. |
| `pi-rtk-optimizer/` | Output rewrite/compaction tuning config. |
| `pi-footer.json` | Live config for the `npm:pi-footer` statusline (footer lines, separators, presets) — pi-footer reads this exact path, `~/.pi/agent/extensions/pi-footer.json`, so the versioned copy is the one in use. Override with `PI_FOOTER_CONFIG`. |

## Install

Clone and point your pi settings at the folders/files, e.g. in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "~/.pi/agent/extensions/lexlexlex-permission-gates",
    "~/.pi/agent/extensions/lexlexlex-tool-render.ts"
  ]
}
```

## Notes

- `thinking-anim` only touches the collapsed label (with thinking expanded there is no
  label to animate). Frames advance on Pi's existing ~80ms streaming repaints.
  Durations are deliberately not persisted, so a resumed session shows `Thought`;
  set `"finishedUnknownTemplate": ""` to keep Pi's own `Thinking...` there instead.
  Config keys: `frames`, `colors`, `intervalMs`, `showElapsed`, `showChars`, `separator`,
  `finishedTemplate` (`{duration}` → `7s` / `1m 30s`), `finishedUnknownTemplate`, `enabled`.
- `permission-gates` is a guardrail against accidents, not a sandbox.
- `permission-gates` overrides the built-in `bash` tool to carry a required
  agent-supplied `explanation` (shown in gate prompts and tool cards). Risky
  commands without it are rejected with a retry hint — but only while gates
  owns the bash schema; if another package stripped the field, commands pass
  unblocked (no deadlock). Gates re-asserts ownership on session start and
  before each turn.
