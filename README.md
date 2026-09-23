# lexlexlex-pi-extensions

Personal extensions for the [pi coding agent](https://github.com/earendil-works/pi-mono).

| Extension | What it does |
|---|---|
| `lexlexlex-permission-gates/` | Two-tier permission gates on bash commands & sensitive reads. Critical patterns (`rm -rf ~`, fork bombs, `dd`, `mkfs`) always blocked; risky patterns require user confirmation in safe mode, with per-session allowances and a `/gates` mode toggle. Matching is hardened against quote tricks and `sh -c` wrappers (see `SECURITY-REVIEW.md`). Owns the overridden `bash` tool, which carries an optional agent-supplied `explanation` shown in gate prompts and tool cards (advisory only, never blocks). |
| `lexlexlex-tool-cards.ts` | Shared card renderers used by both tool-render and permission-gates (single source of truth for the UI). Library module — not an extension itself. |
| `lexlexlex-tool-render.ts` | Custom compact "card" rendering for built-in tools (read/grep/find/ls). Skips tools owned by other extensions to avoid registration clobbering. |
| `lexlexlex-tool-groups.ts` | Folds runs of consecutive tool calls into one collapsible block without owning any tool — it wraps the native `ToolExecutionComponent`s instead of re-registering the built-ins, so pi-code-previews, tool-render and permission-gates keep rendering their own cards. Mutations (`edit`/`write`, mutating shell commands) stay unfolded so their live previews keep painting. Spacing is owned here: a folded block brings its own blank line above (folding the cards away removes the gap Pi's cards would have provided, skipped when the sibling above already ends blank), while inside it adds nothing — the call rows stack directly under the header, so the block is a tight N+1 lines and never looks glued to the entry before it. Cards that bring no leading blank of their own get the same air when they render outside a fold. Config: `~/.pi/agent/tool-groups.json`. |
| `lexlexlex-thinking-anim.ts` | Keeps the collapsed thinking label alive: `● Thinking... · 1,240 chars · 2 runs · 7s` while the model reasons, then freezes to `Thought for 12s · 3 runs`. One line per user exchange — the whole tool loop is rolled up and the line walks down to the newest message, so nothing stacks between tool cards. Wall-clock driven off Pi's own repaints, so it adds no timers or requestRender plumbing. Config: `~/.pi/agent/thinking-anim.json`. |
| `lexlexlex-gcm/` | Git commit message generation (`get_commit_message` tool, `/gcm` and `/gcm-model` commands). Models come from the session's scoped list, so the picker mirrors `/scoped-models` instead of a hardcoded menu; requests go through `ctx.modelRegistry.streamSimple`, so MultiCodex rotates accounts and refreshes OAuth for Codex targets. Fast tier (default, `{"gcm":{"serviceTier":"standard"}}` to disable) rides on `onPayload` and is only badged for models that actually take it. Live progress renders in a **widget above the editor** — a blinking `◆/◇ gcm · openai-codex/gpt-6-luna (fast, thinking high)` over `commit 2/3 · ~1.2k tok · 5s` — so `lexlexlex-tool-groups` folding the card away cannot hide it. The widget is cleared the moment the run finishes (success or failure) and the outcome lands in the transcript as a durable **GCM Report** entry: model, tier, thinking level, repo/branch, the commits it made, how long it took, and the error code when it failed. Blink frames and token counts come off the stream's own events, throttled, so there are no timers. Provider failures throw loudly, name what was already committed, and stop the turn instead of falling back. |
| `lexlexlex-multicodex/` | Multiple ChatGPT Codex accounts with automatic quota rotation: imports the Codex auth pi already has, picks the best account per request, and switches + retries when one runs dry mid-session. `/multicodex` panel for accounts, usage and selection. `/fast` adds the Codex Fast service tier for the models that support it, with corrected 2.5x/2x credit costs. Has its own README, schema and test suite. |
| `lexlexlex-compaction-fast/` | Local fork of [`pi-compaction-model`](https://github.com/JMHSV/pi-compaction-model) that runs Pi's native compaction on a dedicated model. Adds `compactionModel.serviceTier` (`priority`/`fast`/`flex`/`default`) so the summarizing request can ride OpenAI's Fast tier — through `onPayload`, since Pi's `buildBaseOptions` whitelist drops `serviceTier` from stream options. Requests stream via `ctx.modelRegistry`, so an `openai-codex/...` target rides MultiCodex account rotation (no OpenAI API key needed) while `openai/...` uses the platform API. Any failure falls back to the active model. |
| `lexlexlex-sound-on-complete/` | Plays a sound when the agent finishes. |
| `pi-rtk-optimizer/` | Output rewrite/compaction tuning config. |
| `pi-footer.json` | Live config for the `npm:pi-footer` statusline (footer lines, separators, presets) — pi-footer reads this exact path, `~/.pi/agent/extensions/pi-footer.json`, so the versioned copy is the one in use. Override with `PI_FOOTER_CONFIG`. |

## Config snapshots

The `configs/` folder versions the agent configuration these extensions run against: `settings.json`
(`packages`, `compactionModel`, defaults), `models.json` (custom providers and the GPT-6 model
definitions), `subagents.json` and `agents/*.md` for the subagent personas. They are copies, not
symlinks — restore them over `~/.pi/agent/` after a clone. Credentials stay out of the repo. See
[`configs/README.md`](./configs/README.md).

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
  `rollUpTurns` (default `true`) keeps one line per user exchange: every reasoning run
  of the exchange is counted into it, only the newest message carrying a label shows
  it, and the older messages render nothing at all — their line and the blank line Pi
  put around it go away, so a tool loop no longer stacks `Thought` lines. Set it to
  `false` for one line per run. `showRuns` + `runsMin` control the `· 2 runs` metric
  (default: shown from two runs on; `0` = always, `1` = also a single run).
  Config keys: `frames`, `colors`, `intervalMs`, `showElapsed`, `showChars`, `showRuns`,
  `runsMin`, `rollUpTurns`, `separator`, `finishedTemplate` (`{duration}` → `7s` /
  `1m 30s`), `finishedUnknownTemplate`, `enabled`.
- `permission-gates` is a guardrail against accidents, not a sandbox.
- `permission-gates` overrides the built-in `bash` tool to carry a required
  agent-supplied `explanation` (shown in gate prompts and tool cards). Risky
  commands without it are rejected with a retry hint — but only while gates
  owns the bash schema; if another package stripped the field, commands pass
  unblocked (no deadlock). Gates re-asserts ownership on session start and
  before each turn.
