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
