# lexlexlex-pi-extensions

Personal extensions for the [pi coding agent](https://github.com/earendil-works/pi-mono).

| Extension | What it does |
|---|---|
| `lexlexlex-permission-gates/` | Two-tier permission gates on bash commands & sensitive reads. Critical patterns (`rm -rf ~`, fork bombs, `dd`, `mkfs`) always blocked; risky patterns require confirmation with an agent-supplied `explanation`. Modes: safe / full approval, per-session allowances, `/gates` command. Owns the overridden `bash` tool. |
| `lexlexlex-tool-cards.ts` | Shared card renderers used by both tool-render and permission-gates (single source of truth for the UI). |
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

- `permission-gates` overrides the built-in `bash` tool (extended schema with an
  `explanation` parameter). Only one extension may own a tool name — see
  `SECURITY-REVIEW.md` for the design and threat model.
- This is a guardrail against accidents, not a sandbox.
