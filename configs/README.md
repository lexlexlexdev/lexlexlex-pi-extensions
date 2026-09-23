# Config snapshots

Versioned copies of the live pi configuration these extensions are built against. They are
plain copies, not symlinks — after a clone, copy them back into `~/.pi/agent/`.

| File | Restore to | What it holds |
|---|---|---|
| `settings.json` | `~/.pi/agent/settings.json` | `packages` list (points at the extension folders/files in this repo), `compactionModel` (`model`, `thinkingLevel`, `serviceTier`), default model/provider/theme/thinking level, TUI options, `enabledModels`. |
| `models.json` | `~/.pi/agent/models.json` | Custom provider and model definitions, including the GPT-6 (`sol`, `luna`) entries with their thinking-level maps, cost tiers and 272000 context window. API keys are `${ENV_VAR}` references, never literals. |
| `subagents.json` | `~/.pi/agent/subagents.json` | Settings for `npm:@tintinweb/pi-subagents` (which supplies the `Agent` tool): model scoping, agent-file strictness, worktree isolation, depth limits. |
| `agents/*.md` | `~/.pi/agent/agents/` | Subagent personas (`consultant`, `reviewer`, `scout`, `worker`, `image-viewer`, `super-reviewer-consultant-ask-permission-before-call`). `model:` and `thinking:` frontmatter is authoritative for each persona. |

## Caveats

- Absolute paths (`/Users/aveaxii/...`) appear in `settings.json`; rewrite them on another machine.
- `subagents.json` is only meaningful alongside the `@tintinweb/pi-subagents` package, and
  `settings.json` lists it under `packages`. Removing that package reverts the `Agent` tool,
  `@mention` routing and the persona files to pi's defaults.
- Credentials do **not** live here. `~/.pi/agent/auth.json` (mode 0600) stays out of the repo,
  as does anything a provider injects at runtime.
