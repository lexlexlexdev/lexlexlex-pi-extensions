/**
 * secret-mask policy layer.
 *
 * Responsibilities:
 * - config loading + validation (config.json next to the extension)
 * - path rules: glob -> action (allow | redact | deny)
 * - key classification: secret-shape -> sensitive -> explicit allow -> safe -> fail-closed
 * - config-format parsing (env/json/yaml/toml/ini/kv) with exact value spans
 * - filesystem scanning for redact/deny rule patterns
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

export type Action = "allow" | "redact" | "deny";
export type Format = "env" | "json" | "yaml" | "toml" | "ini" | "kv";

export interface FileRule {
  /** Globs matched against the cwd-relative path, the absolute path, and the basename. */
  match: string[];
  action: Action;
  /** Override the detected format for this rule. */
  formats?: Format[];
  keys?: { allow?: string[]; deny?: string[] };
}

export interface PatternToggles {
  openai: boolean;
  github: boolean;
  google: boolean;
  aws: boolean;
  jwt: boolean;
  pem: boolean;
  base64: boolean;
}

export interface SecretMaskConfig {
  bash: { envPrefix: string };
  files: FileRule[];
  safeKeys: string[];
  sensitiveKeys: string[];
  patterns: PatternToggles;
  customPatterns: { name: string; pattern: string; flags?: string }[];
  /** Values shorter than this are never masked (avoids mangling ordinary text). */
  minSecretLength: number;
  /** Keep masking known values in content of files no rule covers. */
  maskValuesEverywhere: boolean;
  /** Depth for recursive (`**`) pattern scanning. */
  scanDepth: number;
  /** Files larger than this are not parsed for harvest/redaction. */
  maxFileBytes: number;
  base64MinLength: number;
}

export const DEFAULT_SAFE_KEYS = [
  "NODE_ENV",
  "APP_ENV",
  "ENV",
  "PORT",
  "HOST",
  "HOSTNAME",
  "LOG_LEVEL",
  "LOG_FORMAT",
  "LOG_FILE",
  "TZ",
  "LANG",
  "LC_ALL",
  "CI",
  "DEBUG",
  "VERBOSE",
  "SERVICE_NAME",
  "APP_NAME",
  "VERSION",
  "APP_VERSION",
  "BUILD_ID",
  "COMMIT_SHA",
  "NODE_VERSION",
  "PYTHON_VERSION",
  "TERM",
  "SHELL",
  "USER",
  "HOME",
  "WORKDIR",
  "REGION",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "GCP_REGION",
  "DEFAULT_REGION",
];

export const DEFAULT_SENSITIVE_KEYS = [
  "*KEY*",
  "*TOKEN*",
  "*SECRET*",
  "*PASSWORD*",
  "*PASSWD*",
  "*PWD*",
  "*CREDENTIAL*",
  "*DSN*",
  "*AUTH*",
  "*COOKIE*",
  "*SESSION*",
  "*PRIVATE*",
  "*WEBHOOK*",
  "*SIGNATURE*",
  "*SALT*",
  "*CONNECTION_STRING*",
  "*_URI",
  "*_URL",
];

export const DEFAULT_CONFIG: SecretMaskConfig = {
  bash: { envPrefix: "PI_SECRET_" },
  files: [],
  safeKeys: DEFAULT_SAFE_KEYS,
  sensitiveKeys: DEFAULT_SENSITIVE_KEYS,
  patterns: { openai: true, github: true, google: true, aws: true, jwt: true, pem: true, base64: false },
  customPatterns: [],
  minSecretLength: 4,
  maskValuesEverywhere: true,
  scanDepth: 4,
  maxFileBytes: 2_000_000,
  base64MinLength: 32,
};

/* ------------------------------------------------------------------ globbing */

function escapeRegExpChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Convert a glob to a regex. `*` = within a path segment, `**` = across segments. */
export function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i++;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegExpChar(ch);
    }
  }
  return new RegExp(out + "$");
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Does `pattern` match this path? Globs without a slash also match the basename. */
export function matchPath(pattern: string, relPath: string, absPath: string): boolean {
  const rel = toPosix(relPath);
  const abs = toPosix(absPath);
  const base = rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
  const re = globToRegExp(pattern);
  if (re.test(rel) || re.test(abs)) return true;
  if (!pattern.includes("/")) return re.test(base);
  return false;
}

/** Key matching: case-insensitive, `*` spans any characters (including none). */
export function matchKey(pattern: string, key: string): boolean {
  const re = new RegExp("^" + pattern.split("*").map(escapeRegExpChar).join(".*") + "$", "i");
  return re.test(key);
}

export function matchAnyKey(patterns: string[], key: string): boolean {
  return patterns.some((p) => matchKey(p, key));
}

/* ------------------------------------------------------------------- actions */

export interface ActionResolution {
  action: Action;
  rule: FileRule | undefined;
}

/** First matching rule wins; unmatched paths are plain text. */
export function resolveAction(relPath: string, absPath: string, rules: FileRule[]): ActionResolution {
  for (const rule of rules) {
    if (rule.match.some((p) => matchPath(p, relPath, absPath))) return { action: rule.action, rule };
  }
  return { action: "allow", rule: undefined };
}

export interface ClassifyContext {
  sensitiveKeys: string[];
  safeKeys: string[];
  rule?: FileRule;
  /** Value matches a built-in or custom secret shape. */
  shaped: (value: string) => boolean;
}

/** Names that mark a value as sensitive regardless of its shape. */
export function isSensitiveKeyName(key: string, rule: FileRule | undefined, sensitiveKeys: string[]): boolean {
  return matchAnyKey([...(rule?.keys?.deny ?? []), ...sensitiveKeys], key);
}

/**
 * Order matters, first match wins:
 * secret shape -> rule deny / sensitive name -> rule allow -> safe name -> fail-closed redact.
 */
export function classifyKey(key: string, value: string, ctx: ClassifyContext): "visible" | "redact" {
  if (value && ctx.shaped(value)) return "redact";
  if (isSensitiveKeyName(key, ctx.rule, ctx.sensitiveKeys)) return "redact";
  if (matchAnyKey(ctx.rule?.keys?.allow ?? [], key)) return "visible";
  if (matchAnyKey(ctx.safeKeys, key)) return "visible";
  return "redact";
}

/**
 * Values that are safe to leave visible even inside a redact-listed file.
 * Kept deliberately small: every entry here can reach the provider unmasked.
 */
const BENIGN_VALUES = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "development",
  "production",
  "staging",
  "test",
  "local",
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "text",
  "tool",
  "json",
  "image",
  "input",
  "output",
  "content",
  "string",
  "number",
  "boolean",
  "object",
  "utf-8",
  "utf8",
  "https",
  "http",
  "application",
]);

/**
 * Should a redact-file value be masked globally (not just tokenized in the file view)?
 *
 * The read view tokenizes every redact-classified value, so anything readable only as a
 * token must also be masked wherever else it shows up — otherwise `cat`-ing the same file
 * through bash would print it verbatim. Short values are the only place this gets loud, so
 * pure numbers (ports, ids) and a small benign word list are the exceptions.
 */
export function isMaskableValue(
  value: string,
  cfg: SecretMaskConfig,
  opts: { shaped: boolean; sensitiveKey: boolean; onSight?: boolean },
): boolean {
  const v = value.trim();
  if (!v) return false;
  if (opts.shaped) return true;
  if (v.length < cfg.minSecretLength) return false;
  if (BENIGN_VALUES.has(v.toLowerCase())) return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return v.length >= 6 && opts.sensitiveKey;
  if (opts.onSight) {
    // A value spotted in arbitrary output needs its own evidence. A URL without a userinfo part is
    // ordinary data, and a short digit-free string (`foo-bar`, `db.internal`, a hostname or a path)
    // is too: those used to be replaced inside prose, paths and code.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i.test(v);
    if (!/\d/.test(v) && v.length < 12) return false;
  }
  if (/\d/.test(v)) return v.length >= 6;
  // Punctuation suggests a generated credential: sk-abc, hunter2-xyz, ab_cd-1234.
  if (/[^A-Za-z0-9]/.test(v)) return v.length >= 6;
  // Letters only is a word, not a credential. Dev placeholders like a bare word in JWT_SECRET used
  // to be masked everywhere, which mangled ordinary prose, file names and tool names.
  return v.length >= (opts.sensitiveKey ? 12 : 20);
}

/* ------------------------------------------------------------------- formats */

export function detectFormat(path: string): Format {
  const base = basename(path).toLowerCase();
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot) : "";
  if (base === ".env" || base.startsWith(".env") || ext === ".env") return "env";
  if (ext === ".json" || ext === ".jsonc" || ext === ".json5") return "json";
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  if (ext === ".toml") return "toml";
  if (ext === ".tfvars" || ext === ".tf") return "kv";
  if (ext === ".ini" || ext === ".cfg" || ext === ".conf" || ext === ".properties") return "ini";
  if (base === "credentials" || base === "config") return "ini";
  return "env";
}

export interface KVSpan {
  key: string;
  /** Value span inside the source text (exclusive end); quotes are preserved. */
  valueStart: number;
  valueEnd: number;
}

/** YAML block/folded scalar indicator: `|`, `>`, optionally with indentation or chomping. */
const BLOCK_SCALAR = /^[|>](?:[0-9]*[+-]?|[+-][0-9]*)$/;

interface LineParse {
  key: string;
  valueStart: number;
  valueEnd: number;
}

function parseQuoted(seg: string, offset: number): LineParse | undefined {
  const trimmedStart = seg.length - seg.replace(/^\s+/, "").length;
  let start = offset + trimmedStart;
  const raw = seg.trim();
  if (!raw) return undefined;
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    let end = -1;
    for (let i = 1; i < raw.length; i++) {
      if (raw[i] === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (raw[i] === quote) {
        end = i;
        break;
      }
    }
    if (end <= 1) return undefined;
    return { key: "", valueStart: start + 1, valueEnd: start + end };
  }
  // Unquoted: an inline comment starts at " #" (dotenv convention).
  let value = raw;
  const hash = value.search(/\s#/);
  if (hash >= 0) value = value.slice(0, hash);
  const trimmed = value.replace(/\s+$/, "");
  if (!trimmed) return undefined;
  return { key: "", valueStart: start, valueEnd: start + trimmed.length };
}

/**
 * Scalar values of a JSON document with the key that owns each one. Works on fragments too:
 * values inside arrays inherit the key of the array, nested objects report their own keys,
 * and a scalar with no owning key never surfaces. Tokenizing an array element is what keeps
 * `{"DB_PASSWORD":["hunter2"]}` from printing the value.
 */
export function parseJsonSpans(content: string, inheritedKey?: string): KVSpan[] {
  interface Frame {
    type: "obj" | "arr";
    key: string | null;
    pending: string | null;
    expectKey: boolean;
  }
  const spans: KVSpan[] = [];
  const stack: Frame[] = [{ type: "obj", key: null, pending: null, expectKey: true }];
  const re = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\],:]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const token = m[0];
    const start = m.index;
    const top = stack[stack.length - 1];
    if (token === "{" || token === "[") {
      stack.push({
        type: token === "{" ? "obj" : "arr",
        key: top.pending ?? top.key ?? inheritedKey ?? null,
        pending: null,
        expectKey: token === "{",
      });
      top.pending = null;
      continue;
    }
    if (token === "}" || token === "]") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (token === ",") {
      top.expectKey = top.type === "obj";
      top.pending = null;
      continue;
    }
    if (token === ":") {
      if (top.type === "obj") top.expectKey = false;
      continue;
    }
    if (top.type === "obj" && top.expectKey) {
      top.pending = decodeKeyToken(token);
      continue;
    }
    const key = top.type === "obj" ? top.pending : top.key;
    top.pending = null;
    if (key === null) continue;
    const quoted = token.startsWith('"');
    const valueStart = start + (quoted ? 1 : 0);
    const valueEnd = start + token.length - (quoted ? 1 : 0);
    if (valueEnd > valueStart) spans.push({ key, valueStart, valueEnd });
  }
  return spans;
}

function decodeKeyToken(token: string): string {
  if (!token.startsWith('"')) return token;
  try {
    return String(JSON.parse(token));
  } catch {
    return token.slice(1, -1);
  }
}

/**
 * Parse a config document into key/value spans. Only surfaces an existing key to
 * value range, so redaction can replace the value and keep formatting intact.
 */
export function parseKV(format: Format, content: string): KVSpan[] {
  const spans: KVSpan[] = [];
  const push = (key: string, seg: string, segOffset: number) => {
    const parsed = parseQuoted(seg, segOffset);
    if (!parsed) return;
    spans.push({ key, valueStart: parsed.valueStart, valueEnd: parsed.valueEnd });
  };

  if (format === "json") return parseJsonSpans(content);

  const yamlLike = format === "yaml";
  const lineRe = yamlLike
    ? /^([ \t]*(?:-[ \t]+)?)([A-Za-z_][A-Za-z0-9_.\-]*)([ \t]*:[ \t]*)(.*)$/
    : format === "toml"
      ? /^([ \t]*)([A-Za-z_][A-Za-z0-9_.\-]*)([ \t]*=[ \t]*)(.*)$/
      : /^([ \t]*)(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.\-]*)([ \t]*[=:][ \t]*)(.*)$/;

  const lines = content.split("\n");
  const offsets: number[] = [];
  {
    let cursor = 0;
    for (const line of lines) {
      offsets.push(cursor);
      cursor += line.length + 1;
    }
  }
  let skipLines = 0;
  for (let index = 0; index < lines.length; index++) {
    if (skipLines > 0) {
      skipLines -= 1;
      continue;
    }
    const rawLine = lines[index];
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const lineStart = offsets[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    if (format === "ini" && /^\[.*\]$/.test(trimmed)) continue;
    const m = lineRe.exec(line);
    if (!m) continue;
    const [, , key, , rest] = m;
    // A block scalar (`KEY: |` / `KEY: >`) owns the lines under it, whatever the file format.
    // Tokenize every body line and keep those lines out of the key parser: the indicator is not
    // the value, and the body must not be left readable.
    if (BLOCK_SCALAR.test(rest.trim())) {
      const baseIndent = line.length - line.trimStart().length;
      let last = index;
      for (let j = index + 1; j < lines.length; j++) {
        const body = lines[j].endsWith("\r") ? lines[j].slice(0, -1) : lines[j];
        if (body.trim() === "") continue;
        const indent = body.length - body.trimStart().length;
        if (indent <= baseIndent) break;
        const start = offsets[j] + indent;
        spans.push({ key, valueStart: start, valueEnd: start + body.trim().length });
        last = j;
      }
      skipLines = last - index;
      continue;
    }
    const segOffset = lineStart + m.index + m[0].length - rest.length;
    push(key, rest, segOffset);
  }
  return spans;
}

export interface RedactDecision {
  token: string | null;
  key: string;
  value: string;
}

/**
 * Replace values in the parsed spans. `decide` returns the token to substitute or
 * null to keep the value visible.
 */
export function redactSpans(
  content: string,
  spans: KVSpan[],
  decide: (key: string, value: string) => string | null,
): { text: string; redacted: { key: string; value: string }[]; visible: string[] } {
  const ordered = [...spans].sort((a, b) => b.valueStart - a.valueStart);
  let text = content;
  const redacted: { key: string; value: string }[] = [];
  const visible: string[] = [];
  for (const span of ordered) {
    const value = content.slice(span.valueStart, span.valueEnd);
    if (!value) continue;
    const token = decide(span.key, value);
    if (token) {
      text = text.slice(0, span.valueStart) + token + text.slice(span.valueEnd);
      redacted.push({ key: span.key, value });
    } else {
      visible.push(span.key);
    }
  }
  return { text, redacted, visible };
}

/** Redact a grep-style dump: handles `path:line:KEY=value` prefixes per line. */
const GREP_PREFIX = /^([^\n:]*:\d+:)(.*)$/;

export function redactLines(
  content: string,
  format: Format,
  decide: (key: string, value: string) => string | null,
): { text: string; redacted: { key: string; value: string }[] } {
  const out: string[] = [];
  const redacted: { key: string; value: string }[] = [];
  for (const line of content.split("\n")) {
    const prefixed = GREP_PREFIX.exec(line);
    const body = prefixed ? prefixed[2] : line;
    const spans = parseKV(format, body);
    if (spans.length === 0) {
      out.push(line);
      continue;
    }
    const result = redactSpans(body, spans, decide);
    for (const r of result.redacted) redacted.push(r);
    out.push(prefixed ? prefixed[1] + result.text : result.text);
  }
  return { text: out.join("\n"), redacted };
}

/* ------------------------------------------------- format-independent pairs */

interface PairCandidate {
  key: string;
  start: number;
  end: number;
}

interface KeyHit {
  key: string;
  keyStart: number;
  sepEnd: number;
  boundary: boolean;
}

const KEY_BARE = /(?<![A-Za-z0-9_])[A-Za-z_][A-Za-z0-9_.\-]*[ \t]*[=:]/g;
const KEY_DQUOTED = /"((?:[^"\\]|\\.)*)"[ \t]*:/g;
const KEY_SQUOTED = /'([^']*)'[ \t]*:/g;

function readQuoted(text: string, start: number): { start: number; end: number } | undefined {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && quote === '"') {
      i += 2;
      continue;
    }
    if (ch === quote) return { start: start + 1, end: i };
    if (ch === "\n") return undefined;
    i += 1;
  }
  return undefined;
}

/** Offset of the `]`/`}` matching the bracket at `start`, ignoring brackets inside strings. */
function matchingBracket(text: string, start: number): number {
  const open = text[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quoted = readQuoted(text, i);
      if (quoted) {
        i = quoted.end + 1;
        continue;
      }
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Key occurrences anywhere in the text: quoted keys always count, bare keys only when they
 * start a token (line start or after whitespace). A bare `a=b` inside a value stays part of
 * that value; a key in `warning: DB_PASSWORD=...` starts its own value.
 */
function keyHits(text: string): KeyHit[] {
  const hits: KeyHit[] = [];
  for (const m of text.matchAll(KEY_DQUOTED)) {
    hits.push({
      key: decodeKeyToken(`"${m[1]}"`),
      keyStart: m.index,
      sepEnd: m.index + m[0].length,
      boundary: true,
    });
  }
  for (const m of text.matchAll(KEY_SQUOTED)) {
    hits.push({ key: m[1], keyStart: m.index, sepEnd: m.index + m[0].length, boundary: true });
  }
  for (const m of text.matchAll(KEY_BARE)) {
    const lineStart = text.lastIndexOf("\n", Math.max(0, m.index - 1)) + 1;
    const before = m.index > 0 ? text[m.index - 1] : "\n";
    hits.push({
      key: m[0].replace(/[ \t]*[=:]$/, ""),
      keyStart: m.index,
      sepEnd: m.index + m[0].length,
      boundary: /\s/.test(before) || /^[ \t]*$/.test(text.slice(lineStart, m.index)),
    });
  }
  return hits.sort((a, b) => a.keyStart - b.keyStart || a.sepEnd - b.sepEnd);
}

/** One span per non-empty line of the block that follows a `KEY:` header. */
function blockBodySpans(text: string, key: string, lineStart: number, lineEnd: number): PairCandidate[] {
  let baseIndent = 0;
  while (text[lineStart + baseIndent] === " " || text[lineStart + baseIndent] === "\t") baseIndent += 1;
  const spans: PairCandidate[] = [];
  let cursor = lineEnd + 1;
  while (cursor < text.length) {
    let end = text.indexOf("\n", cursor);
    if (end < 0) end = text.length;
    const line = text.slice(cursor, end).replace(/\r$/, "");
    const trimmed = line.trim();
    if (trimmed !== "") {
      const indent = line.length - line.trimStart().length;
      if (indent <= baseIndent) break;
      const start = cursor + indent;
      spans.push({ key, start, end: start + trimmed.length });
    }
    cursor = end + 1;
  }
  return spans;
}

/** Value spans owned by one key hit: quoted scalar, array/map region, block scalar, inline text. */
function pairSpansFor(hit: KeyHit, text: string, nextBoundary: number): PairCandidate[] {
  const lineStart = text.lastIndexOf("\n", Math.max(0, hit.sepEnd - 1)) + 1;
  const newline = text.indexOf("\n", hit.sepEnd);
  const lineEnd = newline < 0 ? text.length : newline;
  let i = hit.sepEnd;
  while (i < lineEnd && (text[i] === " " || text[i] === "\t")) i += 1;
  const rest = text.slice(i, lineEnd);
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const quoted = readQuoted(text, i);
    if (quoted) return [{ key: hit.key, start: quoted.start, end: quoted.end }];
  }
  if (rest.startsWith("[") || rest.startsWith("{")) {
    const close = matchingBracket(text, i);
    if (close >= 0) {
      const spans = parseJsonSpans(text.slice(i, close + 1), hit.key).map((span) => ({
        key: span.key,
        start: span.valueStart + i,
        end: span.valueEnd + i,
      }));
      if (spans.length > 0) return spans;
      // Unusual inline syntax: hide the whole region rather than print a value the parser missed.
      return [{ key: hit.key, start: i, end: close + 1 }];
    }
  }
  const firstOnLine = text.slice(lineStart, hit.keyStart).trim() === "";
  const inline = rest.trim();
  if (firstOnLine && (inline === "" || BLOCK_SCALAR.test(inline))) {
    return blockBodySpans(text, hit.key, lineStart, lineEnd);
  }
  let value = text.slice(i, Math.min(lineEnd, nextBoundary)).replace(/\s+$/, "");
  const comment = value.search(/\s+#/);
  if (comment >= 0) value = value.slice(0, comment).replace(/\s+$/, "");
  if (!value) return [];
  return [{ key: hit.key, start: i, end: i + value.length }];
}

/** Sort and drop overlaps so a value is tokenized at most once. */
function settleSpans(candidates: PairCandidate[]): KVSpan[] {
  const ordered = [...candidates].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: KVSpan[] = [];
  let lastEnd = -1;
  for (const span of ordered) {
    if (span.end <= span.start || span.start < lastEnd) continue;
    out.push({ key: span.key, valueStart: span.start, valueEnd: span.end });
    lastEnd = span.end;
  }
  return out;
}

function collectPairs(text: string, accept: (key: string) => boolean): KVSpan[] {
  if (!text) return [];
  const hits = keyHits(text).filter((hit) => hit.boundary);
  const accepted = hits.filter((hit) => accept(hit.key));
  if (accepted.length === 0) return [];
  const candidates: PairCandidate[] = [];
  // Embedded JSON is parsed structurally, so `{"KEY":[...]}` yields the element values.
  for (const span of parseJsonSpans(text)) {
    if (accept(span.key)) candidates.push({ key: span.key, start: span.valueStart, end: span.valueEnd });
  }
  for (const hit of accepted) {
    let nextBoundary = Number.MAX_SAFE_INTEGER;
    for (const other of hits) {
      if (other.keyStart > hit.keyStart) {
        nextBoundary = other.keyStart;
        break;
      }
    }
    for (const span of pairSpansFor(hit, text, nextBoundary)) candidates.push(span);
  }
  return settleSpans(candidates);
}

/** Every `KEY=value` / `KEY: value` pair in free text, including pairs inside embedded JSON. */
export function parsePairsEverywhere(text: string): KVSpan[] {
  return collectPairs(text, () => true);
}

/**
 * Safety sweep for a redacted view: keys the caller calls sensitive are looked up in every
 * syntax the format parser may have missed, so a read never returns a raw value under a
 * sensitive key. Keys stay visible; values become tokens.
 */
export function sweepSensitiveSpans(text: string, isSensitive: (key: string) => boolean): KVSpan[] {
  return collectPairs(text, isSensitive);
}

/* ------------------------------------------------------------------ scanning */

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".cache",
]);

/**
 * Resolve rule patterns to concrete files under `cwd`.
 * Exact patterns are checked directly (with `~` expansion); glob patterns walk the
 * tree up to `depth`, skipping heavy directories.
 */
export function scanFiles(cwd: string, patterns: string[], depth: number, cap = 5000): string[] {
  const found = new Set<string>();
  const globs: string[] = [];
  for (const pattern of patterns) {
    if (pattern.startsWith("~")) {
      const abs = join(homedir(), pattern.slice(1));
      if (existsSync(abs)) found.add(abs);
      continue;
    }
    if (!/[*?]/.test(pattern)) {
      const abs = join(cwd, pattern);
      if (existsSync(abs)) found.add(abs);
      continue;
    }
    globs.push(pattern);
  }
  if (globs.length === 0) return [...found];

  const stack: { dir: string; level: number }[] = [{ dir: cwd, level: 0 }];
  let seen = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > cap) return [...found];
      const full = join(current.dir, entry.name);
      const rel = toPosix(full.slice(cwd.length + 1));
      if (entry.isDirectory()) {
        if (current.level < depth && !SKIP_DIRS.has(entry.name)) {
          stack.push({ dir: full, level: current.level + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (globs.some((p) => matchPath(p, rel, full))) found.add(full);
    }
  }
  return [...found];
}

/* -------------------------------------------------------------------- config */

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((v): v is string => typeof v === "string");
}

/** Validate raw config; invalid security-relevant fields fall back to safe defaults. */
export function normalizeConfig(raw: unknown): SecretMaskConfig {
  const cfg = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const shell = (cfg.bash && typeof cfg.bash === "object" ? cfg.bash : {}) as Record<string, unknown>;
  const envPrefix = typeof shell.envPrefix === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(shell.envPrefix)
    ? shell.envPrefix
    : DEFAULT_CONFIG.bash.envPrefix;

  const files: FileRule[] = [];
  if (Array.isArray(cfg.files)) {
    for (const entry of cfg.files) {
      if (!entry || typeof entry !== "object") continue;
      const rule = entry as Record<string, unknown>;
      const match = asStringArray(rule.match, []);
      const action = rule.action === "allow" || rule.action === "redact" || rule.action === "deny" ? rule.action : undefined;
      if (match.length === 0 || !action) continue;
      const formats = asStringArray(rule.formats, []).filter((f): f is Format =>
        ["env", "json", "yaml", "toml", "ini", "kv"].includes(f),
      );
      const keys = (rule.keys && typeof rule.keys === "object" ? rule.keys : {}) as Record<string, unknown>;
      files.push({
        match,
        action,
        ...(formats.length > 0 ? { formats } : {}),
        ...(Object.keys(keys).length > 0
          ? { keys: { allow: asStringArray(keys.allow, []), deny: asStringArray(keys.deny, []) } }
          : {}),
      });
    }
  }

  const patterns = (cfg.patterns && typeof cfg.patterns === "object" ? cfg.patterns : {}) as Record<string, unknown>;
  const customPatterns: { name: string; pattern: string; flags?: string }[] = [];
  if (Array.isArray(cfg.customPatterns)) {
    for (const entry of cfg.customPatterns) {
      if (!entry || typeof entry !== "object") continue;
      const c = entry as Record<string, unknown>;
      if (typeof c.name !== "string" || typeof c.pattern !== "string") continue;
      customPatterns.push({
        name: c.name,
        pattern: c.pattern,
        ...(typeof c.flags === "string" ? { flags: c.flags } : {}),
      });
    }
  }

  const num = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

  return {
    bash: { envPrefix },
    files,
    safeKeys: cfg.safeKeys === undefined ? DEFAULT_SAFE_KEYS : asStringArray(cfg.safeKeys, DEFAULT_SAFE_KEYS),
    sensitiveKeys:
      cfg.sensitiveKeys === undefined ? DEFAULT_SENSITIVE_KEYS : asStringArray(cfg.sensitiveKeys, DEFAULT_SENSITIVE_KEYS),
    patterns: {
      openai: asBoolean(patterns.openai, true),
      github: asBoolean(patterns.github, true),
      google: asBoolean(patterns.google, true),
      aws: asBoolean(patterns.aws, true),
      jwt: asBoolean(patterns.jwt, true),
      pem: asBoolean(patterns.pem, true),
      base64: asBoolean(patterns.base64, false),
    },
    customPatterns,
    minSecretLength: num(cfg.minSecretLength, DEFAULT_CONFIG.minSecretLength),
    maskValuesEverywhere: asBoolean(cfg.maskValuesEverywhere, true),
    scanDepth: num(cfg.scanDepth, DEFAULT_CONFIG.scanDepth),
    maxFileBytes: num(cfg.maxFileBytes, DEFAULT_CONFIG.maxFileBytes),
    base64MinLength: num(cfg.base64MinLength, DEFAULT_CONFIG.base64MinLength),
  };
}

export function loadConfig(configPath: string): SecretMaskConfig {
  try {
    if (existsSync(configPath)) {
      return normalizeConfig(JSON.parse(readFileSync(configPath, "utf-8")));
    }
  } catch {
    // Corrupt config -> defaults.
  }
  return normalizeConfig({});
}

/**
 * Format detection for text with no path attached (tool output, pasted content). Line based
 * `key=value` wins, because that is what an env file dumped through `cat` looks like.
 */
export function detectFormatFromText(text: string): Format {
  const head = text.trimStart();
  if (head.startsWith("{") || head.startsWith("[")) return "json";
  if (/^[ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_.-]*[ \t]*=/m.test(text)) return "env";
  if (/^[ \t]*[A-Za-z_][A-Za-z0-9_.-]*[ \t]*:/m.test(text)) return "yaml";
  return "kv";
}
