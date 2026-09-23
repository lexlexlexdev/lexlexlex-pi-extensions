/**
 * secret-mask — keep project secrets out of provider requests.
 *
 * Loop:
 *   input               user prompt masked at the source
 *   before_provider_request   final belt: known values -> tokens in the whole payload
 *   tool_call (bash)    registered token -> ${PI_SECRET_X}; real value travels in the child env
 *   tool_call (write/edit)  a registered token refuses the call; files never receive real values
 *   tool_result (read/grep) redacted view for paths covered by a `redact` rule
 *   tool_result (other) known values masked back out of tool output
 *   session_before_compact / _tree   summaries masked too
 *
 * Policy lives in config.json next to this file. No secret is ever written to disk by
 * this extension: the registry is in-memory and rebuilt from source files.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SecretRegistry,
  activeShapes,
  findTokenShapes,
  makeShapeTester,
  registerShapeHits,
  envVarName,
  rewriteBashCommand,
  walkStrings,
} from "./src/engine.ts";
import {
  classifyKey,
  detectFormat,
  isMaskableValue,
  isSensitiveKeyName,
  loadConfig,
  matchPath,
  parseKV,
  parsePairsEverywhere,
  redactLines,
  redactSpans,
  resolveAction,
  sweepSensitiveSpans,
  toPosix,
  type Action,
  type FileRule,
  type Format,
  type SecretMaskConfig,
} from "./src/policy.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = process.env.SECRET_MASK_CONFIG ?? join(HERE, "config.json");

const REQUEST_TOOL = "request_secret";

const GUIDANCE = `<__SECRET_ENV_MASK>
Tool results are redacted views, not disk truth.
- A token shown as __SECRET_<NAME>__ is a masked alias for a real value. If a file read shows one, the
  file on disk holds the real value: do not "fix" the file, do not retype the token.
- Use tokens in bash commands. Bash exports the real value to an environment variable and rewrites
  the token to \${PI_SECRET_NAME}.
- write and edit never receive real values: a write or edit containing a token is refused. To place a
  value in a file, run a bash command that expands the exported variable, or ask the user to edit it.
- Never echo, print, log, base64, or otherwise expose a real value, and never invent a token name.
  If a value you need is not registered, call \${REQUEST_TOOL} instead of guessing.
- If a write is refused because of a token, do not retry with a hand-written value: use bash or ask.
</__SECRET_ENV_MASK>`;

/* ---------------------------------------------------------------------- state */

interface State {
  cwd: string;
  /** Masking can be switched off for the session; the registry is kept so it can be switched back on. */
  enabled: boolean;
  /** Last context seen, so background hooks can update the footer status. */
  ctx?: ExtensionContext;
  statusTimer?: ReturnType<typeof setTimeout>;
  /** Files the model actually touched: /secret-reload re-reads exactly these. */
  readFiles: Set<string>;
}

const state: State = {
  cwd: process.cwd(),
  enabled: true,
  ctx: undefined,
  statusTimer: undefined,
  readFiles: new Set(),
};

export default function secretMask(pi: ExtensionAPI): void {
  const config: SecretMaskConfig = loadConfig(CONFIG_FILE);
  const registry = new SecretRegistry(config.minSecretLength);
  const shapes = activeShapes(config.patterns, config.customPatterns, config.base64MinLength);
  const shapeTester = makeShapeTester(shapes);

  /* ------------------------------------------------------------------ helpers */

  /**
   * Policy for a path: the literal path and its symlink target are both resolved, and the
   * strictest verdict wins — a rule must not be bypassable through a link or a relative hop.
   */
  function actionFor(path: string): { action: Action; rule: FileRule | undefined } {
    const abs = resolvePath(state.cwd, path);
    const candidates = [abs];
    try {
      const real = realpathSync(abs);
      if (real !== abs) candidates.push(real);
    } catch {
      // Missing path (new write target) or unreadable link: literal path only.
    }
    const rank: Record<Action, number> = { allow: 0, redact: 1, deny: 2 };
    let best: { action: Action; rule: FileRule | undefined } = { action: "allow", rule: undefined };
    for (const candidate of candidates) {
      const rel = candidate.startsWith(state.cwd + sep)
        ? toPosix(candidate.slice(state.cwd.length + 1))
        : toPosix(candidate);
      const resolved = resolveAction(rel, candidate, config.files);
      if (rank[resolved.action] > rank[best.action]) best = resolved;
    }
    return best;
  }

  function formatFor(path: string, rule?: FileRule): Format {
    return rule?.formats?.[0] ?? detectFormat(path);
  }

  function maskValues(text: string): string {
    return registry.maskText(text);
  }

  /** Register shape hits found in free text before masking it. */
  function scanAndMask(text: string, source: string): string {
    registerShapeHits(text, shapes, registry, source);
    const masked = registry.maskText(text);
    if (masked !== text) registry.markSeen(text);
    return masked;
  }

  /** Decide the token for a value inside a redact-listed file. */
  function decideValue(key: string, value: string, rule: FileRule | undefined, source: string): string | null {
    const shaped = shapeTester(value);
    const verdict = classifyKey(key, value, {
      sensitiveKeys: config.sensitiveKeys,
      safeKeys: config.safeKeys,
      rule,
      shaped: () => shaped,
    });
    if (verdict === "visible") return null;
    const maskable = isMaskableValue(value, config, {
      shaped,
      sensitiveKey: isSensitiveKeyName(key, rule, config.sensitiveKeys),
    });
    // Unmaskable values (benign words, very short strings, bare numbers) still get a token in the
    // view, because the transcript is the thing we are protecting here. They are simply not masked
    // globally: masking the word "local" everywhere would corrupt unrelated text. Documented in
    // README under Limitations.
    return registry.add(value, key, source, maskable) ?? null;
  }

  /** Redacted view of a file covered by a `redact` rule. */
  function redactDocument(path: string, content: string): { text: string; keys: string[] } {
    const { action, rule } = actionFor(path);
    if (action !== "redact") {
      return { text: config.maskValuesEverywhere ? maskValues(content) : content, keys: [] };
    }
    const source = `file:${resolvePath(state.cwd, path)}`;
    const spans = parseKV(formatFor(path, rule), content);
    const result = redactSpans(content, spans, (key, value) => decideValue(key, value, rule, source));
    const swept = sweepRedactView(result.text, rule, source);
    const text = scanAndMask(swept, "scan");
    return { text, keys: result.redacted.map((r) => r.key) };
  }

  /**
   * Second pass over a redacted view: whatever syntax the format parser did not understand,
   * a sensitive key found anywhere in the text still tokenizes its value.
   */
  function sweepRedactView(text: string, rule: FileRule | undefined, source: string): string {
    const sensitive = (key: string) => isSensitiveKeyName(key, rule, config.sensitiveKeys);
    const spans = sweepSensitiveSpans(text, sensitive);
    return redactSpans(text, spans, (key, value) => decideValue(key, value, rule, source)).text;
  }

  /** Re-read every file a `redact`/`deny` rule points at and (re)harvest its values. */
  function collectStrings(node: unknown, skipKeys: string[], out: string[] = []): string[] {
    if (typeof node === "string") {
      out.push(node);
      return out;
    }
    if (Array.isArray(node)) {
      for (const item of node) collectStrings(item, skipKeys, out);
      return out;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (skipKeys.includes(key)) continue;
        collectStrings(value, skipKeys, out);
      }
    }
    return out;
  }

  /** Paths named in a shell command that resolve to a rule. */
  function pathCandidates(command: string): string[] {
    const out: string[] = [];
    for (const raw of command.match(/'[^']*'|"[^"]*"|[^\s|;&()<>]+/g) ?? []) {
      const token = raw.replace(/^['"]|['"]$/g, "");
      if (!token || token.startsWith("-") || token.startsWith("$")) continue;
      const abs = resolvePath(state.cwd, token);
      const rel = toPosix(abs.startsWith(state.cwd + sep) ? abs.slice(state.cwd.length + 1) : abs);
      const resolved = resolveAction(rel, abs, config.files);
      if (resolved.action !== "allow") out.push(token);
    }
    return out;
  }

  /**
   * Grep results carry one match per line as `path:line:content`. Each line is judged against
   * the policy of its own file: `deny` files are replaced by a marker, `redact` files are
   * key-filtered, everything else is left alone (values are masked on the way out).
   */
  function redactGrepText(text: string): string {
    const out: string[] = [];
    for (const line of text.split("\n")) {
      const match = /^(.*?):(\d+):(.*)$/.exec(line);
      if (!match) {
        out.push(line);
        continue;
      }
      const [, matchedPath, lineNumber, body] = match;
      const { action, rule } = actionFor(matchedPath);
      if (action === "deny") {
        out.push(`${matchedPath}:${lineNumber}:[blocked by secret-mask: deny rule]`);
        continue;
      }
      if (action === "redact") {
        const source = `file:${resolvePath(state.cwd, matchedPath)}`;
        const redacted = redactLines(body, formatFor(matchedPath, rule), (key, value) =>
          decideValue(key, value, rule, source),
        ).text;
        out.push(`${matchedPath}:${lineNumber}:${redacted}`);
        continue;
      }
      out.push(line);
    }
    return scanAndMask(out.join("\n"), "tool");
  }

  function maskContent(target: { content?: unknown }, transform: (text: string) => string): void {
    const content = target.content;
    if (typeof content === "string") {
      target.content = transform(content);
      return;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as { text?: unknown };
        if (typeof b.text === "string") b.text = transform(b.text);
      }
    }
  }

  const BLIND_MARKER = "[blocked: masking failed]";

  /**
   * Terminal fallback for a payload that could not be masked: rebuild the structure with every
   * string replaced by a marker. Iterative (no depth cap), cycle-safe and tolerant of throwing
   * getters, so it always terminates and the result cannot carry an original string.
   */
  function blindPayload(root: unknown): unknown {
    const isContainer = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null;
    const shellOf = (source: object): Record<string, unknown> | unknown[] => (Array.isArray(source) ? [] : {});
    const blindString = (value: string): string => (value.trim() === "" ? value : BLIND_MARKER);
    if (!isContainer(root)) return typeof root === "string" ? blindString(root) : root;
    const seen = new WeakSet<object>();
    const out = shellOf(root);
    seen.add(root);
    const stack: { src: unknown; dst: Record<string, unknown> | unknown[] }[] = [{ src: root, dst: out }];
    while (stack.length > 0) {
      const { src, dst } = stack.pop()!;
      const keys: (string | number)[] = Array.isArray(src)
        ? src.map((_item, index) => index)
        : Object.keys(src as Record<string, unknown>);
      for (const key of keys) {
        let item: unknown;
        try {
          item = Array.isArray(src) ? src[key as number] : (src as Record<string, unknown>)[key as string];
        } catch {
          item = BLIND_MARKER;
        }
        if (typeof item === "string") {
          (dst as Record<string, unknown>)[key as string] = blindString(item);
        } else if (isContainer(item)) {
          if (seen.has(item)) {
            (dst as Record<string, unknown>)[key as string] = BLIND_MARKER;
          } else {
            seen.add(item);
            const child = shellOf(item);
            (dst as Record<string, unknown>)[key as string] = child;
            stack.push({ src: item, dst: child });
          }
        } else {
          (dst as Record<string, unknown>)[key as string] = item;
        }
      }
    }
    return out;
  }

  function maskPayload(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const data = payload as Record<string, any>;
    const fn = (text: string) => scanAndMask(text, "provider");
    if (typeof data.system === "string") data.system = fn(data.system);
    else if (Array.isArray(data.system)) walkStrings(data.system, fn);
    if (typeof data.instructions === "string") data.instructions = fn(data.instructions);
    else if (Array.isArray(data.instructions)) walkStrings(data.instructions, fn);
    const systemInstruction = data.config?.systemInstruction;
    if (typeof systemInstruction === "string") data.config.systemInstruction = fn(systemInstruction);
    else if (systemInstruction && typeof systemInstruction === "object") walkStrings(systemInstruction, fn);

    const skip = ["role", "type", "tool_call_id", "toolCallId"];
    for (const key of ["messages", "input", "contents"]) {
      const list = data[key];
      if (Array.isArray(list)) walkStrings(list, fn, skip);
    }
    if (Array.isArray(data.tools)) {
      for (const tool of data.tools) {
        if (!tool || typeof tool !== "object") continue;
        if (typeof tool.description === "string") tool.description = fn(tool.description);
        for (const holder of [tool, tool.function]) {
          if (!holder || typeof holder !== "object") continue;
          if (typeof holder.description === "string") holder.description = fn(holder.description);
          // Tool schemas are model-facing text: defaults, descriptions and examples carry values.
          for (const key of ["parameters", "input_schema", "inputSchema", "functionDeclarations"]) {
            if (holder[key] && typeof holder[key] === "object") walkStrings(holder[key], fn);
          }
        }
      }
    }
  }

  function maskPreparation(prep: any): void {
    if (!prep || typeof prep !== "object") return;
    const fn = (text: string) => scanAndMask(text, "summary");
    for (const key of ["messagesToSummarize", "turnPrefixMessages", "entriesToSummarize"]) {
      const list = prep[key];
      if (Array.isArray(list)) walkStrings(list, fn, ["role", "type", "id", "toolCallId"]);
    }
    if (typeof prep.previousSummary === "string") prep.previousSummary = fn(prep.previousSummary);
  }

  /** Credential-shaped pairs found in text with no file context: sensitive key or a known shape. */
  function onSightToken(key: string, value: string): string | null {
    if (!value) return null;
    if (isSensitiveKeyName(key, undefined, config.safeKeys)) return null;
    const shaped = shapeTester(value);
    const sensitive = isSensitiveKeyName(key, undefined, config.sensitiveKeys);
    if (!shaped && !sensitive) return null;
    // Known and masked on the way out anyway: no second source for the same value.
    if (registry.maskText(value) !== value) return null;
    // Only credentials are rewritten on sight. A bare word under a sensitive key stays readable,
    // otherwise ordinary prose gets tokenized again.
    if (!isMaskableValue(value, config, { shaped, sensitiveKey: sensitive, onSight: true })) return null;
    return registry.add(value, key, `sight:${key}`, true) ?? null;
  }

  /** Shapes, then key/value pairs found in the text itself, then every value already known. */
  function maskTextEverywhere(text: string, source: string): string {
    registerShapeHits(text, shapes, registry, source);
    const { text: withPairs } = redactSpans(text, parsePairsEverywhere(text), onSightToken);
    const masked = registry.maskText(withPairs);
    if (masked !== withPairs) registry.markSeen(withPairs);
    return masked;
  }

  /** Re-read one redact-listed file from disk, dropping its previous values first. */
  function harvestTrackedFile(pathOrAbs: string): void {
    const abs = resolvePath(state.cwd, pathOrAbs);
    const rel = toPosix(abs.startsWith(state.cwd + sep) ? abs.slice(state.cwd.length + 1) : abs);
    const { action, rule } = actionFor(abs);
    if (action !== "redact") return;
    const source = `file:${abs}`;
    // Drop first: a file that is gone or unreadable must not keep its old values registered.
    registry.dropSource(source);
    let content: string;
    try {
      if (statSync(abs).size > config.maxFileBytes) return;
      content = readFileSync(abs, "utf-8");
    } catch {
      return;
    }
    redactSpans(content, parseKV(formatFor(rel, rule), content), (key, value) =>
      decideValue(key, value, rule, source),
    );
  }

  const STATUS_REVERT_MS = 6000;

  function updateStatus(ctx?: ExtensionContext, fresh = false): void {
    state.ctx = ctx ?? state.ctx;
    if (state.statusTimer) {
      clearTimeout(state.statusTimer);
      state.statusTimer = undefined;
    }
    try {
      const ui = state.ctx?.ui;
      if (!state.enabled) {
        ui?.setStatus?.("secret-mask", "mask: false");
        return;
      }
      ui?.setStatus?.("secret-mask", fresh ? "mask: on, NEW SECRET ADDED" : "mask: on");
      if (fresh) {
        state.statusTimer = setTimeout(() => {
          state.statusTimer = undefined;
          updateStatus(undefined, false);
        }, STATUS_REVERT_MS);
        state.statusTimer.unref?.();
      }
    } catch {
      // Status is cosmetic.
    }
  }

  /**
   * A value tied to the project keeps its notice: business data is moving into a command and the
   * user should see that. A value that only exists because of tooling (harness output, provider
   * echoes, summarizer text, scratch files outside the workspace) stays quiet: that is machinery.
   */
  function isProjectToken(token: string): boolean {
    return registry.sourcesFor(token).some((source) => {
      if (source.startsWith("file:")) {
        const abs = source.slice("file:".length);
        return abs === state.cwd || abs.startsWith(state.cwd + sep);
      }
      if (source === "seen" || source === "provider" || source === "summary") return false;
      if (source.startsWith("tool:")) return false;
      return true;
    });
  }

  /** Footer feedback after a hook ran: flags a registration that just happened. */
  function noteActivity(before: number): void {
    updateStatus(undefined, registry.size > before);
  }

  /* ------------------------------------------------------------------- hooks */

  pi.on("session_start", (_event, ctx) => {
    // Session-scoped state: a toggle, registry or touched-file set must never leak between sessions.
    if (state.statusTimer) clearTimeout(state.statusTimer);
    state.statusTimer = undefined;
    state.enabled = true;
    state.ctx = ctx;
    state.readFiles.clear();
    registry.reset();
    state.cwd = ctx?.cwd ?? state.cwd;
    // No workspace scan: values become known when the model actually touches a file or prints one.
    updateStatus(ctx);
  });

  pi.on("input", (event) => {
    if (!state.enabled) return;
    if (!event.text || event.source === "extension") return;
    const before = registry.size;
    const original = event.text;
    const masked = maskTextEverywhere(original, "input");
    noteActivity(before);
    if (masked !== original) return { action: "transform", text: masked };
  });

  pi.on("before_provider_request", (event, ctx) => {
    try {
      state.cwd = ctx?.cwd ?? state.cwd;
      if (!state.enabled) return;
      const before = registry.size;
      maskPayload(event.payload);
      noteActivity(before);
      return event.payload;
    } catch (error) {
      // Fail-closed: abort first, then hand the host a rebuilt payload whose strings are all
      // markers. Returning undefined would tell the host to keep the original payload.
      try {
        ctx?.abort?.();
      } catch {
        // best effort
      }
      let blocked: unknown;
      try {
        blocked = blindPayload(event.payload);
      } catch {
        blocked = { messages: [] };
      }
      try {
        ctx?.ui?.notify?.(
          `secret-mask: masking failed (${error instanceof Error ? error.message : String(error)}); aborted the request instead of sending it unmasked`,
          "error",
        );
      } catch {
        // Aborting is best effort; the payload is dropped either way.
      }
      return blocked;
    }
  });

  pi.on("tool_call", (event, ctx) => {
    state.cwd = ctx?.cwd ?? state.cwd;
    if (!state.enabled) return;

    if (event.toolName === "bash") {
      const command = String((event.input as { command?: string }).command ?? "");
      for (const candidate of pathCandidates(command)) {
        if (actionFor(candidate).action === "deny") {
          return {
            block: true,
            reason: `Blocked by secret-mask: ${candidate} is a protected path (deny rule). Read it yourself and paste only what is needed, or register the value with /secret-add.`,
          };
        }
      }
      // Only registered tokens are rewritten. Unknown token-shaped strings are ordinary text
      // (other tools and prompts use the same shape), so they are never blocked.
      const rewritten = rewriteBashCommand(command, registry, config.bash.envPrefix);
      if (rewritten.env.length > 0) {
        (event.input as { command: string }).command = rewritten.command;
        const project = rewritten.env.filter((entry) => isProjectToken(entry.token));
        if (project.length > 0) {
          try {
            ctx?.ui?.notify?.(
              `secret-mask: injected ${project.map((entry) => entry.name).join(", ")} into the command environment`,
              "info",
            );
          } catch {
            // Notify is cosmetic.
          }
        }
      }
      return;
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const input = event.input as Record<string, unknown>;
      const path = typeof input.path === "string" ? input.path : undefined;
      if (path && actionFor(path).action === "deny") {
        return { block: true, reason: `Blocked by secret-mask: ${path} is a protected path (deny rule).` };
      }
      // A token in a write means the model is reconstructing a value it cannot see.
      // The extension never puts real values into files: values reach tools through bash only.
      const tokens = [
        ...new Set(collectStrings(event.input, ["path"]).flatMap((text) => findTokenShapes(text))),
      ].filter((token) => registry.has(token));
      if (tokens.length > 0) {
        return {
          block: true,
          reason: [
            `Blocked by secret-mask: this ${event.toolName} would write secret token(s) ${tokens.join(", ")} into ${path ?? "a file"}.`,
            "Tokens are references for bash, not file content: the extension never substitutes real values into files.",
            "Other __SECRET_*__ strings are not tokens and are left alone.",
            "To place a value in a file, run a bash command that uses the exported variable (for example: sh -c 'printf \"%s\\n\" \"DB_PASSWORD=$PI_SECRET_DB_PASSWORD\" >> .env.staging'), ask the user to edit the file, or write content that does not reference a token.",
          ].join(" "),
        };
      }
      return;
    }

    // read / grep / find / ls / custom tools carrying a path
    const input = event.input as Record<string, unknown>;
    const path = typeof input?.path === "string" ? input.path : undefined;
    if (path && actionFor(path).action === "deny") {
      return { block: true, reason: `Blocked by secret-mask: ${path} is a protected path (deny rule).` };
    }
  });

  /** Text of a tool result, for hooks that must read it before masking. */
  function contentText(target: { content?: unknown }): string {
    const content = target.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
        parts.push((block as { text: string }).text);
      }
    }
    return parts.join("\n");
  }

  /**
   * A password manager prints values this registry has never seen, and those would go straight to
   * the provider. Register what the command printed, named after the entry, so the rest of the loop
   * applies to them: token in the transcript, exported variable in bash, refused in files.
   */
  /** Commands that may sit next to a store read without producing the text we attribute to it. */
  const STORE_CONSUMERS = new Set([
    "cat", "head", "tail", "wc", "grep", "rg", "sed", "awk", "jq", "tr", "cut", "sort", "uniq",
    "xargs", "tee", "pbcopy", "base64", "xxd", "od", "less", "more", "column",
  ]);
  const STORE_NOISE = new Set(["", "cd", "pushd", "popd", "true", ":", "wait"]);

  function harvestPasswordStore(command: string, text: string): number {
    const segments = command
      .split(/&&|\|\||;|\||\n/)
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length === 0) return 0;

    const reads: string[][] = [];
    for (const segment of segments) {
      const words = segment.split(/\s+/).filter(Boolean);
      let i = 0;
      while (
        i < words.length &&
        (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) ||
          ["sudo", "env", "time", "command", "nohup", "exec"].includes(words[i]))
      ) {
        i += 1;
      }
      const head = (words[i] ?? "").split("/").pop() ?? "";
      if (head === "gopass") {
        reads.push(words.slice(i + 1).filter((word) => !word.startsWith("-")));
        continue;
      }
      // Anything else could have written these lines. Attributing them would mask unrelated text.
      if (!STORE_CONSUMERS.has(head) && !STORE_NOISE.has(head)) return 0;
    }
    if (reads.length === 0) return 0;

    const isDiagnostic = (line: string): boolean => /^(error|warning|usage|fatal|gopass:|enter |please )/i.test(line);
    const noisyKeys = new Set(["error", "warning", "usage", "fatal", "gopass"]);
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !isDiagnostic(line));
    if (lines.length === 0) return 0;

    let added = 0;
    for (const read of reads) {
      const sub = read[0];
      if (sub !== "show" && sub !== "cat") continue;
      const entry = read[1];
      if (!entry || entry.includes("=")) continue;
      const field = read[2];
      const base = `GOPASS_${entry.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
      const source = `gopass:${entry}`;
      const add = (name: string, value: string): void => {
        registry.add(
          value,
          name,
          source,
          isMaskableValue(value, config, {
            shaped: false,
            sensitiveKey: isSensitiveKeyName(name, undefined, config.sensitiveKeys),
          }),
        );
      };
      const pairs = lines
        .map((line) => ({ line, match: /^([^\s:]+):[ \t]+(.+)$/.exec(line) }))
        .filter((item) => item.match !== null && !noisyKeys.has(item.match[1].toLowerCase()));
      const entryName = base.replace(/^GOPASS_/, "");
      for (const item of pairs) {
        const match = item.match as RegExpExecArray;
        const key = match[1].toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
        if (!key) continue;
        // A pass-style entry repeats its own path as its ${PI_SECRET_E2E_STUDENT_PASSWORD} field. Use the entry name in that case.
        add(key === entryName ? base : `${base}_${key}`, match[2]);
        added += 1;
      }
      const leftovers = lines.filter(
        (line) => !pairs.some((item) => item.line === line) && !line.startsWith("#"),
      );
      const suffix = field ? `_${field.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}` : "";
      for (const [index, line] of leftovers.entries()) {
        add(leftovers.length === 1 ? `${base}${suffix}` : `${base}${suffix}_${index + 1}`, line);
        added += 1;
      }
    }
    return added;
  }

  pi.on("tool_result", (event) => {
    try {
      if (!event.content || !state.enabled) return;
      const input = (event.input ?? {}) as Record<string, unknown>;
      const path = typeof input.path === "string" ? input.path : undefined;

      if (event.toolName === "grep") {
        maskContent(event, redactGrepText);
        return;
      }

      if (path && event.toolName === "read") {
        const { action, rule } = actionFor(path);
        const source = `file:${resolvePath(state.cwd, path)}`;
        const format = formatFor(path, rule);
        if (action === "redact") {
          maskContent(event, (text) => {
            state.readFiles.add(resolvePath(state.cwd, path));
            registry.markSeen(text);
            const result = redactSpans(text, parseKV(format, text), (key, value) =>
              decideValue(key, value, rule, source),
            );
            return scanAndMask(sweepRedactView(result.text, rule, source), "scan");
          });
          return;
        }
        if (action === "deny") return;
      }

      if (event.toolName === "bash") {
        const command = typeof input.command === "string" ? input.command : "";
        if (command) harvestPasswordStore(command, contentText(event));
      }

      {
        const before = registry.size;
        maskContent(event, (text) => maskTextEverywhere(text, "tool"));
        // Tools echo inputs into details: that channel leaves the process as well.
        if (event.details && typeof event.details === "object") {
          walkStrings(event.details, (text) => maskTextEverywhere(text, "tool"));
        }
        noteActivity(before);
      }
    } catch {
      // Fail-closed for a single tool result: masking failed, so none of it may ship.
      const marker = "[blocked by secret-mask: masking failed]";
      try {
        event.content = [{ type: "text" as const, text: marker }];
        if (event.details && typeof event.details === "object") {
          try {
            walkStrings(event.details, () => marker);
          } catch {
            event.details = undefined;
          }
        }
      } catch {
        // Nothing more can be done; the provider hook still gates the request.
      }
    }
  });

  pi.on("session_before_compact", (event) => {
    if (!state.enabled) return;
    try {
      maskPreparation(event.preparation);
      if (typeof event.customInstructions === "string") {
        event.customInstructions = scanAndMask(event.customInstructions, "summary");
      }
    } catch {
      // Never abort compaction.
    }
  });

  pi.on("session_before_tree", (event) => {
    if (!state.enabled) return;
    try {
      maskPreparation(event.preparation);
      const instructions = event.preparation?.customInstructions;
      if (typeof instructions === "string") {
        const masked = scanAndMask(instructions, "summary");
        // Mask in place as well as in the override: pi only honors the returned value,
        // but the preparation object must not keep a raw copy either.
        event.preparation.customInstructions = masked;
        if (masked !== instructions) return { customInstructions: masked };
      }
    } catch {
      // Never abort tree navigation.
    }
  });

  /* -------------------------------------------------------------- model tools */

  pi.registerTool({
    name: REQUEST_TOOL,
    label: "Request Secret",
    description: `Ask the user for a secret (API key, token, password) and register it with secret-mask.
Use this only when the task genuinely needs a value that is not already available as a token; the
value the user types is never shown to you. You receive a \`__SECRET_NAME__\` token to use in bash
commands and write/edit content. Do not call it again for a name you already hold a token for.
${GUIDANCE}`,
    parameters: Type.Object({
      name: Type.String({ description: "Secret name, e.g. OPENAI_API_KEY, DB_PASSWORD" }),
      purpose: Type.Optional(Type.String({ description: "Why the secret is needed, shown to the user" })),
    }),
    execute: async (
      _id: string,
      params: { name: string; purpose?: string },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) => {
      const name = params.name?.trim() || "SECRET";
      const purpose = params.purpose?.trim();
      if (!ctx?.ui?.input) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No interactive UI in this mode, so the secret cannot be requested. Ask the user to register it with /secret-add NAME VALUE (or put it in a redact-listed file).",
            },
          ],
        };
      }
      const entered = await ctx.ui.input(
        purpose ? `Enter ${name} (purpose: ${purpose}; the model will not see it):` : `Enter ${name} (the model will not see it):`,
      );
      const value = (entered ?? "").trim();
      if (!value) {
        return { content: [{ type: "text" as const, text: `User cancelled input for ${name}.` }] };
      }
      const token = registry.add(value, name, "manual");
      if (!token) {
        return { content: [{ type: "text" as const, text: `The value for ${name} was rejected (too short or token-shaped).` }] };
      }
      updateStatus(ctx);
      return {
        content: [
          {
            type: "text" as const,
            text: `Registered ${name}. Use ${token} in bash commands and write/edit content; the extension substitutes the real value locally and masks tool output again.`,
          },
        ],
      };
    },
  });

  /* ---------------------------------------------------------------- commands */
  /* --------------------------------------------------------- panel overlay */
  // Key sequences are matched raw so the component needs nothing from the TUI package. A string[]
  // widget is capped at 10 lines by the host ("... (widget truncated)"), which is what made the
  // panel look collapsed; an overlay component renders as many lines as the terminal allows and
  // scrolls the rest.
  const KEYS = {
    close: ["\x1b", "q"],
    up: ["\x1b[A", "\x1bOA", "k"],
    down: ["\x1b[B", "\x1bOB", "j"],
    pageUp: ["\x1b[5~", "\x1b[5;2~"],
    pageDown: ["\x1b[6~", "\x1b[6;2~"],
    home: ["\x1b[H", "\x1bOH", "\x1b[1~", "g"],
    end: ["\x1b[F", "\x1bOF", "\x1b[4~", "G"],
  };

  function fit(line: string, width: number): string {
    if (width <= 1) return "";
    return line.length > width ? `${line.slice(0, width - 1)}…` : line;
  }

  interface OverlayHost {
    rows?: number;
    requestRender(): void;
  }

  function makePanelComponent(host: OverlayHost, title: string, body: string[], done: () => void) {
    let scroll = 0;
    let viewport = 10;
    const maxScroll = (): number => Math.max(0, body.length - viewport);
    return {
      invalidate(): void {},
      render(width: number): string[] {
        viewport = Math.max(3, Math.min((host.rows ?? 30) - 4, 30));
        scroll = Math.min(scroll, maxScroll());
        const slice = body.slice(scroll, scroll + viewport);
        const out = [fit(title, width), ...slice.map((line) => fit(line, width))];
        for (let index = slice.length; index < viewport; index += 1) out.push("");
        const from = body.length === 0 ? 0 : scroll + 1;
        const to = Math.min(body.length, scroll + viewport);
        out.push(fit(`${from}-${to} of ${body.length} · esc close · ↑↓ scroll · pgup/pgdn · home/end`, width));
        return out;
      },
      handleInput(data: string): void {
        if (KEYS.close.includes(data)) {
          done();
          return;
        }
        if (KEYS.up.includes(data)) scroll = Math.max(0, scroll - 1);
        else if (KEYS.down.includes(data)) scroll = Math.min(maxScroll(), scroll + 1);
        else if (KEYS.pageUp.includes(data)) scroll = Math.max(0, scroll - viewport);
        else if (KEYS.pageDown.includes(data)) scroll = Math.min(maxScroll(), scroll + viewport);
        else if (KEYS.home.includes(data)) scroll = 0;
        else if (KEYS.end.includes(data)) scroll = maxScroll();
        else return;
        host.requestRender();
      },
    };
  }

  async function showPanel(ctx: any, cwd: string): Promise<void> {
    const { lines, summary } = panelLines(cwd);
    const [title, ...body] = lines;
    if (typeof ctx.ui?.custom !== "function") {
      ctx.ui?.notify?.(summary, "info");
      return;
    }
    await ctx.ui.custom(
      (host: OverlayHost, _theme: unknown, _keybindings: unknown, done: () => void) =>
        makePanelComponent(host, title, body, done),
      { overlay: true, overlayOptions: { anchor: "center", width: 100, maxHeight: 34 } },
    );
  }

  function kindOf(source: string): string {
    if (source.startsWith("file:")) return "file";
    if (source.startsWith("gopass:")) return "gopass";
    if (source === "seen") return "seen";
    if (source === "manual") return "manual";
    if (source === "extra") return "config";
    return "pattern";
  }

  /** Kind, then where the value came from, then the values themselves. */
  function panelLines(cwd: string): { lines: string[]; summary: string } {
    const groups = new Map<string, Map<string, string[]>>();
    let multi = 0;
    for (const token of registry.tokens().sort()) {
      const sources = registry.sourcesFor(token);
      if (sources.length > 1) multi += 1;
      for (const source of sources) {
        const kind = kindOf(source);
        const detail =
          kind === "file"
            ? toPosix(relative(cwd, source.slice("file:".length)))
            : kind === "gopass"
              ? source.slice("gopass:".length)
              : source;
        const bucket = groups.get(kind) ?? new Map<string, string[]>();
        const list = bucket.get(detail) ?? [];
        list.push(token);
        bucket.set(detail, list);
        groups.set(kind, bucket);
      }
    }
    const kinds = [...groups.keys()].sort();
    const countIn = (kind: string): number =>
      [...groups.get(kind)!.values()].reduce((total, list) => total + list.length, 0);

    const lines = [
      `secret-mask · ${registry.size} value(s)${multi > 0 ? ` · ${multi} from several sources` : ""}`,
    ];
    for (const kind of kinds) {
      lines.push(`-- ${kind} (${countIn(kind)})`);
      const bucket = groups.get(kind)!;
      for (const detail of [...bucket.keys()].sort()) {
        lines.push(`  ${detail}`);
        for (const token of bucket.get(detail)!) lines.push(`    ${token}`);
      }
    }
    return {
      lines,
      summary: `secret-mask: ${registry.size} value(s) · ${kinds
        .map((kind) => `${kind} ${countIn(kind)}`)
        .join(" · ")}`,
    };
  }

  pi.registerCommand("secret-list", {
    description: "Open a scrollable overlay listing every registered value with its source",
    handler: async (_args: string, ctx) => {
      if (registry.size === 0) {
        ctx.ui.notify("secret-mask: no values registered", "info");
        return;
      }
      await showPanel(ctx, ctx.cwd);
    },
  });

  pi.registerCommand("secret-add", {
    description: "Register a secret for this session: /secret-add NAME VALUE",
    handler: async (args: string, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      let name = "SECRET";
      let value = "";
      if (parts.length >= 2) {
        name = parts[0];
        value = parts.slice(1).join(" ");
      } else if (parts.length === 1) {
        value = parts[0];
      } else {
        value = ((await ctx.ui.input("Secret value (the model will not see it):")) ?? "").trim();
      }
      const token = registry.add(value.trim(), name, "manual");
      if (!token) {
        ctx.ui.notify("secret-mask: no value given, or the value was rejected", "warning");
        return;
      }
      updateStatus(ctx);
      ctx.ui.notify(`secret-mask: registered ${name} as ${token}`, "info");
    },
  });

  pi.registerCommand("secret-reload", {
    description: "Re-read the redact-listed files this session touched and refresh their values",
    handler: async (_args: string, ctx) => {
      const before = registry.size;
      for (const abs of [...state.readFiles]) harvestTrackedFile(abs);
      noteActivity(before);
      ctx.ui.notify(
        `secret-mask: ${registry.size} value(s) known · ${state.readFiles.size} file(s) touched`,
        "info",
      );
    },
  });

  pi.registerCommand("secret-toggle", {
    description: "Turn masking on or off for this session: /secret-toggle [on|off]",
    handler: async (args: string, ctx) => {
      const want = (args ?? "").trim().toLowerCase();
      state.enabled = want === "on" ? true : want === "off" ? false : !state.enabled;
      updateStatus(ctx);
      ctx.ui.notify(
        state.enabled
          ? `secret-mask: masking on · ${registry.size} value(s) known`
          : "secret-mask: masking off for this session · values pass through untouched",
        state.enabled ? "info" : "warning",
      );
    },
  });

  pi.on("session_shutdown", () => {
    if (state.statusTimer) clearTimeout(state.statusTimer);
    state.statusTimer = undefined;
    state.readFiles.clear();
    registry.reset();
    state.ctx = undefined;
  });
}
