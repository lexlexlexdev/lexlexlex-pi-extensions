# lexlexlex-compaction-fast

Local fork of [`pi-compaction-model`](https://github.com/JMHSV/pi-compaction-model) (JMHSV, MIT, v0.1.0)
that adds **Fast mode** support to Pi's native compaction.

Everything upstream does is unchanged: a dedicated model handles compaction through
Pi's own `compact()` (same prompts, same algorithm, same fallbacks), and any failure
falls back to Pi's active model.

## What it adds

`compactionModel.serviceTier` — injects OpenAI's `service_tier` into the compaction
request only. Fast mode (renamed from Priority processing on 2026-07-30) is billed at
2x standard rates.

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
| `"priority"` or `"fast"` | Fast mode. OpenAI accepts both; `priority` is preferred so Pi's cost multiplier (which recognizes only `priority` and `flex`) reports 2x |
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

Tier injection is skipped for providers whose API module would accept the field but
whose endpoint is not the OpenAI platform API, e.g. `openai-codex` (ChatGPT backend).

## Verification

Load this file the way Pi does (jiti + Pi's alias map), register the extension against a
fake `pi.on`, and drive a manual compaction with `globalThis.fetch` stubbed:

- config resolves `{model, thinkingLevel, serviceTier}` from `~/.pi/agent/settings.json`
- the outgoing body contains `service_tier: "priority"` plus `reasoning.effort: "high"`
- without `serviceTier` in settings the field is absent
- an invalid tier logs a warning and falls back to the standard tier
