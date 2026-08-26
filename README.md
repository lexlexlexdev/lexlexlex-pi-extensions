# lexlexlex-pi-extensions

Personal extensions for the [pi coding agent](https://github.com/earendil-works/pi-mono).

| Extension | What it does |
|---|---|
| `lexlexlex-permission-gates/` | Two-tier permission gates on bash commands & sensitive reads. Critical patterns (`rm -rf ~`, fork bombs, `dd`, `mkfs`) always blocked; risky patterns require user confirmation in safe mode, with per-session allowances and a `/gates` mode toggle. Matching is hardened against quote tricks and `sh -c` wrappers (see `SECURITY-REVIEW.md`). |
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
- An earlier experiment added an agent-supplied `explanation` parameter by
  overriding the `bash` tool. It was removed: tool-name registration is
  last-write-wins across extensions, and other installed packages that also
  override `bash` (e.g. preview/rendering tools) raced for ownership, making
  the field unreliable and occasionally deadlocking risky commands. The
  hardened command matching from that effort was kept.
