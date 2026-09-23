import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SecretRegistry,
  activeShapes,
  envVarName,
  makeShapeTester,
  registerShapeHits,
  rewriteBashCommand,
  tokenName,
} from "../src/engine.ts";
import {
  classifyKey,
  detectFormat,
  matchPath,
  normalizeConfig,
  parseKV,
  redactLines,
  redactSpans,
  resolveAction,
  scanFiles,
} from "../src/policy.ts";

test("classifyKey: order is shape -> sensitive -> explicit allow -> safe -> fail-closed", () => {
  const cfg = normalizeConfig({});
  const ctx = {
    sensitiveKeys: cfg.sensitiveKeys,
    safeKeys: cfg.safeKeys,
    shaped: (value: string) => value.startsWith("sk-") && value.length > 20,
  };
  assert.equal(classifyKey("PORT", "3000", ctx), "visible");
  assert.equal(classifyKey("NODE_ENV", "production", ctx), "visible");
  assert.equal(classifyKey("PORT", `sk-${"a".repeat(24)}`, ctx), "redact", "shape beats safe key");
  assert.equal(classifyKey("DB_PASSWORD", "hunter2", ctx), "redact");
  assert.equal(classifyKey("STRIPE_TOKEN", "abc", ctx), "redact");
  assert.equal(classifyKey("SOMETHING_ELSE", "abc", ctx), "redact", "fail-closed");

  const rule = { match: [".env"], action: "redact" as const, keys: { allow: ["SOMETHING_ELSE"] } };
  assert.equal(classifyKey("SOMETHING_ELSE", "abc", { ...ctx, rule }), "visible");
  const denyRule = { match: [".env"], action: "redact" as const, keys: { deny: ["NODE_ENV"] } };
  assert.equal(classifyKey("NODE_ENV", "production", { ...ctx, rule: denyRule }), "redact", "rule deny beats safe");
});

test("parseKV: env quotes, escapes, inline comments, export prefix", () => {
  const content = [
    "# comment",
    'export API_KEY="abc#123"',
    "PORT=3000 # inline comment",
    "QUOTED='p@ss word'",
    "EMPTY=",
    "PLAIN=value",
  ].join("\n");
  const spans = parseKV("env", content);
  const pairs = new Map(spans.map((s) => [s.key, content.slice(s.valueStart, s.valueEnd)]));
  assert.equal(pairs.get("API_KEY"), "abc#123");
  assert.equal(pairs.get("PORT"), "3000");
  assert.equal(pairs.get("QUOTED"), "p@ss word");
  assert.equal(pairs.get("PLAIN"), "value");
  assert.equal(pairs.has("EMPTY"), false, "empty value has nothing to redact");
  assert.equal(pairs.has("# comment"), false);
});

test("parseKV: json values inside arrays and nested objects", () => {
  const content = `{"DB_PASSWORD":["array-secret","second-secret"],"port":8080,"nested":{"apiKey":"nested-secret"}}`;
  const spans = parseKV("json", content);
  const pairs = spans.map((s) => [s.key, content.slice(s.valueStart, s.valueEnd)]);
  assert.deepEqual(pairs, [
    ["DB_PASSWORD", "array-secret"],
    ["DB_PASSWORD", "second-secret"],
    ["port", "8080"],
    ["apiKey", "nested-secret"],
  ]);
  const redacted = redactSpans(content, spans, (key) => (key === "port" ? null : `__SECRET_${key}__`));
  assert.equal(
    redacted.text,
    `{"DB_PASSWORD":["__SECRET_DB_PASSWORD__","__SECRET_DB_PASSWORD__"],"port":8080,"nested":{"apiKey":"__SECRET_apiKey__"}}`,
  );
});

test("parseKV: yaml block and folded scalars tokenize the body, not the indicator", () => {
  const content = [
    "service: web",
    "DB_PASSWORD: |",
    "  block-line-one",
    "  block-line-two",
    "API_TOKEN: >-",
    "  folded-line",
    "PORT: 8080",
    "",
  ].join("\n");
  const spans = parseKV("yaml", content);
  const pairs = spans.map((s) => [s.key, content.slice(s.valueStart, s.valueEnd)]);
  assert.deepEqual(pairs, [
    ["service", "web"],
    ["DB_PASSWORD", "block-line-one"],
    ["DB_PASSWORD", "block-line-two"],
    ["API_TOKEN", "folded-line"],
    ["PORT", "8080"],
  ]);
  const redacted = redactSpans(content, spans, (key) =>
    key === "service" || key === "PORT" ? null : `__SECRET_${key}__`,
  ).text;
  assert.match(redacted, /DB_PASSWORD: \|\n {2}__SECRET_DB_PASSWORD__\n {2}__SECRET_DB_PASSWORD__\n/);
  assert.equal(redacted.includes("|"), true, "the block indicator is not the value");
  assert.equal(redacted.includes("block-line-one"), false);
  assert.equal(redacted.includes("folded-line"), false);
});

test("parseKV: json, yaml and grep-prefixed lines", () => {
  const json = `{\n  "apiKey": "secret-value",\n  "port": 8080\n}`;
  const jsonSpans = parseKV("json", json);
  assert.equal(jsonSpans.length, 2);
  assert.equal(jsonSpans[0].key, "apiKey");
  assert.equal(json.slice(jsonSpans[0].valueStart, jsonSpans[0].valueEnd), "secret-value");
  assert.equal(jsonSpans[1].key, "port");
  assert.equal(json.slice(jsonSpans[1].valueStart, jsonSpans[1].valueEnd), "8080");

  const yaml = `service: web\napiKey: "yaml-secret"\nport: 8080\n`;
  const yamlSpans = parseKV("yaml", yaml);
  assert.deepEqual(yamlSpans.map((s) => s.key), ["service", "apiKey", "port"]);
  assert.equal(yaml.slice(yamlSpans[1].valueStart, yamlSpans[1].valueEnd), "yaml-secret");

  const grep = `.env.production:12:DB_PASSWORD=supersecret\n.env.production:13:PORT=5432`;
  const lines = redactLines(grep, "env", (key) => (key === "DB_PASSWORD" ? `__SECRET_${key}__` : null));
  assert.equal(lines.text, `.env.production:12:DB_PASSWORD=__SECRET_DB_PASSWORD__\n.env.production:13:PORT=5432`);
  assert.equal(lines.redacted.length, 1);
});

test("redactSpans: values replaced, keys and comments untouched", () => {
  const content = `NODE_ENV=production\n# keep this\nDB_PASSWORD=hunter2\nPORT=5432\n`;
  const spans = parseKV("env", content);
  const result = redactSpans(content, spans, (key) =>
    key === "NODE_ENV" || key === "PORT" ? null : `__SECRET_${key}__`,
  );
  assert.equal(
    result.text,
    `NODE_ENV=production\n# keep this\nDB_PASSWORD=__SECRET_DB_PASSWORD__\nPORT=5432\n`,
  );
  assert.deepEqual(result.redacted, [{ key: "DB_PASSWORD", value: "hunter2" }]);
  assert.deepEqual(result.visible, ["PORT", "NODE_ENV"]);
});

test("SecretRegistry: masking, whole-token unmask, short values unmask-only", () => {
  const registry = new SecretRegistry(4);
  const token = registry.add("supersecretvalue", "DB_PASSWORD", "file:a");
  assert.equal(token, tokenName("DB_PASSWORD"));
  registry.add("ab", "SHORT_PIN", "file:a", false);

  assert.equal(registry.maskText("db supersecretvalue here"), "db __SECRET_DB_PASSWORD__ here");
  assert.equal(registry.maskText("ab supersecretvalue"), "ab __SECRET_DB_PASSWORD__", "short value is not masked globally");
  assert.equal(registry.unmaskText("use __SECRET_DB_PASSWORD__ and __SECRET_SHORT_PIN__"), "use supersecretvalue and ab");
  assert.deepEqual(registry.unknownTokens("__SECRET_NOPE__ __SECRET_DB_PASSWORD__"), ["__SECRET_NOPE__"]);
  assert.equal(registry.add("__SECRET_X__", "WEIRD", "file:a"), undefined, "tokens are never registered as values");
  assert.equal(registry.add("supersecretvalue", "OTHER_NAME", "file:b"), token, "same value reuses its token");

  const second = registry.add("differentvalue", "DB_PASSWORD", "file:c");
  assert.equal(second, "__SECRET_DB_PASSWORD_2__", "colliding names get a suffix");

  registry.dropSource("file:a");
  assert.equal(registry.has(token!), true, "value still has source file:b");
  registry.dropSource("file:b");
  assert.equal(registry.has(token!), false, "last source dropped removes the value");
});

test("shape detection registers pattern hits", () => {
  const registry = new SecretRegistry(4);
  const shapes = activeShapes(
    { openai: true, github: true, google: false, aws: false, jwt: false, pem: false, base64: false },
    [],
    32,
  );
  const shaped = makeShapeTester(shapes);
  const openaiKey = `sk-${"a".repeat(24)}`;
  assert.equal(shaped(openaiKey), true);
  assert.equal(shaped("plain text"), false);

  const added = registerShapeHits(`token=${openaiKey} and ghp_${"b".repeat(24)}`, shapes, registry, "input");
  assert.equal(added.length, 2);
  assert.equal(registry.tokens().length, 2);
  assert.equal(registry.maskText(`token=${openaiKey}`), "token=__SECRET_OPENAI__");
  assert.equal(registry.unmaskText("__SECRET_GITHUB__").startsWith("ghp_"), true, "github shape harvests too");
});

test("rewriteBashCommand: env injection, quoting, unknown tokens", () => {
  const registry = new SecretRegistry(4);
  const value = `p@ss'w0rd;$(x)"q"`;
  registry.add(value, "DB_PASSWORD", "file:a");

  const rewritten = rewriteBashCommand(
    `psql "postgres://u:__SECRET_DB_PASSWORD__@h/db" && echo '__SECRET_DB_PASSWORD__' && echo __SECRET_DB_PASSWORD__`,
    registry,
    "PI_SECRET_",
  );
  assert.equal(rewritten.env.length, 1);
  assert.equal(rewritten.env[0].name, envVarName("__SECRET_DB_PASSWORD__", "PI_SECRET_"));
  assert.equal(rewritten.env[0].value, value);
  assert.match(rewritten.command, /^export PI_SECRET_DB_PASSWORD='/);
  assert.ok(rewritten.command.includes(`'\\''`), "single quotes escaped for the shell");
  assert.ok(rewritten.command.includes(`"$\{PI_SECRET_DB_PASSWORD}"`), "single-quoted token becomes a double-quoted expansion");
  assert.ok(rewritten.command.includes(`$\{PI_SECRET_DB_PASSWORD\}`), "unquoted token becomes an expansion");
  assert.ok(!rewritten.command.includes("__SECRET_DB_PASSWORD__"));

  const unknown = rewriteBashCommand("echo __SECRET_NOPE__", registry, "PI_SECRET_");
  assert.deepEqual(unknown.unknown, ["__SECRET_NOPE__"]);
  assert.equal(unknown.env.length, 0);
});

test("path rules: first match wins, unmatched paths stay plain text", () => {
  const cfg = normalizeConfig({
    files: [
      { match: [".env.example", "*.sample"], action: "allow" },
      { match: [".env.local"], action: "allow" },
      { match: [".env", ".env.staging", ".env.production", ".env.prod*", "**/.env"], action: "redact" },
      { match: ["blocked.env"], action: "deny" },
    ],
  });
  const resolve = (rel: string) => resolveAction(rel, `/project/${rel}`, cfg.files).action;
  assert.equal(resolve(".env.example"), "allow");
  assert.equal(resolve("sample.sample"), "allow");
  assert.equal(resolve(".env.local"), "allow");
  assert.equal(resolve(".env.production"), "redact");
  assert.equal(resolve(".env.staging"), "redact");
  assert.equal(resolve("config/.env"), "redact", "**/.env matches nested paths");
  assert.equal(resolve("blocked.env"), "deny");
  assert.equal(resolve("src/index.ts"), "allow", "unmatched = plain text");
});

test("glob + format helpers", () => {
  assert.equal(matchPath(".env*", ".env.staging", "/p/.env.staging"), true);
  assert.equal(matchPath(".env*", "config/.env", "/p/config/.env"), true, "basename match");
  assert.equal(matchPath("**/.env", "config/prod/.env", "/p/config/prod/.env"), true);
  assert.equal(matchPath("**/.env", "config/prod/.env.bak", "/p/config/prod/.env.bak"), false);
  assert.equal(matchPath("**/.env", "blocked.env", "/p/blocked.env"), false, "**/ needs a directory boundary");
  assert.equal(matchPath("**/.env", ".env", "/p/.env"), true, "zero directories allowed");
  assert.equal(detectFormat(".env.production"), "env");
  assert.equal(detectFormat("config/prod.yaml"), "yaml");
  assert.equal(detectFormat("terraform.tfvars"), "kv");
  assert.equal(detectFormat("credentials"), "ini");
});

test("scanFiles resolves exact, glob and nested patterns", () => {
  const dir = mkdtempSync(join(tmpdir(), "secret-mask-scan-"));
  mkdirSync(join(dir, "config"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(dir, ".env.production"), "A=1\n");
  writeFileSync(join(dir, ".env.local"), "A=1\n");
  writeFileSync(join(dir, "config", "prod.yaml"), "a: 1\n");
  writeFileSync(join(dir, "node_modules", "pkg", ".env.staging"), "A=1\n");

  const found = scanFiles(dir, [".env.production", "config/*.yaml", "**/.env.staging"], 4);
  const rel = found.map((f) => f.slice(dir.length + 1)).sort();
  assert.deepEqual(rel, [".env.production", "config/prod.yaml"], "heavy directories are skipped");
});

test("registry: colliding long names still get distinct tokens", () => {
  const registry = new SecretRegistry(4);
  const long = "LONG_NAME_".repeat(8);
  const first = registry.add("value-alpha-9", long, "manual");
  const second = registry.add("value-bravo-9", long, "manual");
  assert.ok(first && second, "both registered");
  assert.notEqual(first, second, "suffix must still change a truncated token");
  assert.equal(registry.maskText("value-bravo-9"), second);
});

test("registry: an automatic word value never masks prose", () => {
  const registry = new SecretRegistry(4);
  const token = registry.add("maskword", "SERVICE_NAME", "file:/tmp/.env");
  assert.ok(token, "still gets a token for the redacted view");
  assert.equal(registry.maskText("the maskword is here"), "the maskword is here");
});

test("registry: an automatic long value masks standalone text but never identifiers", () => {
  const registry = new SecretRegistry(4);
  const token = registry.add("longwordsalt", "JWT_SECRET", "file:/tmp/.env");
  assert.ok(token);
  assert.equal(registry.maskText("longwordsalt"), token, "standalone occurrence is masked");
  assert.equal(
    registry.maskText("run --prefix_longwordsalt_suffix"),
    "run --prefix_longwordsalt_suffix",
    "inside an identifier it is left alone",
  );
});

test("registry: an explicitly added word still masks wherever it appears", () => {
  const registry = new SecretRegistry(4);
  const token = registry.add("maskword", "MY_WORD", "manual");
  assert.ok(token);
  assert.equal(registry.maskText("request_maskword"), `request_${token}`, "explicit means everywhere");
});

test("rewriteBashCommand: a token inside single quotes still expands", () => {
  const registry = new SecretRegistry(4);
  const token = registry.add("hunter2-abc123", "TOKEN", "manual")!;
  const rewritten = rewriteBashCommand(`curl -H 'Authorization: Bearer ${token}' http://x`, registry, "PI_SECRET_");
  assert.ok(rewritten.command.startsWith("export PI_SECRET_TOKEN="), "prologue carries the value");
  assert.ok(rewritten.command.includes('${PI_SECRET_TOKEN}'), "token expanded");
  assert.ok(
    !rewritten.command.includes(token),
    "no token left behind in the command text",
  );
  assert.equal(rewritten.env.length, 1);
  assert.equal(rewritten.env[0].token, token, "env entry knows which token it came from");
});

test("rewriteBashCommand: tokens differing only in case get distinct env names", () => {
  const registry = new SecretRegistry(4);
  const upper = registry.add("hunter2-abc123", "APIKEY", "manual")!;
  const lower = registry.add("hunter3-xyz789", "ApiKey", "manual")!;
  assert.notEqual(upper, lower, "tokens stay distinct");
  const rewritten = rewriteBashCommand(`echo ${upper} ${lower}`, registry, "PI_SECRET_");
  assert.equal(rewritten.env.length, 2);
  assert.notEqual(rewritten.env[0].name, rewritten.env[1].name, "env names must differ");
});

test("registry: past the cap a value is still masked, under a generic name", () => {
  const registry = new SecretRegistry(4, 2);
  registry.add("hunter2-abc123", "ONE", "manual");
  registry.add("hunter3-xyz789", "TWO", "manual");
  const third = registry.add("hunter4-qrs456", "THREE", "manual")!;
  assert.ok(third, "still registered");
  assert.equal(registry.maskText("hunter4-qrs456"), third, "still masked");
  assert.equal(third.includes("THREE"), false, "generic name past the cap");
});
