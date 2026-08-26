# lexlexlex-pi-extensions

Personal extensions for the [pi coding agent](https://github.com/earendil-works/pi-mono).

| Extension | What it does |
|---|---|
| `lexlexlex-permission-gates/` | Two-tier permission gates on bash commands & sensitive reads. Critical patterns (`rm -rf ~`, fork bombs, `dd`, `mkfs`) always blocked; risky patterns require user confirmation in safe mode, with per-session allowances and a `/gates` mode toggle. Matching is hardened against quote tricks and `sh -c` wrappers (see `SECURITY-REVIEW.md`). Owns the overridden `bash` tool, which carries an optional agent-supplied `explanation` shown in gate prompts and tool cards (advisory only, never blocks). |
| `lexlexlex-tool-cards.ts` | Shared card renderers used by both tool-render and permission-gates (single source of truth for the UI). Library module — not an extension itself. |
| `lexlexlex-tool-render.ts` | Custom compact "card" rendering for built-in tools (read/grep/find/ls). Skips tools owned by other extensions to avoid registration clobbering. |
| `lexlexlex-gcm/` | Git commit message generation. |
| `lexlexlex-agents-setter/` | AGENTS.md helper. |
| `lexlexlex-sound-on-complete/` | Plays a sound when the agent finishes. |
| `pi-rtk-optimizer/` | Output rewrite/compaction tuning config. |

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

- `permission-gates` is a guardrail against accidents, not a sandbox.
- `permission-gates` overrides the built-in `bash` tool to carry a required
  agent-supplied `explanation` (shown in gate prompts and tool cards). Risky
  commands without it are rejected with a retry hint — but only while gates
  owns the bash schema; if another package stripped the field, commands pass
  unblocked (no deadlock). Gates re-asserts ownership on session start and
  before each turn.
