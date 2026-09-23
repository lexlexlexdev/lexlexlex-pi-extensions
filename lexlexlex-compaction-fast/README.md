# lexlexlex-compaction-fast

Local fork of [`pi-compaction-model`](https://github.com/JMHSV/pi-compaction-model) (JMHSV, MIT, v0.1.0)
that adds **Fast mode** support to Pi's native compaction.

Everything upstream does is unchanged: a dedicated model handles compaction through
Pi's own `compact()` (same prompts, same algorithm, same fallbacks), and any failure
falls back to Pi's active model.

**Routing:** the summarization request goes through `ctx.modelRegistry.streamSimple()`,
not pi-ai directly, so auth and transport stay with the registered provider. Point
`compactionModel.model` at `openai-codex/gpt-6-luna` and
[`lexlexlex-multicodex`](../lexlexlex-multicodex) rotates its ChatGPT Codex accounts and
refreshes OAuth tokens for compaction the same way it does for session requests — no
OpenAI API key needed. An `openai/...` target still uses the OpenAI platform API and
needs its own credential (`/login openai` or `OPENAI_API_KEY`).

Fallback needs a usable active model: Pi resolves the active model's credentials
*before* the compaction hook runs, so when that credential is missing the failure comes
from Pi itself and this extension can only surface it (see Failure visibility).

## What it adds

`compactionModel.serviceTier` — injects OpenAI's `service_tier` into the compaction
request only. Fast mode (renamed from Priority processing on 2026-07-30) is billed at
2x standard rates on the platform API; on the Codex backend the credit multipliers are
2.5x for the GPT-6, GPT-5.6, and GPT-5.5 families and 2x for GPT-5.4, which this
extension reapplies to the summary's usage so the reported cost matches MultiCodex's
table.

```json
{
  "compactionModel": {
    "model": "openai/gpt-6-luna",
    "thinkingLevel": "high",
    "serviceTier": "priority"
  }
}
```

| Value | Effect |
|---|---|
| omitted | Standard tier, identical to upstream |
| `"priority"` or `"fast"` | Fast mode. OpenAI accepts both names; for a Codex target `fast` is normalized to `priority` on the wire so Pi's own accounting and this extension's credit table both apply |
| `"flex"` | 50% batch-style tier |
| `"default"` | Explicitly standard |

Also honored: `false` as the whole section value disables the extension, `enabled: false`
disables it too, `reasons` limits which compaction reasons (`manual`, `threshold`,
`overflow`) use the dedicated model.

## Why `onPayload` and not `options.serviceTier`

The provider's `streamSimple` rebuilds its option bag through `buildBaseOptions`
(`@earendil-works/pi-ai/dist/api/simple-options.js`), which whitelists fields and drops
anything unrecognized — so `options.serviceTier` never reaches the request body. The
`onPayload` hook is on that whitelist and runs immediately before the body is sent, so
the tier is merged there instead. A caller-supplied `onPayload` is chained, not
replaced.

Tier injection is skipped for model APIs that do not carry `service_tier`.
`openai-codex-responses` does, which is what MultiCodex sends for `/fast` — but only
for the official `chatgpt.com` endpoint and an advertised model id, the same guard
MultiCodex applies.

## Indicator

While a compaction of this extension runs, the spinner line names the model, the tier, the
output budget for the pass in flight, the tokens produced so far, and the elapsed time:

```
⣷ Compacting with openai-codex/gpt-6-luna (fast)  [█░░░░░░░░░░░] ~1,000/8,192 tok · 18s
```

- The bar's ceiling is the budget for the pass in flight, taken from `options.maxTokens` on
  the stream call: Pi uses `min(0.8 * reserveTokens, model.maxTokens)` for a history
  summary and `0.5 * reserveTokens` for a turn-prefix summary. Note that the Codex
  responses adapter never sends an output cap, so on `openai-codex/*` this is Pi's budget
  target rather than a hard limit — the bar is a progress scale, not a truncation alarm.
- Output tokens are **estimated** from delta length (4 characters per token) and marked
  with `~`. As soon as the provider reports usage — mid-stream `partial.usage` or the
  final message — that number wins outright, even when it is smaller than the estimate.
- Retries follow `settings.retry` the way Pi's own compaction does: the policy from the
  settings manager is handed to `compact()`, and the countdown between attempts appears on
  the same line (`· retry 1/3 in 2s`). Without that, a transient drop would silently fall
  back to the active model instead of retrying the configured one.
- Elapsed time comes free: the label is rebuilt on every spinner repaint, so the
  extension starts no timer of its own.
- A second pass (a turn split or a retry) restarts the counters and appends `· pass 2`,
  so a bar that jumps back to zero is explained rather than mysterious.
- A supported fast tier shows `(fast)`, `default` shows `(standard)`, and anything else
  shows its own name. `fast` is translated to `priority` for the Codex and OpenAI
  Responses APIs, where `fast` is not a wire value.

Pi builds that line — and its overflow/auto wording — inside its own indicator, which is
not reachable from the extension UI context, so the extension wraps
`Loader.updateDisplay()` from `@earendil-works/pi-tui`: that method reads `this.message`
on every paint and the spinner repaints on its own interval. The wrapper only touches
labels that start with `Compacting context`, `Auto-compacting`, or
`Context overflow detected`, and only while a compaction of ours is in flight; everything
else renders as Pi wrote it. Pi composes the first frames before this extension's hook
runs, so they still read as Pi's plain text.

Progress is counted by overriding `push` on the one stream instance this extension hands
to Pi. Pi consumes compaction streams through `stream.result()` rather than by iterating
them, so the events cannot be tapped at the iterator; `push` still sees every event, and
overriding it leaves completion, errors, aborts, and `result()` untouched.

These are the extension's only undocumented seams, and they are optional by construction:
`pi update` replaces Pi's package (never this extension), and the seams are resolved when
the extension loads, so a renamed export, method, or label wording costs the label and
nothing else — compaction keeps running on the configured model.

## Failure visibility

Notices go through `ctx.ui.notify()`, which Pi renders inside the transcript: warnings as
`Warning: ...`, failures as `Error: ...`, both above the composer and in the scrollback
like any other chat line. Nothing writes to the terminal, and no widget is pinned next to
the editor. A later successful compaction redraws the transcript from session entries and
clears those lines; a note that must survive that would need a custom session entry plus
an entry renderer. Aborted compactions stay silent.

## Verification

Load this file the way Pi does (jiti + Pi's alias map), register the extension against a
fake `pi.on`, and drive a manual compaction with `globalThis.fetch` stubbed:

- config resolves `{model, thinkingLevel, serviceTier}` from `~/.pi/agent/settings.json`
- the outgoing body contains `service_tier: "priority"` plus `reasoning.effort: "high"`
- without `serviceTier` in settings the field is absent
- an invalid tier warns in the UI and falls back to the standard tier
- the stream is requested from `ctx.modelRegistry`, so a provider wrapper owns auth
- `applyCodexFastCost` restates GPT-6 summary usage at 2.5x and GPT-5.4 at 2x
- the compacting spinner names the model, marks a fast tier with `(fast)`, and shows a
  live output-token bar against the pass budget plus elapsed time, without altering other
  loaders
