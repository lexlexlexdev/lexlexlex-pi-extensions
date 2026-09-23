/**
 * End-to-end tests against a mock extension host: exercises the real hook wiring in
 * index.ts (policy -> registry -> bash rewrite -> redacted read view -> write round-trip).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = "supersecretvalue";
const ROTATED = "rotatedsecretvalue";

interface Emitted {
  name: string;
  event: any;
  result: any;
}

class MockPi {
  handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  tools = new Map<string, any>();
  commands = new Map<string, any>();
  emitted: Emitted[] = [];

  on(name: string, handler: (event: any, ctx: any) => any): void {
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
  }

  registerTool(tool: any): void {
    this.tools.set(tool.name, tool);
  }

  registerCommand(name: string, options: any): void {
    this.commands.set(name, options);
  }

  /** Pi composes handlers: the last defined result wins (tool_call blocks win). */
  async emit(name: string, event: any, ctx: any): Promise<any> {
    let result: any;
    for (const handler of this.handlers.get(name) ?? []) {
      const current = await handler(event, ctx);
      if (current !== undefined) result = current;
    }
    this.emitted.push({ name, event, result });
    return result;
  }
}

function makeCtx(cwd: string) {
  const notices: string[] = [];
  const widgets = new Map<string, string[]>();
  const statuses = new Map<string, string>();
  const overlays: {
    component: any;
    options: any;
    host: any;
    closed?: boolean;
  }[] = [];
  const ctx: any = {
    cwd,
    mode: "print" as const,
    hasUI: false,
    signal: undefined,
    ui: {
      notify: (message: string) => notices.push(message),
      setStatus: (key: string, value: string | undefined) => {
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
      setWidget: (key: string, content: string[] | undefined) => {
        if (content === undefined) widgets.delete(key);
        else widgets.set(key, content);
      },
      input: async () => undefined,
      custom: async (factory: any, options: any) => {
        let finish: (value: unknown) => void = () => {};
        const settled = new Promise((resolve) => {
          finish = resolve;
        });
        const entry: any = { options, host: { rows: 30, requestRender: () => {} } };
        entry.component = factory(entry.host, {}, {}, () => {
          entry.closed = true;
          finish(undefined);
        });
        overlays.push(entry);
        return settled;
      },
      notices,
      widgets,
      statuses,
      overlays,
    },
  };
  return ctx;
}

interface Harness {
  pi: MockPi;
  dir: string;
  ctx: ReturnType<typeof makeCtx>;
}

async function setup(options: { prime?: boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "secret-mask-ext-"));
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(
    join(dir, ".env.production"),
    [
      "NODE_ENV=production",
      "PORT=5432",
      "DB_PASSWORD=" + SECRET,
      "DB_HOST=db.internal",
      "API_KEY=abc123",
      "SOME_FLAG=production",
      "WORKER_ID=1234",
      "ADMIN_TOKEN=456789",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, ".env.example"), "DB_PASSWORD=changeme\n");
  writeFileSync(join(dir, "blocked.env"), `TOKEN=${SECRET}\n`);
  writeFileSync(join(dir, "app.log"), `connecting with ${SECRET}\n`);
  symlinkSync(join(dir, ".env.production"), join(dir, "prod-link.env"));

  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      files: [
        { match: [".env.example", "*.sample"], action: "allow" },
        { match: [".env.production", ".env.staging", "**/.env"], action: "redact" },
        { match: ["blocked.env"], action: "deny" },
        { match: ["config/*.yaml"], action: "redact" },
        { match: ["config/*.json"], action: "redact" },
      ],
    }),
  );
  process.env.SECRET_MASK_CONFIG = configPath;

  const mod = await import(`../index.ts?cachebust=${Date.now()}`);
  const pi = new MockPi();
  mod.default(pi as any);
  const ctx = makeCtx(dir);
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  if (options.prime !== false) {
    // There is no workspace scan at startup: a value becomes known when the model touches the file.
    await pi.emit(
      "tool_result",
      {
        type: "tool_result",
        toolCallId: "prime",
        toolName: "read",
        isError: false,
        input: { path: ".env.production" },
        content: [{ type: "text", text: readFileSync(join(dir, ".env.production"), "utf-8") }],
      },
      ctx,
    );
  }
  return { pi, dir, ctx };
}

test("read of a redact-listed file returns a key-filtered view", async () => {
  const { pi, dir, ctx } = await setup();
  const path = join(dir, ".env.production");
  await pi.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "read", input: { path } }, ctx);

  const event = {
    type: "tool_result",
    toolCallId: "1",
    toolName: "read",
    input: { path },
    isError: false,
    content: [{ type: "text", text: `NODE_ENV=production\nPORT=5432\nDB_PASSWORD=${SECRET}\nDB_HOST=db.internal\n` }],
  };
  await pi.emit("tool_result", event, ctx);
  const text = event.content[0].text;
  assert.equal(text.includes(SECRET), false, "secret value must not survive the read view");
  assert.match(text, /DB_PASSWORD=__SECRET_DB_PASSWORD__/);
  assert.match(text, /DB_HOST=__SECRET_DB_HOST__/, "unclassified key fails closed");
  assert.match(text, /NODE_ENV=production/, "safe key stays readable");
  assert.match(text, /PORT=5432/, "safe key stays readable");
});

test("unmatched files stay plain text and are not harvested", async () => {
  const { pi, ctx } = await setup({ prime: false });
  const body = `notes=${SECRET}\n`;
  const readEvent: any = {
    type: "tool_result",
    toolCallId: "7",
    toolName: "read",
    isError: false,
    input: { path: "notes.txt" },
    content: [{ type: "text", text: body }],
  };
  await pi.emit("tool_result", readEvent, ctx);
  assert.equal(readEvent.content[0].text.includes(SECRET), true, "an unmatched file stays readable");

  const outbound: any = {
    type: "tool_result",
    toolCallId: "8",
    toolName: "bash",
    isError: false,
    input: { command: "cat notes.txt" },
    content: [{ type: "text", text: body }],
  };
  await pi.emit("tool_result", outbound, ctx);
  // A non-sensitive key and a non-credential value: nothing is rewritten, and no net exists for it.
  assert.equal(outbound.content[0].text.includes(SECRET), true, "no value net without a rule");
});

test("no workspace scan: a sensitive pair is tokenized on sight with no prior read", async () => {
  const { pi, ctx } = await setup({ prime: false });
  const outbound: any = {
    type: "tool_result",
    toolCallId: "30",
    toolName: "bash",
    isError: false,
    input: { command: "cat .env.staging" },
    content: [{ type: "text", text: `DB_PASSWORD=${SECRET}` }],
  };
  await pi.emit("tool_result", outbound, ctx);
  const dbToken = ["__SECRET", "DB_PASSWORD__"].join("_");
  assert.match(outbound.content[0].text, new RegExp(`DB_PASSWORD=${dbToken}`), "tokenized on sight");
  assert.equal(outbound.content[0].text.includes(SECRET), false, "the value itself is gone");
  assert.equal(
    ctx.ui.statuses.get("secret-mask"),
    "mask: on, NEW SECRET ADDED",
    "footer flags the new registration",
  );
});

test("on sight leaves words, safe keys and non-sensitive pairs alone", async () => {
  const { pi, ctx } = await setup({ prime: false });
  const text = ["GREETING=hello", "NODE_ENV=production", "PASSWORD=changeme", `notes=${SECRET}`].join("\n");
  const outbound: any = {
    type: "tool_result",
    toolCallId: "31",
    toolName: "bash",
    isError: false,
    input: { command: "env" },
    content: [{ type: "text", text }],
  };
  await pi.emit("tool_result", outbound, ctx);
  const result = outbound.content[0].text;
  assert.ok(result.includes("GREETING=hello"), "non-sensitive pair untouched");
  assert.ok(result.includes("NODE_ENV=production"), "safe key untouched");
  assert.ok(result.includes("PASSWORD=changeme"), "a bare word is not rewritten on sight");
});

test("on sight: sensitive pairs are tokenized anywhere in noisy text and embedded json", async () => {
  const { pi, ctx } = await setup({ prime: false });
  const values = ["pair-value-alpha-1", "pair-value-bravo-2", "pair-value-charlie-3"];
  const text = [
    `My DB_PASSWORD=${values[0]}`,
    `warning: SERVICE_TOKEN=${values[1]}`,
    `log: {"SESSION_SECRET":"${values[2]}"}`,
  ].join("\n");
  const outbound: any = {
    type: "tool_result",
    toolCallId: "33",
    toolName: "bash",
    isError: false,
    input: { command: "env" },
    content: [{ type: "text", text }],
  };
  await pi.emit("tool_result", outbound, ctx);
  const result = outbound.content[0].text;
  for (const value of values) assert.equal(result.includes(value), false, `pair value ${value} must be tokenized`);
  assert.match(result, /__SECRET_DB_PASSWORD__/);
  assert.match(result, /__SECRET_SERVICE_TOKEN__/);
  assert.match(result, /__SECRET_SESSION_SECRET__/);
  assert.match(result, /My DB_PASSWORD=__SECRET/, "prose prefix is kept");
  assert.match(result, /warning: SERVICE_TOKEN=__SECRET/, "warning prefix is kept");
  assert.match(result, /log: \{"SESSION_SECRET":"__SECRET/, "embedded json key stays visible");
});

test("read of a redact-listed json file tokenizes values inside arrays", async () => {
  const { pi, dir, ctx } = await setup();
  const path = join(dir, "config", "prod.json");
  const text = `{\n  "SERVICE_PASSWORD": ["json-array-secret"],\n  "NODE_ENV": "production"\n}\n`;
  writeFileSync(path, text);
  const event = {
    type: "tool_result",
    toolCallId: "34",
    toolName: "read",
    input: { path },
    isError: false,
    content: [{ type: "text", text }],
  };
  await pi.emit("tool_result", event, ctx);
  const out = event.content[0].text;
  assert.equal(out.includes("json-array-secret"), false, "the array element is the value");
  assert.match(out, /"SERVICE_PASSWORD": \["__SECRET_SERVICE_PASSWORD__"\]/, "key stays visible");
  assert.match(out, /"NODE_ENV": "production"/, "safe key stays readable");
});

test("read of a yaml file tokenizes block and folded scalar bodies", async () => {
  const { pi, dir, ctx } = await setup();
  const path = join(dir, "config", "block.yaml");
  const text = [
    "service: web",
    "DB_PASSWORD: |",
    "  block-line-one",
    "  block-line-two",
    "API_TOKEN: >",
    "  folded-line",
    "PORT: 8080",
    "",
  ].join("\n");
  writeFileSync(path, text);
  const event = {
    type: "tool_result",
    toolCallId: "35",
    toolName: "read",
    input: { path },
    isError: false,
    content: [{ type: "text", text }],
  };
  await pi.emit("tool_result", event, ctx);
  const out = event.content[0].text;
  assert.equal(out.includes("block-line-one"), false, "block scalar body tokenized");
  assert.equal(out.includes("block-line-two"), false);
  assert.equal(out.includes("folded-line"), false, "folded scalar body tokenized");
  assert.match(out, /DB_PASSWORD: \|/, "the indicator is not replaced");
  assert.match(out, /API_TOKEN: >/);
  assert.match(out, /service: __SECRET_service__/, "unclassified key fails closed");
  assert.match(out, /PORT: 8080/);
});

test("read safety sweep: a sensitive key is tokenized whatever the syntax", async () => {
  const { pi, dir, ctx } = await setup();
  // .env.staging is redact-listed and parsed as dotenv: embedded JSON lines and block
  // scalars are syntax the parser would otherwise skip.
  const path = join(dir, ".env.staging");
  writeFileSync(
    path,
    [
      '{"DB_PASSWORD":["sweep-json-element"]}',
      "API_TOKEN: |",
      "  sweep-block-line",
      "DB_CREDENTIALS: {user: root, pass: sweep-inline-map}",
      "",
    ].join("\n"),
  );
  const event = {
    type: "tool_result",
    toolCallId: "36",
    toolName: "read",
    input: { path },
    isError: false,
    content: [{ type: "text", text: readFileSync(path, "utf-8") }],
  };
  await pi.emit("tool_result", event, ctx);
  const out = event.content[0].text;
  assert.equal(out.includes("sweep-json-element"), false, "embedded json array element tokenized");
  assert.equal(out.includes("sweep-block-line"), false, "block scalar line tokenized");
  assert.equal(out.includes("sweep-inline-map"), false, "inline map value tokenized");
  assert.match(out, /"DB_PASSWORD"/, "json key stays visible");
  assert.match(out, /API_TOKEN:/, "yaml key stays visible");
});

test("secret-toggle switches masking off, says so, and passes values through", async () => {
  const { pi, ctx } = await setup();
  const toggle = pi.commands.get("secret-toggle");
  assert.ok(toggle, "the toggle command is registered");
  assert.equal(ctx.ui.statuses.get("secret-mask"), "mask: on", "footer starts at mask: on");

  await toggle.handler("off", ctx);
  assert.equal(ctx.ui.statuses.get("secret-mask"), "mask: false", "footer reports masking off");
  const outbound: any = {
    type: "tool_result",
    toolCallId: "40",
    toolName: "bash",
    isError: false,
    input: { command: "env" },
    content: [{ type: "text", text: `DB_PASSWORD=${SECRET}` }],
  };
  await pi.emit("tool_result", outbound, ctx);
  assert.equal(outbound.content[0].text, `DB_PASSWORD=${SECRET}`, "values pass through while off");

  await toggle.handler("on", ctx);
  assert.equal(ctx.ui.statuses.get("secret-mask"), "mask: on", "footer reports masking back on");
});

test("bash: token becomes an env reference and the value travels in the environment", async () => {
  const { pi, ctx } = await setup();
  const input = { command: `psql "postgres://u:__SECRET_DB_PASSWORD__@db/app" && echo '__SECRET_DB_PASSWORD__'` };
  const result = await pi.emit("tool_call", { type: "tool_call", toolCallId: "3", toolName: "bash", input }, ctx);
  assert.equal(result, undefined, "bash rewrite is not a block");
  assert.match(input.command, /^export PI_SECRET_DB_PASSWORD='/);
  assert.ok(input.command.includes(SECRET), "real value injected into the environment prologue");
  assert.ok(input.command.includes(`$\{PI_SECRET_DB_PASSWORD\}`));
  assert.ok(input.command.includes(`"$\{PI_SECRET_DB_PASSWORD}"`));
  assert.equal(input.command.includes("__SECRET_DB_PASSWORD__"), false);
});


test("bash: unknown token-shaped text is left alone", async () => {
  const { pi, ctx } = await setup();
  const input = { command: "curl -H 'x: __SECRET_NOPE__' u" };
  const result = await pi.emit("tool_call", { type: "tool_call", toolCallId: "4", toolName: "bash", input }, ctx);
  assert.equal(result, undefined, "unknown shapes are not a block");
  assert.equal(input.command, "curl -H 'x: __SECRET_NOPE__' u", "command untouched");
});

test("bash: deny-listed path is blocked, redact-listed path is allowed", async () => {
  const { pi, dir, ctx } = await setup();
  const denied = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "5", toolName: "bash", input: { command: `cat ${join(dir, "blocked.env")}` } },
    ctx,
  );
  assert.equal(denied?.block, true);
  assert.match(denied.reason, /deny rule/);

  const allowed = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "6", toolName: "bash", input: { command: `cat ${join(dir, ".env.production")}` } },
    ctx,
  );
  assert.equal(allowed, undefined, "redact-listed paths are readable; their values are masked in the output");
});


test("write: a registered token is refused and the input stays untouched", async () => {
  const { pi, dir, ctx } = await setup();
  const token = "__SECRET_DB_PASSWORD__";
  const input = { path: join(dir, ".env.pro" + "duction"), content: `DB_PASSWORD=${token}\n` };
  const result = await pi.emit("tool_call", { type: "tool_call", toolCallId: "7", toolName: "write", input }, ctx);
  assert.equal(result?.block, true, "a token must never reach a file");
  assert.match(result.reason, /never substitutes real values into files/);
  assert.equal(input.content, `DB_PASSWORD=${token}\n`, "input untouched on block");
});


test("write: token-shaped text that no value backs is ordinary text", async () => {
  const { pi, dir, ctx } = await setup();
  const input = { path: join(dir, "notes.md"), content: "docs: paste __SECRET_NOPE__ into psql\n" };
  const result = await pi.emit("tool_call", { type: "tool_call", toolCallId: "8", toolName: "write", input }, ctx);
  assert.equal(result, undefined, "not blocked");
  assert.equal(input.content, "docs: paste __SECRET_NOPE__ into psql\n", "written verbatim, never substituted");
});


test("edit: a registered token in edits[] is refused", async () => {
  const { pi, dir, ctx } = await setup();
  const token = "__SECRET_DB_PASSWORD__";
  const input = {
    path: join(dir, ".env.pro" + "duction"),
    oldText: "x",
    newText: "y",
    edits: [{ oldText: "a", newText: `b=${token}` }],
  };
  const result = await pi.emit("tool_call", { type: "tool_call", toolCallId: "9", toolName: "edit", input }, ctx);
  assert.equal(result?.block, true);
  assert.equal(input.edits[0].newText, `b=${token}`, "input untouched on block");
});

test("read: deny-listed path is blocked before the tool runs", async () => {
  const { pi, dir, ctx } = await setup();
  const result = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "10", toolName: "read", input: { path: join(dir, "blocked.env") } },
    ctx,
  );
  assert.equal(result?.block, true);
});

test("provider payload is masked before it leaves the process", async () => {
  const { pi, ctx } = await setup();
  const payload = {
    system: "you are a helpful agent",
    messages: [
      { role: "user", content: [{ type: "text", text: `my key is ${SECRET} ok` }] },
      { role: "assistant", content: [{ type: "tool_use", input: { url: `https://x/?k=${SECRET}` } }] },
    ],
    tools: [{ name: "bash", description: `uses ${SECRET}` }],
  };
  const result = await pi.emit("before_provider_request", { type: "before_provider_request", payload }, ctx);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(SECRET), false);
  assert.match(serialized, /__SECRET_DB_PASSWORD__/);
});

test("provider payload: tool schemas and image urls are masked, image data is not", async () => {
  const { pi, ctx } = await setup();
  const dataUrl = `data:image/png;base64,${SECRET}`;
  const payload = {
    system: "sys",
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `https://example.test/img?k=${SECRET}` } },
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "image", source: { type: "url", url: `https://example.test/source?k=${SECRET}` } },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "configure",
          description: `uses ${SECRET}`,
          parameters: {
            type: "object",
            properties: {
              apiKey: { type: "string", description: `token ${SECRET}`, default: SECRET },
              mode: { type: "string", default: "fast" },
            },
          },
        },
      },
    ],
  };
  const result = await pi.emit("before_provider_request", { type: "before_provider_request", payload }, ctx);
  assert.equal(JSON.stringify(result.tools).includes(SECRET), false, "defaults and descriptions are masked");
  assert.match(JSON.stringify(result.tools), /__SECRET_DB_PASSWORD__/);
  assert.equal(JSON.stringify(result.messages[0].content[0]).includes(SECRET), false, "image url string masked");
  assert.equal(JSON.stringify(result.messages[0].content[2]).includes(SECRET), false, "url-source image masked");
  assert.equal(JSON.stringify(result.messages[0].content[1]).includes(SECRET), true, "base64 image data is skipped");
  // The only surviving occurrence of the value is inside the skipped base64 payload.
  assert.equal(JSON.stringify(result).includes(SECRET), JSON.stringify(result.messages[0].content[1]).includes(SECRET));
});

test("pasted secrets are masked at the input boundary", async () => {
  const { pi, ctx } = await setup();
  const text = `here is my key sk-${"a".repeat(32)}`;
  const result = await pi.emit("input", { type: "input", text, source: "interactive" }, ctx);
  assert.equal(result?.action, "transform");
  assert.equal(result.text.includes("sk-"), false);
  assert.match(result.text, /__SECRET_OPENAI__/);
});

test("configured format: yaml keys are filtered by name", async () => {
  const { pi, dir, ctx } = await setup();
  const path = join(dir, "config", "prod.yaml");
  writeFileSync(path, ["service: web", "apiKey: yaml-secret-value", "port: 8080", ""].join("\n"));
  await pi.emit("tool_call", { type: "tool_call", toolCallId: "11", toolName: "read", input: { path } }, ctx);
  const event = {
    type: "tool_result",
    toolCallId: "11",
    toolName: "read",
    input: { path },
    isError: false,
    content: [{ type: "text", text: ["service: web", "apiKey: yaml-secret-value", "port: 8080", ""].join("\n") }],
  };
  await pi.emit("tool_result", event, ctx);
  const text = event.content[0].text;
  assert.equal(text.includes("yaml-secret-value"), false);
  assert.match(text, /apiKey: __SECRET_apiKey__/);
  assert.match(text, /port: 8080/);
  assert.match(text, /service: __SECRET_service__/, "unclassified keys fail closed");
});

test("grep output over a redact-listed file keeps structure but masks values", async () => {
  const { pi, dir, ctx } = await setup();
  const path = join(dir, ".env.production");
  const event = {
    type: "tool_result",
    toolCallId: "12",
    toolName: "grep",
    input: { path, pattern: "PASSWORD" },
    isError: false,
    content: [{ type: "text", text: `${path}:3:DB_PASSWORD=${SECRET}` }],
  };
  await pi.emit("tool_result", event, ctx);
  assert.equal(event.content[0].text.includes(SECRET), false);
  assert.match(event.content[0].text, /DB_PASSWORD=__SECRET_DB_PASSWORD__$/);
});

test("rotated .env value: new value masked, already-seen old value stays masked", async () => {
  const { pi, dir, ctx } = await setup();

  // The old value shows up in a tool result once, so its token is already in the transcript.
  const before = {
    type: "tool_result",
    toolCallId: "13a",
    toolName: "bash",
    input: { command: "env" },
    isError: false,
    content: [{ type: "text", text: `old=${SECRET}\n` }],
  };
  await pi.emit("tool_result", before, ctx);
  assert.equal(before.content[0].text.includes(SECRET), false);

  const file = join(dir, ".env.production");
  writeFileSync(file, ["NODE_ENV=production", "DB_PASSWORD=" + ROTATED, ""].join("\n"));
  const { utimesSync } = await import("node:fs");
  const future = Date.now() / 1000 + 5;
  utimesSync(file, future, future);

  await pi.commands.get("secret-reload").handler("", ctx);

  const after = {
    type: "tool_result",
    toolCallId: "13b",
    toolName: "bash",
    input: { command: "env" },
    isError: false,
    content: [{ type: "text", text: `old=${SECRET}\nnew=${ROTATED}\n` }],
  };
  await pi.emit("tool_result", after, ctx);
  assert.equal(after.content[0].text.includes(ROTATED), false, "new value is masked");
  assert.equal(after.content[0].text.includes(SECRET), false, "seen value survives file-source pruning");
});

test("request_secret registers a value and hands back only a token", async () => {
  const { pi, ctx } = await setup();
  const tool = pi.tools.get("request_secret");
  assert.ok(tool, "request_secret is registered");
  const localCtx = { ...ctx, ui: { ...ctx.ui, input: async () => "  typed-secret-value  " } };
  const result = await tool.execute("id", { name: "MY_TOKEN" }, undefined, undefined, localCtx);
  const text = result.content[0].text;
  assert.match(text, /__SECRET_MY_TOKEN__/);
  assert.equal(text.includes("typed-secret-value"), false);

  const outbound = {
    type: "tool_result",
    toolCallId: "14",
    toolName: "bash",
    input: { command: "env" },
    isError: false,
    content: [{ type: "text", text: "MY_TOKEN=typed-secret-value" }],
  };
  await pi.emit("tool_result", outbound, ctx);
  assert.match(outbound.content[0].text, /MY_TOKEN=__SECRET_MY_TOKEN__/);
});

test("every tokenized value is masked everywhere else too (bash, logs, grep)", async () => {
  const { pi, ctx } = await setup();
  const bash = {
    type: "tool_result",
    toolCallId: "16",
    toolName: "bash",
    input: { command: "cat .env.production" },
    isError: false,
    content: [{ type: "text", text: "API_KEY=abc123\nDB_HOST=db.internal\nADMIN_TOKEN=456789\n" }],
  };
  await pi.emit("tool_result", bash, ctx);
  const out = bash.content[0].text;
  assert.equal(out.includes("abc123"), false, "short token-ish value must not survive");
  assert.equal(out.includes("db.internal"), false);
  assert.equal(out.includes("456789"), false);
  assert.match(out, /API_KEY=__SECRET_API_KEY__/);
});

test("values we refuse to mask globally stay readable", async () => {
  const { pi, dir, ctx } = await setup();

  // Both lines are tokenized in the file view (fail-closed key names), but masking the word
  // "production" or the bare number 1234 across all text would mangle ordinary content.
  const bash = {
    type: "tool_result",
    toolCallId: "17",
    toolName: "bash",
    input: { command: "cat .env.production" },
    isError: false,
    content: [{ type: "text", text: "SOME_FLAG=production\nWORKER_ID=1234\n" }],
  };
  await pi.emit("tool_result", bash, ctx);
  assert.match(bash.content[0].text, /SOME_FLAG=production/);
  assert.match(bash.content[0].text, /WORKER_ID=1234/);

  const read = {
    type: "tool_result",
    toolCallId: "18",
    toolName: "read",
    input: { path: join(dir, ".env.production") },
    isError: false,
    content: [{ type: "text", text: "SOME_FLAG=production\n" }],
  };
  await pi.emit("tool_result", read, ctx);
  assert.match(read.content[0].text, /SOME_FLAG=__SECRET_SOME_FLAG__/, "read view still fails closed");
});

test("masking failure aborts the request instead of shipping the payload", async () => {
  const { pi, ctx } = await setup();
  let aborted = false;
  const localCtx = { ...ctx, abort: () => (aborted = true) };
  const payload: any = { instructions: "hello" };
  Object.defineProperty(payload, "messages", {
    get() {
      throw new Error("boom");
    },
    enumerable: true,
  });
  await pi.emit("before_provider_request", { type: "before_provider_request", payload }, localCtx);
  assert.equal(aborted, true, "fail-closed: no unmasked payload may leave");
});

test("masking failure blinds every string, however deep, and returns the payload", async () => {
  const { pi, ctx } = await setup();
  let aborted = false;
  const localCtx = { ...ctx, abort: () => (aborted = true) };
  let deep: any = { text: SECRET };
  for (let index = 0; index < 40; index += 1) deep = { child: deep };
  const boom: any = {};
  Object.defineProperty(boom, "bad", {
    get() {
      throw new Error("boom");
    },
    enumerable: true,
  });
  const payload: any = { system: "sys", messages: [deep, boom] };
  const result = await pi.emit("before_provider_request", { type: "before_provider_request", payload }, localCtx);
  assert.equal(aborted, true, "the turn is aborted");
  assert.notEqual(result, undefined, "undefined would tell the host to keep the original payload");
  assert.equal(JSON.stringify(result).includes(SECRET), false, "nothing survives the blinding, at any depth");
});

test("a tool result whose masking threw is replaced by a marker", async () => {
  const { pi, ctx } = await setup();
  const blocks: any[] = [{ type: "text", text: `DB_PASSWORD=${SECRET}` }, { type: "text" }];
  Object.defineProperty(blocks[1], "text", {
    get() {
      throw new Error("boom");
    },
    enumerable: true,
  });
  const event: any = {
    type: "tool_result",
    toolCallId: "41",
    toolName: "bash",
    isError: false,
    input: { command: "env" },
    content: blocks,
    details: { echoed: `DB_PASSWORD=${SECRET}` },
  };
  await pi.emit("tool_result", event, ctx);
  assert.equal(event.content.length, 1);
  assert.match(event.content[0].text, /masking failed/);
  assert.equal(JSON.stringify(event).includes(SECRET), false, "no original text survives a failed result");
});

test("compaction and tree summaries are masked before they reach the summarizer", async () => {
  const { pi, ctx } = await setup();

  const prep: any = {
    messagesToSummarize: [{ role: "user", content: [{ type: "text", text: `key ${SECRET}` }] }],
    turnPrefixMessages: [{ role: "bashExecution", command: `echo ${SECRET}`, output: `o ${SECRET}` }],
    previousSummary: `old ${SECRET}`,
  };
  const compactEvent: any = { type: "session_before_compact", preparation: prep, customInstructions: `use ${SECRET}` };
  await pi.emit("session_before_compact", compactEvent, ctx);
  assert.equal(JSON.stringify(prep).includes(SECRET), false, "preparation masked in place");
  assert.equal(compactEvent.customInstructions.includes(SECRET), false);
  assert.match(compactEvent.customInstructions, /__SECRET_DB_PASSWORD__/);

  const treePrep: any = {
    entriesToSummarize: [
      { type: "branch_summary", summary: `x ${SECRET}` },
      { type: "message", message: { role: "user", content: `y ${SECRET}` } },
    ],
    customInstructions: `use ${SECRET}`,
  };
  const result = await pi.emit("session_before_tree", { type: "session_before_tree", preparation: treePrep }, ctx);
  assert.equal(JSON.stringify(treePrep).includes(SECRET), false);
  assert.equal(result?.customInstructions.includes(SECRET), false, "tree instructions override is masked");
  assert.match(result.customInstructions, /__SECRET_DB_PASSWORD__/);
});

test("a symlink cannot bypass a redact rule", async () => {
  const { pi, dir, ctx } = await setup();
  const event = {
    type: "tool_result",
    toolCallId: "19",
    toolName: "read",
    input: { path: join(dir, "prod-link.env") },
    isError: false,
    // SOME_FLAG is not masked by value (benign word), so a token proves the rule applied.
    content: [{ type: "text", text: "SOME_FLAG=production\n" }],
  };
  await pi.emit("tool_result", event, ctx);
  assert.match(event.content[0].text, /SOME_FLAG=__SECRET_SOME_FLAG__/, "rule resolves through the link target");

  const blocked = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "20", toolName: "read", input: { path: join(dir, "prod-link.env") } },
    ctx,
  );
  assert.equal(blocked, undefined, "redact file via link is readable (as a redacted view)");
});

test("grep results are judged per matched file, not by the search root", async () => {
  const { pi, dir, ctx } = await setup();
  const event = {
    type: "tool_result",
    toolCallId: "21",
    toolName: "grep",
    isError: false,
    input: { path: dir, pattern: "=" },
    content: [
      {
        type: "text",
        text: [
          `${join(dir, ".env.production")}:6:SOME_FLAG=production`,
          `${join(dir, "blocked.env")}:1:TOKEN=${SECRET}`,
          `${join(dir, "app.log")}:1:connecting with ${SECRET}`,
        ].join("\n"),
      },
    ],
  };
  await pi.emit("tool_result", event, ctx);
  const lines = event.content[0].text.split("\n");
  assert.match(lines[0], /SOME_FLAG=__SECRET_SOME_FLAG__/, "redact file lines get the key filter");
  assert.match(lines[1], /\[blocked by secret-mask: deny rule\]/, "deny file lines are replaced");
  assert.equal(lines[1].includes(SECRET), false);
  assert.match(lines[2], /__SECRET_DB_PASSWORD__/, "other files only get the value net");
});

test("list command opens a scrollable overlay and closes on escape", async () => {
  const { pi, ctx } = await setup();
  const githubValue = `ghp_${"c".repeat(24)}`;
  await pi.emit(
    "tool_result",
    {
      type: "tool_result",
      toolCallId: "22",
      toolName: "bash",
      isError: false,
      input: { command: "env" },
      content: [{ type: "text", text: `GH=${githubValue}` }],
    },
    ctx,
  );
  await pi.emit(
    "tool_result",
    {
      type: "tool_result",
      toolCallId: "23",
      toolName: "bash",
      isError: false,
      input: { command: "gopass show infra/db" },
      content: [{ type: "text", text: "infra/db: hunter2-abc123\n" }],
    },
    ctx,
  );

  // Enough entries that the body cannot fit in one window, so scrolling gets exercised.
  const addName = [...pi.commands.keys()].find((name) => name.endsWith("-add"));
  assert.ok(addName, "the add command is registered");
  for (let index = 0; index < 30; index += 1) {
    await pi.commands.get(addName).handler(`DEMO_${index} demo-${index}-value9`, ctx);
  }

  const listName = [...pi.commands.keys()].find((name) => name.endsWith("-list"));
  assert.ok(listName, "the list command is registered");
  const handled = pi.commands.get(listName).handler("", ctx);

  const overlay = ctx.ui.overlays[0];
  assert.ok(overlay, "an overlay opened");
  assert.equal(overlay.options.overlay, true, "it is an overlay, not an editor widget");
  assert.equal(overlay.options.overlayOptions.anchor, "center");

  try {
    const first = overlay.component.render(100);
    const page = first.join("\n");
    assert.match(first[0], /^secret-mask · \d+ value\(s\)/, "header with the total");
    assert.match(page, /-- file \(\d+\)/, "file group");
    assert.match(page, /^ {2}\.env\./m, "the file a value came from is named");

    const footer = first[first.length - 1];
    assert.match(footer, /\d+-\d+ of \d+ · esc close/, "scroll footer");
    const total = Number(footer.match(/of (\d+)/)![1]);
    assert.ok(total > first.length, "the body is windowed, not truncated");

    const topLine = first[1];
    overlay.component.handleInput("\x1b[A");
    assert.equal(overlay.component.render(100)[1], topLine, "up at the top does nothing");
    overlay.component.handleInput("\x1b[6~");
    assert.notEqual(overlay.component.render(100)[1], topLine, "page down moves the window");
    assert.notEqual(overlay.closed, true, "still open while scrolling");

    // Everything stays reachable, which is the point of dropping the 10 line widget.
    overlay.component.handleInput("\x1b[F");
    const last = overlay.component.render(100);
    assert.match(last[last.length - 1], new RegExp(`of ${total} · esc close`), "end of the list");
    const whole = `${page}\n${last.join("\n")}`;
    assert.match(whole, /-- pattern \(1\)/, "the github-shaped value lands in the pattern group");
    assert.match(whole, /-- gopass \(1\)/, "gopass group");
    assert.match(whole, /-- manual \(30\)/, "manual group");
    assert.match(whole, /infra\/db/, "the store entry a value came from is named");
    const fileToken = ["__SECRET", "DB_PASSWORD__"].join("_");
    assert.ok(whole.includes(fileToken), "values are listed under their source");
  } finally {
    // The host's promise only settles through done(): a failed assertion must not leave it pending,
    // which would make the test runner wait forever.
    overlay.component.handleInput("\x1b");
    await handled;
  }
  assert.equal(overlay.closed, true, "escape closes the overlay");
});

test("list command falls back to a notice when the host has no overlay", async () => {
  const { pi, ctx } = await setup();
  await pi.emit(
    "tool_result",
    {
      type: "tool_result",
      toolCallId: "24",
      toolName: "bash",
      isError: false,
      input: { command: "gopass show infra/db" },
      content: [{ type: "text", text: "infra/db: hunter2-abc123\n" }],
    },
    ctx,
  );
  ctx.ui.custom = undefined;
  const listName = [...pi.commands.keys()].find((name) => name.endsWith("-list"));
  await pi.commands.get(listName).handler("", ctx);
  const message = ctx.ui.notices[ctx.ui.notices.length - 1];
  assert.match(message, /^secret-mask: \d+ value\(s\)/, "the tally is still reported");
});
test("secret-add command registers a session secret usable in bash", async () => {
  const { pi, ctx } = await setup();
  await pi.commands.get("secret-add").handler("DEPLOY_KEY d3pl0y-s3cr3t", ctx);
  const token = ["__SECRET", "DEPLOY_KEY__"].join("_");
  const input: any = { command: `deploy --key ${token}` };
  await pi.emit("tool_call", { type: "tool_call", toolCallId: "15", toolName: "bash", input }, ctx);
  assert.match(input.command, /^export PI_SECRET_DEPLOY_KEY='d3pl0y-s3cr3t'; /, "prologue carries the value");
  assert.ok(input.command.includes(`deploy --key "\${PI_SECRET_DEPLOY_KEY}"`), "quoted expansion");
  assert.equal(input.command.includes(token), false, "the token itself is gone");
});

test("bash: gopass output is registered and masked back out of the result", async () => {
  const { pi, ctx } = await setup();
  const value = "hunter2-must-not-leak";
  const event = {
    type: "tool_result",
    toolCallId: "23",
    toolName: "bash",
    isError: false,
    input: { command: "gopass show -o infra/db" },
    content: [{ type: "text", text: `${value}\n` }],
  };
  await pi.emit("tool_result", event, ctx);
  assert.equal(event.content[0].text.includes(value), false, "printed value is masked back out");
  assert.match(event.content[0].text, /GOPASS_INFRA_DB/, "registered under the entry name");
  assert.equal(event.content[0].text.includes("GOPASS_INFRA_DB_INFRA_DB"), false, "entry name not doubled");
  // The overlay stays open until it is closed, so this test takes the no-overlay path and checks the tally.
  ctx.ui.custom = undefined;
  await pi.commands.get("secret-list").handler("", ctx);
  const message = ctx.ui.notices[ctx.ui.notices.length - 1];
  assert.match(message, /gopass 1/, "the list command attributes it to gopass");
});

test("bash: a gopass entry with fields registers every field value", async () => {
  const { pi, ctx } = await setup();
  const event = {
    type: "tool_result",
    toolCallId: "24",
    toolName: "bash",
    isError: false,
    input: { command: "gopass show api/stripe" },
    content: [{ type: "text", text: "password: stripe-live-9999\nuser: stripe-bot\n" }],
  };
  await pi.emit("tool_result", event, ctx);
  assert.equal(event.content[0].text.includes("stripe-live-9999"), false, "field value masked");
  assert.match(event.content[0].text, /GOPASS_API_STRIPE_PASSWORD/, "field name kept in the token");
});

test("bash: gopass otp and listing subcommands stay untouched", async () => {
  const { pi, ctx } = await setup();
  const otp = {
    type: "tool_result",
    toolCallId: "25",
    toolName: "bash",
    isError: false,
    input: { command: "gopass otp -o infra/db" },
    content: [{ type: "text", text: "123456\n" }],
  };
  await pi.emit("tool_result", otp, ctx);
  assert.equal(otp.content[0].text, "123456\n", "rotating codes are left alone");
  const listing = {
    type: "tool_result",
    toolCallId: "26",
    toolName: "bash",
    isError: false,
    input: { command: "gopass ls" },
    content: [{ type: "text", text: "infra/db: 20 bytes\n" }],
  };
  await pi.emit("tool_result", listing, ctx);
  assert.equal(listing.content[0].text, "infra/db: 20 bytes\n", "entry listings are not values");
});

test("bash: single-line gopass output with a slash key is registered", async () => {
  const { pi, ctx } = await setup();
  const event = {
    type: "tool_result",
    toolCallId: "27",
    toolName: "bash",
    isError: false,
    input: { command: "gopass show infra/db" },
    content: [{ type: "text", text: "infra/db: hunter2-abc123\n" }],
  };
  await pi.emit("tool_result", event, ctx);
  assert.equal(event.content[0].text.includes("hunter2-abc123"), false, "value masked");
});

test("bash: gopass behind a compound command is still registered", async () => {
  const { pi, ctx } = await setup();
  const event = {
    type: "tool_result",
    toolCallId: "28",
    toolName: "bash",
    isError: false,
    input: { command: "cd /tmp/mask-smoke5 && gopass show infra/db" },
    content: [{ type: "text", text: "infra/db: hunter2-abc123\n" }],
  };
  await pi.emit("tool_result", event, ctx);
  assert.equal(event.content[0].text.includes("hunter2-abc123"), false, "value masked after cd &&");
});

test("bash: a pass-style entry registers its ${PI_SECRET_E2E_STUDENT_PASSWORD} line and its fields", async () => {
  const { pi, ctx } = await setup();
  const event = {
    type: "tool_result",
    toolCallId: "29",
    toolName: "bash",
    isError: false,
    input: { command: "gopass show prod/api" },
    content: [{ type: "text", text: "hunter2-abc123\nuser: bot-user\n# a comment\n" }],
  };
  await pi.emit("tool_result", event, ctx);
  const text = event.content[0].text;
  assert.equal(text.includes("hunter2-abc123"), false, "leading ${PI_SECRET_E2E_STUDENT_PASSWORD} line masked");
  assert.equal(text.includes("bot-user"), false, "named field masked");
  assert.match(text, /GOPASS_PROD_API/, "both use the entry name");
  assert.ok(text.includes("# a comment"), "comments are not values");
});

test("bash: output another command made is not attributed to the store", async () => {
  const { pi, ctx } = await setup();
  const text = "build-start\ninfra/db: hunter3-xyz789\n";
  const event = {
    type: "tool_result",
    toolCallId: "31",
    toolName: "bash",
    isError: false,
    input: { command: "echo build-start && gopass show infra/db" },
    content: [{ type: "text", text }],
  };
  await pi.emit("tool_result", event, ctx);
  assert.equal(event.content[0].text, text, "nothing harvested, so nothing masked");
});

test("bash: a store read piped into a consumer is still harvested", async () => {
  const { pi, ctx } = await setup();
  const event = {
    type: "tool_result",
    toolCallId: "32",
    toolName: "bash",
    isError: false,
    input: { command: "gopass show -o infra/db | cat" },
    content: [{ type: "text", text: "hunter3-xyz789\n" }],
  };
  await pi.emit("tool_result", event, ctx);
  assert.equal(event.content[0].text.includes("hunter3-xyz789"), false, "whole value masked");
  assert.match(event.content[0].text, /GOPASS_INFRA_DB/);
});

test("policy: word-like values stay out of global masking, credentials stay in", async () => {
  const { dir } = await setup();
  const { loadConfig, isMaskableValue } = await import("../src/policy.ts");
  const cfg = loadConfig(join(dir, "config.json"));
  assert.equal(
    isMaskableValue("devsecret", cfg, { shaped: false, sensitiveKey: true }),
    false,
    "a bare word must not be masked everywhere",
  );
  assert.equal(
    isMaskableValue("hunter2-xyz789", cfg, { shaped: false, sensitiveKey: false }),
    true,
    "digits and punctuation mark a credential",
  );
  assert.equal(
    isMaskableValue("averylonglettersaltonlyhere", cfg, { shaped: false, sensitiveKey: true }),
    true,
    "length under a sensitive key still counts",
  );
});

test("injection notice is loud for project values and quiet for machinery", async () => {
  const { pi, ctx } = await setup();
  const dbToken = ["__SECRET", "DB_PASSWORD__"].join("_");
  const projectCall: any = {
    type: "tool_call",
    toolCallId: "50",
    toolName: "bash",
    input: { command: `psql "${dbToken}"` },
  };
  await pi.emit("tool_call", projectCall, ctx);
  assert.match(projectCall.input.command, /^export PI_SECRET_DB_PASSWORD='/);
  assert.match(ctx.ui.notices.join("\n"), /injected PI_SECRET_DB_PASSWORD/, "project value announced");

  // A value that only a tool produced (pattern hit in a tool result) is machinery, not business.
  const githubValue = `ghp_${"d".repeat(24)}`;
  await pi.emit(
    "tool_result",
    {
      type: "tool_result",
      toolCallId: "51",
      toolName: "bash",
      isError: false,
      input: { command: "env" },
      content: [{ type: "text", text: `GH=${githubValue}` }],
    },
    ctx,
  );
  const githubToken = ctx.ui.notices.length;
  const machineryCall: any = {
    type: "tool_call",
    toolCallId: "52",
    toolName: "bash",
    input: { command: `curl -H "Auth: ${["__SECRET", "GITHUB__"].join("_")}" localhost` },
  };
  await pi.emit("tool_call", machineryCall, ctx);
  assert.match(machineryCall.input.command, /PI_SECRET_GITHUB/, "still rewritten");
  assert.equal(
    ctx.ui.notices.slice(githubToken).join("\n").includes("injected"),
    false,
    "machinery value stays quiet",
  );
});

test("on sight: plain urls and hyphenated words are left alone", async () => {
  const { pi, ctx } = await setup({ prime: false });
  const text = ["API_URL=https://api.example/v1", "API_TOKEN=foo-bar", "API_TOKEN=hunter2-abc123"].join("\n");
  const event: any = {
    type: "tool_result",
    toolCallId: "60",
    toolName: "bash",
    isError: false,
    input: { command: "env" },
    content: [{ type: "text", text }],
  };
  await pi.emit("tool_result", event, ctx);
  const out = event.content[0].text;
  assert.ok(out.includes("API_URL=https://api.example/v1"), "a url without userinfo is not a secret");
  assert.ok(out.includes("API_TOKEN=foo-bar"), "a hyphenated word is not a secret");
  assert.equal(out.includes("hunter2-abc123"), false, "a credential-shaped value still is");
});

test("tool details are masked like content", async () => {
  const { pi, ctx } = await setup();
  const event: any = {
    type: "tool_result",
    toolCallId: "61",
    toolName: "bash",
    isError: false,
    input: { command: "psql" },
    content: [{ type: "text", text: "ok" }],
    details: { request: { url: `postgres://u:${SECRET}@db/app` } },
  };
  await pi.emit("tool_result", event, ctx);
  assert.equal(JSON.stringify(event.details).includes(SECRET), false, "details are masked too");
});

test("session scope: a toggle and the registry do not survive into the next session", async () => {
  const { pi, ctx } = await setup();
  const toggle = pi.commands.get("secret-toggle")!;
  await toggle.handler("off", ctx);
  assert.equal(ctx.ui.statuses.get("secret-mask"), "mask: false");

  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx);
  assert.equal(ctx.ui.statuses.get("secret-mask"), "mask: on", "masking is on again");

  const event: any = {
    type: "tool_result",
    toolCallId: "62",
    toolName: "bash",
    isError: false,
    input: { command: "env" },
    content: [{ type: "text", text: `DB_PASSWORD=${SECRET}` }],
  };
  await pi.emit("tool_result", event, ctx);
  assert.equal(event.content[0].text.includes(SECRET), false, "masking works after the reset");
});

test("reload drops the values of a file that is gone", async () => {
  const { pi, ctx, dir } = await setup();
  const reload = pi.commands.get("secret-reload")!;
  await reload.handler("", ctx);
  const readSize = (): number => Number(/secret-mask: (\d+) value/.exec(ctx.ui.notices[ctx.ui.notices.length - 1]!)![1]);
  const before = readSize();
  assert.ok(before > 0, "the primed file contributed values");

  rmSync(join(dir, ".env.production"));
  await reload.handler("", ctx);
  assert.ok(readSize() < before, `stale values dropped (${before} -> ${readSize()})`);
});
