# secret-mask

Keep project secrets out of provider requests without making the agent useless.

The model works with `__SECRET_<NAME>__` tokens. Real values are substituted at the last possible moment:
bash gets them through the child environment. Files never receive real values - a write or edit
that contains a registered token is refused. Tool output, prompts, and every provider payload are
masked on the way out.

## How it works

```
input                      pasted secrets masked before they enter the transcript
before_provider_request    final belt: every known value -> token in the whole payload
tool_call  bash            token -> ${PI_SECRET_X} + `export` prologue carrying the value (only registered tokens are rewritten)
tool_call  write/edit      registered token -> call refused (values never enter files)
tool_call  read/grep/...   `deny` paths blocked before execution
tool_result read          `redact` paths return a key-filtered view
tool_result grep          each match line is judged by its own file's policy (deny -> marker)
tool_result bash          gopass output is registered, then masked like any other value
tool_result other         known values masked back out of the output
session_before_compact/_tree   summaries masked too
```

Nothing is stored by the extension: the registry lives in memory and is rebuilt from the
Values become known when the model actually touches them: reading a `redact`-listed file
tokenizes its values, and any tool output is scanned on sight for sensitive `KEY=value`
pairs (a `cat .env.staging` is tokenized even though nothing was read first). There is no
startup scan of the workspace, so unused files contribute nothing and cannot mangle prose.

## Install

`settings.json` → `packages`:

```json
"~/.pi/agent/extensions/secret-mask"
```

Then `/reload`. The extension declares itself through `package.json` → `pi.extensions: ["./index.ts"]`.
`node_modules/typebox` is a symlink to the copy bundled with pi (runtime resolution + tests).

## Config (`config.json`)

Rules are **first match wins**. Unmatched paths are plain text: no key filtering, no view
rewriting.

| action | effect |
|---|---|
| `allow` | content passes through untouched |
| `redact` | values whose key is sensitive become `__SECRET_<KEY>__`; values are harvested so they are masked anywhere else |
| `deny` | the tool call is blocked with a reason the model can read |

```jsonc
{
  "bash": { "envPrefix": "PI_SECRET_" },
  "files": [
    { "match": [".env.example", "*.example"], "action": "allow" },
    { "match": [".env.local"], "action": "allow" },
    { "match": [".env", ".env.staging", ".env.production", "**/.env"], "action": "redact" },
    { "match": ["**/.ssh/*"], "action": "deny" }
  ],
  "safeKeys": ["NODE_ENV", "PORT", "HOST", "LOG_LEVEL", "TZ", "CI", "REGION", "..."],
  "sensitiveKeys": ["*KEY*", "*TOKEN*", "*SECRET*", "*PASSWORD*", "*DSN*", "*AUTH*", "..."]
}
```

Patterns match the cwd-relative path, the absolute path, and (for patterns without `/`) the
basename. `**/` matches zero or more directories, so `**/.env` covers both `.env` and
`config/prod/.env`. A path and its symlink target are both resolved and the **strictest verdict
wins**, so a link cannot be used to read a rule-covered file as plain text.

### Redaction decision for a key inside a `redact` file

1. value looks like a known secret shape (`sk-…`, `ghp_…`, `AIza…`, `AKIA…`, JWT, PEM, custom) → redact
2. key matches a rule `keys.deny` entry or `sensitiveKeys` → redact
3. key matches a rule `keys.allow` entry → visible
4. key matches `safeKeys` → visible
5. otherwise → redact (fail-closed)

Formats understood: `.env`/`KEY=VALUE`, JSON, YAML, TOML, INI/`.properties`/`.cfg`, `.tfvars`.
Override per rule with `"formats": ["json"]`.

### Other options

| key | default | meaning |
|---|---|---|
| `minSecretLength` | `4` | shorter values are never tokenized or masked |
| `maskValuesEverywhere` | `true` | keep masking known values in content of unmatched files |
| `maxFileBytes` | `2000000` | larger files are not parsed |
| `patterns` | all but `base64` | built-in secret shapes |
| `customPatterns` | `[]` | `[{ "name": "MY_TOK", "pattern": "mytok-[a-z0-9]{16}" }]`, group 1 = value |

### What gets masked globally

A value read from a `redact`-listed file becomes a token in the file view. Anything the model
can only see as a token must also be masked wherever else it appears, otherwise `cat`-ing the
same file through bash would print it verbatim. So a redact-classified value is masked globally
unless it is one of these:

- shorter than `minSecretLength` (4)
- a bare number shorter than 6 digits (ports, ids, exit codes)
- a benign word from a small built-in list (`production`, `staging`, `localhost`, `text`, `json`, …)

A bare number of 6+ digits and a benign word are still masked when the key name itself is
sensitive (`*PASSWORD*`, `*TOKEN*`, `*KEY*`, …), so `ADMIN_TOKEN=456789` is masked while
`WORKER_ID=1234` is not. Values left visible by these rules are the known residual: they are
tokenized in the read view, but a shell command that prints the file raw shows them.

## Commands and tools

| name | purpose |
|---|---|
| `/secret-list` | Panel above the editor: every value grouped by kind (`file`, `pattern`, `seen`, `manual`, `gopass`, `config`) and by the file or store entry it came from. Run again to hide. Pass `all` to skip the line cap. |
| `/secret-add NAME VALUE` | register a value for this session |
| `/secret-reload` | re-read the `redact`-listed files this session touched, refreshing their values |
| `/secret-toggle` | masking on/off for this session (`/secret-toggle on`, `off`, or no argument to flip) |
| `request_secret` tool | the model asks for a value; you type it, the model only receives the token |

## Writes

`write` and `edit` never receive real values. If the content contains a registered token the call is
refused with an explanation, and the input is left untouched. Token-shaped text that no value backs
(documentation mentioning __SECRET_<NAME>__, or placeholder strings from other tools) is ordinary text and is
written verbatim.

To place a value into a file, use bash, where the token becomes an exported variable:

```bash
sh -c 'printf "%s\n" "DB_PASSWORD=$PI_SECRET_DB_PASSWORD" >> .env.staging'
```

The extension itself never writes a credential into a file: the shell does it, under your
command, in one place.

## Bash mechanism

```bash
# model writes
curl -H "Authorization: Bearer __SECRET_PROD_TOKEN__" https://api.example

# executed
export PI_SECRET_PROD_TOKEN='<real value, shell-escaped>'; curl -H "Authorization: Bearer ${PI_SECRET_PROD_TOKEN}" https://api.example
```

The value travels in the environment, never in argv, so it does not show up in `ps`; the env
prefix means compound commands (`&&`, subshells) still see it. Values containing quotes, `$`,
spaces, or newlines work — no metacharacter restrictions, no whitelist of "safe" secrets.

## Password managers

`gopass show <entry>` prints values this masker has never seen, and those would go straight to the
provider. When a bash call starts with `gopass`, whatever the entry printed is registered as a value
and masked back out of the same result, so the transcript gets tokens instead:

```
infra/db: __SECRET_GOPASS_INFRA_DB__
```

Names come from the entry path (`api/stripe` becomes `GOPASS_API_STRIPE`) and field lines get the
field name appended, except when a pass-style entry repeats its own path as the field name. Lines
without a field name are registered under the entry, and comments are ignored. From there the value behaves like any other: exported variable in bash, refused
in writes, masked in tool output, listed by the list command under the `gopass` kind. Output is only attributed to the
store when every other command in the line is a store command or a consumer (`cat`, `jq`, `wc`, ...);
`echo x && gopass show y` harvests nothing, because the lines could have come from `echo`. `gopass otp`
and the listing subcommands are left alone, rotating codes and entry listings are not values.

## Limitations

- **Fail-closed on provider requests, fail-open per tool result.** If the provider hook cannot
  mask a payload, the turn is aborted and every string in the payload is replaced with a marker,
  so a failed abort cannot ship it either. A failure while masking one tool result
  is caught and that single result is passed through unmasked (the next provider request still
  applies the value net), so a broken masker cannot turn every tool result into an error.
- **`/secret-list` opens an overlay panel, not an editor widget.** The host truncates `setWidget`
  string arrays at 10 lines ("... (widget truncated)"), which is what made the panel look collapsed.
  The overlay renders a centered window (100 columns, up to 34 rows), scrolls the rest, and closes
  with esc or q. Keys: up/down and j/k move a line, pgup/pgdn move a screen, home/end (or g/G) jump.
  Without overlay support the command falls back to a one line tally notice.
- **Word-like values are boundary-aware.** A value of letters and underscores only, harvested
  automatically, is either not masked at all (shorter than 12 characters) or masked only as a whole
  word (shorter than 24), so prose, file names and identifiers such as `request_<word>` stay intact.
  Values with digits or punctuation are still masked anywhere they appear, and a value registered
  on purpose with the add command or the request tool is masked wherever it appears, identifiers
  included. A genuine letters-only credential shorter than 12 characters is therefore only hidden
  inside redacted file views: register it explicitly if it must never appear in shell output.
- **Values the masking rules deliberately skip** (benign words, bare numbers, anything shorter
  than `minSecretLength`) are tokenized in a redacted file view but a shell command that prints
  the file raw still returns them. Keep genuinely sensitive values at 4+ characters, or name
  their keys after `*PASSWORD*`/`*TOKEN*`/`*KEY*` so the numeric exception does not apply.
- **Detection is regex-based.** A secret in an unrecognized format is caught only if its file is
  covered by a `redact` rule, it matches a built-in/custom pattern, or you registered it.
- **Bash path checks are heuristic.** `deny` rules catch direct path arguments (`cat x.env`,
  `grep y x.env`); an indirect read (`python -c "open('x.env').read()"`, `$(...)` indirection)
  is not detected — its output is still masked by value, but the file is not blocked. `grep`
  *results* are checked per matched file, so a denied file cannot leak through a directory search.
- **Custom regexes are your responsibility.** A pathological `customPatterns` regex can hang the
  request walk; prefer anchored, bounded patterns.
- **Images (screenshots) are not masked** and pass through untouched.
- **`user_bash` (`!cmd`) is not rewritten**: pi's `user_bash` result type can only supply custom
  `BashOperations` or a finished result, not an edited command string, so tokens you type there
  are not expanded. Use the agent's bash.
- **Not a sandbox.** The model still reads and writes locally under your permissions; this
  extension only controls what leaves the process. Pair it with a permission layer.
- Values reach subprocesses of a wrapped bash command (that is the point); anything that dumps
  `env` inside that command leaks locally — tool output is masked, files it writes are not.

## Tests

```bash
node --test test/*.test.ts
```

Unit coverage: key classification order, dotenv/JSON/YAML/grep parsing and span math, span
replacement, registry behaviour (token collisions, unmask-only short values, source pruning,
`seen` stickiness), bash rewriting and quoting, glob/rule resolution, file scanning.
Integration coverage (mock extension host around the real `index.ts`): redacted read views,
unmatched-file value net, bash env injection, token-free bash pass-through, deny rules, write/edit
refusal, provider payload masking, input masking, per-file grep policy, symlink resolution,
`.env` rotation, short-value masking consistency, the benign/number exceptions, fail-closed
abort, and both register paths.

## Footer status

`mask: on` while masking is active, `mask: false` when `/secret-toggle off` turned it off for the
session, and `mask: on, NEW SECRET ADDED` for six seconds after a new value got registered. The
registry is kept while masking is off, so switching back on restores the same tokens.

Bash commands that contain a token are rewritten with the value injected into that command's
environment as `PI_SECRET_<NAME>`. The notice stays loud when the value belongs to the project:
it came from a file inside the working directory, a store entry, a pair seen in project output,
or your own add/paste. It stays quiet when the value is machinery only: provider echoes,
summarizer text, `seen` leftovers, pattern hits from arbitrary tool output, or files outside the
workspace.
(`/secret-list`, `/secret-add`, `/secret-reload`, `/secret-toggle`) still report their result.

## Session scope and residual risk

Masking state is session-scoped: `/secret-toggle off`, the registry and the set of touched files all
reset when a new session starts in the same process.

Also masked now: a tool's `details` payload, tool parameter schemas and image URLs in provider
requests, and values inside JSON arrays or YAML block scalars in a protected file (a
format-independent sweep runs after the parser). On-sight detection only rewrites values that carry
their own evidence: a URL without a userinfo part, a short digit-free string such as `foo-bar` or
`db.internal`, and bare words stay as they are. Past 20000 registry entries, new values are still
masked, under generic token names.

This is a convenience layer, not a credential boundary. It keeps secrets out of the model's context.
It cannot stop a tool from writing or transmitting a value it can already read, and transcripts,
subagent sessions and files written by tools are outside its reach.
