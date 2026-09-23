/**
 * secret-mask engine: token registry, value masking, secret shapes, bash rewriting.
 *
 * Token form: `__SECRET_<NAME>__`. Every token is value-backed, so content read from a
 * file (redacted view) can be written back and round-trips to the real value.
 */
import type { PatternToggles } from "./policy.ts";

export const TOKEN_EXACT = /^__SECRET_[A-Za-z0-9_]+__$/;
export const TOKEN_GLOBAL = /__SECRET_[A-Za-z0-9_]+__/g;
const NAME_UNSAFE = /[^A-Za-z0-9_]/g;

export function sanitizeName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/^__SECRET_/, "")
    .replace(/__$/, "")
    .replace(NAME_UNSAFE, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "SECRET";
}

const WORDLIKE = /^[A-Za-z_]+$/;

/**
 * A plain word is not a credential. Masking one globally replaces that word inside ordinary prose,
 * file names and tool names (a 4 letter value turned `request_<something>` into a token). Values
 * like this still get a token inside a redacted file view.
 */
export function isWordLike(value: string, minLetters = 12): boolean {
  return WORDLIKE.test(value) && value.length < minLetters;
}

export function tokenName(name: string): string {
  return `__SECRET_${sanitizeName(name)}__`;
}

export function envVarName(token: string, prefix: string): string {
  return `${prefix}${sanitizeName(token).toUpperCase()}`;
}

export function isTokenShaped(value: string): boolean {
  return TOKEN_EXACT.test(value);
}

export function findTokenShapes(text: string): string[] {
  return [...new Set(text.match(TOKEN_GLOBAL) ?? [])];
}

/* ------------------------------------------------------------------- shapes */

export interface SecretShape {
  name: string;
  re: RegExp;
}

export function activeShapes(toggles: PatternToggles, custom: { name: string; pattern: string; flags?: string }[], base64MinLength: number): SecretShape[] {
  const shapes: SecretShape[] = [];
  const add = (name: string, enabled: boolean, source: string) => {
    if (enabled) shapes.push({ name, re: new RegExp(source, "g") });
  };
  add("OPENAI", toggles.openai, "(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{20,}");
  add("GITHUB", toggles.github, "(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}");
  add("GOOGLE", toggles.google, "AIza[0-9A-Za-z_-]{35}");
  add("AWS", toggles.aws, "(?:AKIA|ASIA|AIDA)[0-9A-Z]{16}");
  add("JWT", toggles.jwt, "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}");
  add("PEM", toggles.pem, "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]+?-----END [A-Z ]*PRIVATE KEY-----");
  if (toggles.base64) shapes.push({ name: "BASE64", re: new RegExp(`[A-Za-z0-9+/]{${base64MinLength},}={0,2}`, "g") });
  for (const cp of custom) {
    try {
      const flags = (cp.flags ?? "").includes("g") ? cp.flags! : `${cp.flags ?? ""}g`;
      shapes.push({ name: cp.name, re: new RegExp(cp.pattern, flags) });
    } catch {
      // Invalid custom pattern: ignore.
    }
  }
  return shapes;
}

/** Does this value look like a secret regardless of its key name? */
export function makeShapeTester(shapes: SecretShape[]): (value: string) => boolean {
  return (value: string) => {
    for (const shape of shapes) {
      shape.re.lastIndex = 0;
      if (shape.re.test(value)) return true;
    }
    return false;
  };
}

/** Register pattern hits found in free text; returns newly added tokens. */
export function registerShapeHits(text: string, shapes: SecretShape[], registry: SecretRegistry, source: string): string[] {
  const added: string[] = [];
  for (const shape of shapes) {
    shape.re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = shape.re.exec(text)) !== null) {
      const value = match[1] ?? match[0];
      if (match[0].length === 0) shape.re.lastIndex++;
      if (!value) continue;
      const token = registry.add(value, shape.name, `${source}:${shape.name}`);
      if (token && !added.includes(token)) added.push(token);
    }
  }
  return added;
}

/* ----------------------------------------------------------------- registry */

interface Entry {
  name: string;
  value: string;
  token: string;
  sources: Set<string>;
  /**
   * Maskable values are replaced by their token anywhere in outgoing text.
   * Non-maskable values only exist so the redacted view round-trips on write
   * (short file values would otherwise mangle ordinary text).
   */
  maskable: boolean;
  /**
   * Boundary-aware entries are only replaced when the match is not part of a longer identifier.
   * A tokenizing pass must never rewrite `request_mask` or `position` when the registered value is
   * the ordinary word inside them; the explicit sources stay naive, since that is what was asked for.
   */
  boundary: boolean;
  /** Any source that registered this value deliberately (manual, request, config, store read). */
  explicit: boolean;
  /** Any caller asked for global masking; the word/min-length guards still apply. */
  wanted: boolean;
}

export class SecretRegistry {
  private byValue = new Map<string, Entry>();
  private byToken = new Map<string, Entry>();
  private sortedValues: string[] = [];
  private maskRe: RegExp | null = null;
  private boundaryRe: RegExp | null = null;
  private unmaskRe: RegExp | null = null;
  private unmaskTokens: string[] = [];
  private readonly minLength: number;
  private readonly maxEntries: number;

  constructor(minLength: number = 4, maxEntries: number = 20000) {
    this.minLength = minLength;
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.byValue.size;
  }

  /** Explicit sources ask for masking wherever the value appears; automatic ones get the guards. */
  private static isExplicitSource(source: string): boolean {
    return /^(manual|request|extra|gopass)/.test(source);
  }

  /** Effective policy for a value given what every source has asked for so far. */
  private policyFor(raw: string, explicit: boolean, wanted: boolean): { maskable: boolean; boundary: boolean } {
    return {
      maskable: wanted && raw.length >= this.minLength && (explicit || !isWordLike(raw)),
      boundary: !explicit && /^[A-Za-z_]+$/.test(raw) && raw.length < 24,
    };
  }

  /**
   * Register a value under a name. Returns the token, or undefined when rejected.
   * Values shorter than `minLength` are kept as unmask-only entries instead of being
   * rejected, so a redacted file still round-trips when written back.
   */
  add(value: string, name: string, source: string, maskable = true): string | undefined {
    const raw = value;
    if (!raw) return undefined;
    if (isTokenShaped(raw)) return undefined;
    const explicit = SecretRegistry.isExplicitSource(source);

    const existing = this.byValue.get(raw);
    if (existing) {
      existing.sources.add(source);
      // Recompute: a value that was automatically harvested as a word, and later registered
      // explicitly, must leave its boundary guard behind (and vice versa, never the other way).
      const nextExplicit = existing.explicit || explicit;
      const nextWanted = existing.wanted || maskable;
      const next = this.policyFor(raw, nextExplicit, nextWanted);
      if (
        nextExplicit !== existing.explicit ||
        nextWanted !== existing.wanted ||
        next.maskable !== existing.maskable ||
        next.boundary !== existing.boundary
      ) {
        existing.explicit = nextExplicit;
        existing.wanted = nextWanted;
        existing.maskable = next.maskable;
        existing.boundary = next.boundary;
        this.invalidate();
      }
      return existing.token;
    }

    // Safety valve: a pathological session cannot grow without bound. Past the cap, entries keep
    // being masked (no silent leak) but get generic token names instead of key-derived ones.
    const overflow = this.byValue.size >= this.maxEntries;
    let token = tokenName(overflow ? `VALUE_${this.byValue.size + 1}` : name);
    if (this.byToken.has(token) && this.byToken.get(token)!.value !== raw) {
      // sanitizeName truncates at 64 characters, so long names collide. Keep probing: every
      // suffix is a distinct token, and the loop ends as soon as one is free. Falling back to
      // an occupied token would silently rebind the value already using it.
      const base = name.slice(0, 40);
      let n = 2;
      do {
        token = tokenName(`${base}_${n}`);
        n += 1;
      } while (this.byToken.has(token));
    }
    const policy = this.policyFor(raw, explicit, maskable);
    const entry: Entry = {
      name,
      value: raw,
      token,
      sources: new Set([source]),
      maskable: policy.maskable,
      boundary: policy.boundary,
      explicit,
      wanted: maskable,
    };
    this.byValue.set(raw, entry);
    this.byToken.set(token, entry);
    this.invalidate();
    return token;
  }

  /** Drop every entry: session-scoped, so a new session never inherits another one's tokens. */
  reset(): void {
    this.byValue.clear();
    this.byToken.clear();
    this.invalidate();
  }

  dropSource(source: string): number {    let removed = 0;
    for (const [value, entry] of [...this.byValue]) {
      if (!entry.sources.has(source)) continue;
      entry.sources.delete(source);
      if (entry.sources.size === 0) {
        this.byValue.delete(value);
        this.byToken.delete(entry.token);
        removed++;
      }
    }
    if (removed > 0) this.invalidate();
    return removed;
  }

  private invalidate(): void {
    this.sortedValues = [...this.byValue.values()]
      .filter((entry) => entry.maskable)
      .map((entry) => entry.value)
      .sort((a, b) => b.length - a.length);
    this.maskRe = null;
    this.boundaryRe = null;
    this.unmaskRe = null;
    this.unmaskTokens = [];
  }

  tokens(): string[] {
    return [...this.byToken.keys()];
  }

  names(): string[] {
    return [...this.byToken.values()].map((e) => e.name);
  }

  valueFor(token: string): string | undefined {
    return this.byToken.get(token)?.value;
  }

  has(token: string): boolean {
    return this.byToken.has(token);
  }

  /**
   * Session-lifetime sticky source: a value that already appeared in text we handled must
   * stay maskable even after its file source rotates away, otherwise a later echo of the
   * old value would reach the provider unmasked.
   */
  markSeen(text: string): void {
    for (const entry of this.byValue.values()) {
      if (text.includes(entry.value)) entry.sources.add("seen");
    }
  }

  /** Where this token's value came from (file path, pattern hit, manual registration, seen). */
  sourcesFor(token: string): string[] {
    const entry = this.byToken.get(token);
    return entry ? [...entry.sources].sort() : [];
  }

  /** Tokens present in `text` that the registry knows about, longest first. */
  knownTokens(text: string): string[] {
    const found = findTokenShapes(text).filter((t) => this.byToken.has(t));
    return found.sort((a, b) => b.length - a.length);
  }

  /** Token-shaped strings in `text` with no live mapping. */
  unknownTokens(text: string): string[] {
    return findTokenShapes(text).filter((t) => !this.byToken.has(t));
  }

  /** Real values -> tokens, single pass, longest match first. */
  maskText(text: string): string {
    if (this.sortedValues.length === 0 || text.length === 0) return text;
    if (this.maskRe === null && !this.boundaryRe) {
      const naive = this.sortedValues.filter((value) => !this.byValue.get(value)!.boundary);
      const bounded = this.sortedValues.filter((value) => this.byValue.get(value)!.boundary);
      this.maskRe = naive.length > 0 ? new RegExp(naive.map(escapeRegExp).join("|"), "g") : null;
      this.boundaryRe = bounded.length > 0 ? new RegExp(bounded.map(escapeRegExp).join("|"), "g") : null;
      if (this.maskRe === null && this.boundaryRe === null) return text;
    }
    let out = this.maskRe ? text.replace(this.maskRe, (match) => this.byValue.get(match)?.token ?? match) : text;
    if (this.boundaryRe) {
      out = out.replace(this.boundaryRe, (match, offset: number) => {
        const before = out[offset - 1] ?? "";
        const after = out[offset + match.length] ?? "";
        // Underscore counts as an identifier character: inside `request_mask` the word is not a value.
        if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after)) return match;
        return this.byValue.get(match)?.token ?? match;
      });
    }
    return out;
  }

  /** Tokens -> real values, whole-token matches only. */
  unmaskText(text: string): string {
    if (this.byToken.size === 0 || text.length === 0) return text;
    if (this.unmaskRe === null) {
      this.unmaskTokens = [...this.byToken.keys()].sort((a, b) => b.length - a.length);
      this.unmaskRe = new RegExp(this.unmaskTokens.map(escapeRegExp).join("|"), "g");
    }
    return text.replace(this.unmaskRe, (match) => this.byToken.get(match)?.value ?? match);
  }
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------ deep traversal */

function isBinaryNode(value: Record<string, unknown>): boolean {
  const type = value.type;
  if (type === "image" || type === "input_image" || type === "image_url") return true;
  if (value.source && typeof value.source === "object") return true;
  if (value.inlineData && typeof value.inlineData === "object") return true;
  return false;
}

const URL_FIELDS = ["url", "image_url", "imageUrl"];

/** Apply `fn` to every string field of an object/array tree; skips binary/image data. */
export function walkStrings(node: unknown, fn: (text: string) => string, skipKeys: string[] = []): boolean {
  let changed = false;

  /**
   * Image nodes are skipped as binary, but a URL next to the image data is model-facing text:
   * mask it, while `data:` payloads and `source.data`/`inlineData` stay untouched.
   */
  const visitUrlFields = (value: Record<string, unknown>): void => {
    const apply = (holder: Record<string, unknown>, key: string): void => {
      const item = holder[key];
      if (typeof item !== "string" || item.startsWith("data:")) return;
      const next = fn(item);
      if (next !== item) {
        holder[key] = next;
        changed = true;
      }
    };
    for (const key of URL_FIELDS) {
      const item = value[key];
      if (item && typeof item === "object") {
        for (const inner of URL_FIELDS) apply(item as Record<string, unknown>, inner);
      } else {
        apply(value, key);
      }
    }
    const source = value.source;
    if (source && typeof source === "object" && (source as Record<string, unknown>).type === "url") {
      apply(source as Record<string, unknown>, "url");
    }
  };

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (typeof item === "string") {
          const next = fn(item);
          if (next !== item) {
            value[i] = next;
            changed = true;
          }
        } else if (item && typeof item === "object") {
          visit(item);
        }
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    if (isBinaryNode(value as Record<string, unknown>)) {
      visitUrlFields(value as Record<string, unknown>);
      return;
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const item = (value as Record<string, unknown>)[key];
      if (skipKeys.includes(key)) continue;
      if (typeof item === "string") {
        const next = fn(item);
        if (next !== item) {
          (value as Record<string, unknown>)[key] = next;
          changed = true;
        }
      } else if (item && typeof item === "object") {
        visit(item);
      }
    }
  };
  visit(node);
  return changed;
}

/* ---------------------------------------------------------------- bash rewrite */

export interface BashRewrite {
  command: string;
  env: { name: string; value: string; token: string }[];
  unknown: string[];
  known: string[];
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Replace tokens with `${ENV_VAR}` references and inject an `export` prologue so the
 * real values travel in the child environment, never in argv.
 */
/**
 * Replace a token with an expansion that survives every quoting context.
 *
 * Single quotes: close, expand in double quotes, reopen. Double quotes and unquoted text expand as
 * `"${VAR}"`, so a value with spaces or glob characters cannot split or glob the command.
 */
function substituteToken(command: string, token: string, name: string): string {
  let out = "";
  let index = 0;
  let quote: "'" | '"' | null = null;
  while (index < command.length) {
    const char = command[index];
    if (char === "\\" && quote !== "'") {
      out += command.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (quote === "'") {
      if (char === "'") {
        quote = null;
        out += char;
        index += 1;
        continue;
      }
      if (command.startsWith(token, index)) {
        out += `'"\${${name}}"'`;
        index += token.length;
        continue;
      }
      out += char;
      index += 1;
      continue;
    }
    if (char === "'") {
      quote = "'";
      out += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      quote = quote === '"' ? null : '"';
      out += char;
      index += 1;
      continue;
    }
    if (command.startsWith(token, index)) {
      out += `"\${${name}}"`;
      index += token.length;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

export function rewriteBashCommand(command: string, registry: SecretRegistry, envPrefix: string): BashRewrite {
  const known = registry.knownTokens(command);
  const unknown = registry.unknownTokens(command);
  if (known.length === 0) return { command, env: [], unknown, known };

  const env: { name: string; value: string; token: string }[] = [];
  const used = new Set<string>();
  let out = command;
  for (const token of known) {
    const value = registry.valueFor(token);
    if (value === undefined) continue;
    // Tokens that differ only in case collapse onto one env name after uppercasing.
    const base = envVarName(token, envPrefix);
    let name = base;
    let suffix = 2;
    while (used.has(name)) {
      name = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(name);
    env.push({ name, value, token });
    out = substituteToken(out, token, name);
  }
  if (env.length === 0) return { command, env: [], unknown, known };
  const prologue = env.map((e) => `${e.name}=${shellQuote(e.value)}`).join(" ");
  return { command: `export ${prologue}; ${out}`, env, unknown, known };
}
