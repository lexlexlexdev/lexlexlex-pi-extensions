# Security Review — `@lexlexlex/permission-gates`

Reviewed: `index.ts`, plus interplay with `lexlexlex-tool-render.ts`.
Scope: the extension's own gate logic. **This is a guardrail, not a sandbox** —
the agent's process can always touch whatever the user can. The gates defend
against *accidents* and raise friction for *prompt-injected* actions; they do
not contain a determined adversary with arbitrary-code execution.

## Status note

The extension overrides the built-in `bash` tool to add an optional agent-supplied
`explanation` parameter, displayed in gate prompts and tool cards. It is
**advisory only**: commands are never blocked for omitting it. Because tool
registration is last-write-wins across extensions and other packages may also
override `bash`, the gates re-assert ownership on `session_start` and before
each agent turn.

## Threat model

| Threat | Covered? | Notes |
|---|---|---|
| Model hallucinating a destructive command | Yes | Primary target: confirm dialogs + critical refusals |
| Prompt-injected model running exfil/destructive commands | Partially | Regex gates catch known shapes; obfuscated payloads (base64, eval, heredocs) can evade |
| User-typed `!bash` accidents | Yes | Same gates on `user_bash`, no prompts bypassed |
| Malicious model deliberately evading gates | No | Not a sandbox; see limits section |

## Findings & fixes applied

| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | High | Critical `rm -rf` patterns missed shell-quote tricks: `rm -rf "$HOME"`, `'~/...'` | **Fixed** — quote-stripped matching subject (`gateSubjects`) |
| F2 | High | `sh -c '…'` / `bash -lc '…'` wrappers hid inner destructive commands entirely | **Fixed** — wrapper unwrapping (up to 3 levels) |
| F3 | Medium | Home pattern missed `/home/<user>` targets (Linux layout) and `--` separator | **Fixed** — added alternations + optional `--` |
| F4 | Medium | Sensitive-read regex missed absolute home paths (`/Users/x/.ssh/...`, `/root/.aws`), relative `.ssh/`, key filenames (`id_rsa`) | **Fixed** — extended alternations; also applies to read/grep/find/ls gating |
| F5 | Medium | First-match-wins risk reporting: `sudo git push` labeled "Privilege escalation", masking the git-mutation session allowance | **Fixed** — `collectRisks()` merges all hits: labels joined, level escalated, first allowance kept |
| F6 | Low | Stray `.` in home-pattern char class (harmless but wrong) | **Fixed** during rewrite |

## Known limitations (accepted)

| Limitation | Rationale |
|---|---|
| No base64/heredoc/var-indirection decoding (`echo cm0gLXJmIH4= \| base64 -d \| sh`) | Decoding arms-race; keep the layer simple and auditable. Acceptable for a guardrail. |
| `..` traversal from cwd to home not resolved (no cwd context at match time) | Would need path resolution against real cwd + fs checks; complexity/risk of false negatives worse than gain. |
| `find … -delete` on $HOME is a prompt-level risk, not hard-blocked | Destructive-delete allowance covers it after explicit consent. |
| Gate regexes duplicated (cosmetic copy) in `lexlexlex-tool-cards.ts` `NON_SAFE_BASH_PATTERNS` | Only drives the warning dot color. If you tighten gates again, consider importing one shared list. |
| Explanation field is agent-supplied text, unverified | It exists for informed consent and audit trail, never as an authorization signal. |

## Verification

Test matrix (`/tmp/gate-matrix.mjs`, run against the real exported pipeline):
all former bypasses (B1–B5) now hit CRITICAL block; B6/B7 still caught;
benign commands (`grep -rf src/`, `npm install -g`, `git commit`) do not trip
critical; sensitive-path cases S1–S8 all correct; `sudo git push` reports both
labels and offers `git-mutation`.

Live dogfood: the running pi session blocked its own maintainer probe twice
(missing explanation; `sed -i`) — enforcement confirmed end-to-end.
