import { complete, getModel, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Model } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ModelChoice = "openai-codex/gpt-5.6-luna";

type CommitItem = { branch: string; message: string; hash: string; files: string[] };

const GCM_REPORT_TYPE = "lexlexlex-gcm-report";

const MODEL_CHOICES: Record<ModelChoice, { provider: "openai-codex"; id: string; thinking: "medium" }> = {
  "openai-codex/gpt-5.6-luna": { provider: "openai-codex", id: "gpt-5.6-luna", thinking: "medium" },
};

const MESSAGE_PROMPT = `You generate one git commit message from a diff.
Rules:
- Output ONLY one commit message line.
- The example commit messages from this project's history are AUTHORITATIVE: copy their naming convention exactly (style, type prefixes, scope usage, tense, casing).
- Only if no history examples are provided, fall back to conventional commits format: type(scope): summary
- Keep <= 72 chars unless Custom instructions explicitly say otherwise.
- Use imperative mood.
- No markdown, no quotes.`;

const PLAN_PROMPT = `You split file changes into git commits.
Return STRICT JSON only:
{"commits":[{"files":["path/a","path/b"]}]}
Rules:
- YOU decide how many commits are appropriate. There is no preferred number.
- Group files by logical zone: separate features, bugfixes, refactors, docs, config/chores, generated artifacts.
- NEVER throw unrelated zones into one commit. When in doubt between one or two commits, split.
- A single commit is correct ONLY if all files truly belong to one logical change.
- Recent commit messages are provided so you can see what granularity and style this project uses.
- Use only provided file paths
- Cover all files exactly once`;

async function getRecentCommitSubjects(repoPath: string): Promise<string[]> {
  try {
    const log = await runGit(repoPath, ["log", "--pretty=format:%s", "-n", "10"]);
    return `${log.stdout || ""}`.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const ToolParams = Type.Object({
  repoPath: Type.String({ description: "Path to a git repository" }),
  customInstructions: Type.Optional(Type.String({ description: "Optional custom instructions for commit message generation" })),
  branchName: Type.Optional(Type.String({ description: "Optional branch name to commit to" })),
});

type ToolInput = { repoPath: string; customInstructions?: string; branchName?: string };

type GcmDetails = {
  repoPath: string;
  repoName?: string;
  branchRequested?: string;
  customInstructions?: string;
  branchUsed?: string;
  branchStatus?: string;
  commits?: CommitItem[];
  modelSelected: ModelChoice;
  modelUsed?: string;
  modelTried: string[];
  diffBytes?: number;
  errorCode?: string;
  debug?: string;
};

type GcmResult = { ok: boolean; message: string; details: GcmDetails };

async function runGit(repoPath: string, args: string[]) {
  return execFileAsync("git", ["-C", repoPath, ...args], { maxBuffer: 8 * 1024 * 1024 });
}

function getSelectedModel(ctx: ExtensionContext): ModelChoice {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom" || entry.customType !== "gcm-model") continue;
    const selected = (entry.data as { selected?: string } | undefined)?.selected;
    if (selected === "openai-codex/gpt-5.6-luna") return selected;
  }
  return "openai-codex/gpt-5.6-luna";
}

function parseArgs(raw: string): { repoPath: string; customInstructions?: string; branchName?: string } | null {
  const matches = raw.match(/"[^"]+"|'[^']+'|\S+/g);
  if (!matches || matches.length === 0) return null;
  const tokens = matches.map((t) => t.replace(/^['"]|['"]$/g, ""));
  const repoPath = tokens[0].startsWith("@") ? tokens[0].slice(1) : tokens[0];
  if (tokens.length === 1) return { repoPath };
  if (tokens.length === 2) return { repoPath, customInstructions: tokens[1] };
  return { repoPath, customInstructions: tokens[1], branchName: tokens[2] };
}

function buildErrorMessage(base: string, details: GcmDetails): string {
  const model = details.modelUsed ?? details.modelSelected;
  const lines = [
    base,
    `error_code=${details.errorCode ?? "unknown"}`,
    `model=${model}`,
    `repo=${details.repoPath}`,
    `branch_requested=${details.branchRequested ?? "(none)"}`,
    `branch_used=${details.branchUsed ?? "(unknown)"}`,
    `diff_bytes=${details.diffBytes ?? 0}`,
    `tried=${details.modelTried.join(",") || "none"}`,
  ];
  if (details.debug) lines.push(`debug=${details.debug}`);
  return lines.join("\n");
}

async function resolveBranch(repoPath: string, requested?: string): Promise<{ ok: true; branchUsed: string } | { ok: false; code: string; debug: string }> {
  if (requested) {
    try {
      await runGit(repoPath, ["checkout", requested]);
      return { ok: true, branchUsed: requested };
    } catch (e) {
      return { ok: false, code: "branch_checkout_failed", debug: e instanceof Error ? e.message : "checkout failed" };
    }
  }
  try {
    const head = await runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return { ok: true, branchUsed: `${head.stdout || ""}`.trim() || "HEAD" };
  } catch (e) {
    return { ok: false, code: "branch_detect_failed", debug: e instanceof Error ? e.message : "branch detect failed" };
  }
}

async function getAllChangedFiles(repoPath: string): Promise<string[]> {
  const [staged, unstaged, untracked] = await Promise.all([
    runGit(repoPath, ["diff", "--name-only", "--cached"]),
    runGit(repoPath, ["diff", "--name-only"]),
    runGit(repoPath, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  const files = new Set<string>();
  for (const chunk of [staged.stdout, unstaged.stdout, untracked.stdout]) {
    `${chunk || ""}`
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((f) => files.add(f));
  }
  return [...files];
}

async function generateMessage(
  model: Model,
  thinking: "medium",
  diff: string,
  history: string[],
  customInstructions: string | undefined,
  auth: { apiKey: string; headers?: Record<string, string> },
  signal?: AbortSignal,
): Promise<string> {
  const sections: string[] = [];
  if (history.length > 0) {
    sections.push(`Example commit messages from this project (follow their convention):\n${history.map((h) => `- ${h}`).join("\n")}`);
  }
  if (customInstructions?.trim()) {
    sections.push(`Custom instructions:\n${customInstructions.trim()}`);
  }
  sections.push(`Diff:\n${diff.slice(0, 120000)}`);
  const userText = sections.join("\n\n");

  const response = await complete(
    model,
    {
      systemPrompt: MESSAGE_PROMPT,
      messages: [{ role: "user", timestamp: Date.now(), content: [{ type: "text", text: userText }] } as UserMessage],
      thinkingLevel: thinking,
    },
    { apiKey: auth.apiKey, headers: auth.headers, signal },
  );

  return (
    response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim()
      .split("\n")[0]
      ?.trim() || ""
  );
}

async function buildPlan(model: Model, thinking: "medium", files: string[], history: string[], auth: { apiKey: string; headers?: Record<string, string> }, signal?: AbortSignal): Promise<string[][]> {
  const payload: Record<string, unknown> = { files };
  if (history.length > 0) payload.recentCommits = history.slice(0, 20);

  const response = await complete(
    model,
    {
      systemPrompt: PLAN_PROMPT,
      messages: [{ role: "user", timestamp: Date.now(), content: [{ type: "text", text: JSON.stringify(payload) }] } as UserMessage],
      thinkingLevel: thinking,
    },
    { apiKey: auth.apiKey, headers: auth.headers, signal },
  );

  const raw = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  try {
    const parsed = JSON.parse(raw) as { commits?: Array<{ files?: string[] }> };
    const commits = (parsed.commits || []).map((c) => (c.files || []).filter(Boolean));
    if (commits.length === 0) return [files];

    const allowed = new Set(files);
    const seen = new Set<string>();
    for (const group of commits) {
      for (const f of group) {
        if (!allowed.has(f)) return [files];
        if (seen.has(f)) return [files];
        seen.add(f);
      }
    }
    if (seen.size !== files.length) return [files];
    return commits;
  } catch {
    return [files];
  }
}

async function getBranchStatus(repoPath: string): Promise<string> {
  try {
    const status = await runGit(repoPath, ["status", "--porcelain=2", "--branch"]);
    const lines = `${status.stdout || ""}`.split("\n").map((line) => line.trim());
    const abLine = lines.find((line) => line.startsWith("# branch.ab "));
    if (abLine) {
      const match = abLine.match(/# branch\.ab \+(-?\d+) -(-?\d+)/);
      if (match) return `ahead ${match[1]}, behind ${match[2]}`;
    }

    const upstreamLine = lines.find((line) => line.startsWith("# branch.upstream "));
    if (!upstreamLine) return "no upstream";
    return "up to date";
  } catch {
    return "unknown";
  }
}

async function stageFiles(repoPath: string, files: string[]): Promise<{ ok: true } | { ok: false; code: string; debug: string }> {
  try {
    await runGit(repoPath, ["reset", "--", "."]);
    if (files.length > 0) await runGit(repoPath, ["add", "-A", "--", ...files]);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: "git_stage_failed", debug: e instanceof Error ? e.message : "stage failed" };
  }
}

async function commitStaged(repoPath: string, message: string): Promise<{ ok: true; hash: string } | { ok: false; code: string; debug: string }> {
  try {
    await runGit(repoPath, ["commit", "-m", message]);
    const hash = await runGit(repoPath, ["rev-parse", "--short", "HEAD"]);
    return { ok: true, hash: `${hash.stdout || ""}`.trim() || "unknown" };
  } catch (e) {
    return { ok: false, code: "git_commit_failed", debug: e instanceof Error ? e.message : "commit failed" };
  }
}

async function generateAndCommit(
  repoPathRaw: string,
  customInstructions: string | undefined,
  branchName: string | undefined,
  selectedModel: ModelChoice,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<GcmResult> {
  const repoPath = resolve(repoPathRaw);
  const normalizedInstructions = customInstructions?.trim() || undefined;
  const modelTried: string[] = [];
  const baseDetails: GcmDetails = {
    repoPath,
    repoName: basename(repoPath),
    branchRequested: branchName,
    customInstructions: normalizedInstructions,
    modelSelected: selectedModel,
    modelTried,
  };

  try {
    if (!existsSync(repoPath)) {
      const details = { ...baseDetails, errorCode: "path_missing" };
      return { ok: false, message: buildErrorMessage("Path does not exist.", details), details };
    }

    try {
      await runGit(repoPath, ["rev-parse", "--is-inside-work-tree"]);
    } catch (e) {
      const details = { ...baseDetails, errorCode: "not_git_repo", debug: e instanceof Error ? e.message : "git check failed" };
      return { ok: false, message: buildErrorMessage("Invalid git repository path.", details), details };
    }

    const branchResult = await resolveBranch(repoPath, branchName);
    if (!branchResult.ok) {
      const details = { ...baseDetails, errorCode: branchResult.code, debug: branchResult.debug };
      return { ok: false, message: buildErrorMessage("Failed to prepare branch.", details), details };
    }
    baseDetails.branchUsed = branchResult.branchUsed;

    const history = await getRecentCommitSubjects(repoPath);

    const files = await getAllChangedFiles(repoPath);
    if (files.length === 0) {
      const details = { ...baseDetails, errorCode: "no_changes", diffBytes: 0 };
      return { ok: false, message: buildErrorMessage("No changes found.", details), details };
    }

    const selected = MODEL_CHOICES[selectedModel];
    const model = getModel(selected.provider, selected.id);
    if (!model) {
      const details = { ...baseDetails, errorCode: "model_unavailable" };
      return { ok: false, message: buildErrorMessage("Selected model is unavailable.", details), details };
    }

    const modelKey = `${model.provider}/${model.id}`;
    modelTried.push(modelKey);

    const authResult = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!authResult.ok || !authResult.apiKey) {
      const details = { ...baseDetails, modelUsed: modelKey, errorCode: "auth_missing", debug: authResult.ok ? "api key is missing" : authResult.error };
      return { ok: false, message: buildErrorMessage("Selected model auth is not configured.", details), details };
    }
    const auth = { apiKey: authResult.apiKey, headers: authResult.headers };

    const plan = await buildPlan(model, selected.thinking, files, history, auth, signal);
    const commits: CommitItem[] = [];

    for (const group of plan) {
      const staged = await stageFiles(repoPath, group);
      if (!staged.ok) {
        const details = { ...baseDetails, modelUsed: modelKey, errorCode: staged.code, debug: staged.debug };
        return { ok: false, message: buildErrorMessage("Failed to stage files.", details), details };
      }

      const stagedDiff = await runGit(repoPath, ["diff", "--cached", "--", "."]);
      const diffText = `${stagedDiff.stdout || ""}`.trim();
      if (!diffText) continue;

      let message = "";
      try {
        message = await generateMessage(model, selected.thinking, diffText, history, normalizedInstructions, auth, signal);
      } catch (e) {
        const details = { ...baseDetails, modelUsed: modelKey, errorCode: "model_request_failed", debug: e instanceof Error ? e.message : "message generation failed" };
        return { ok: false, message: buildErrorMessage("Model request failed.", details), details };
      }

      if (!message) {
        const details = { ...baseDetails, modelUsed: modelKey, errorCode: "empty_response" };
        return { ok: false, message: buildErrorMessage("Model returned empty text response.", details), details };
      }

      const committed = await commitStaged(repoPath, message);
      if (!committed.ok) {
        const details = { ...baseDetails, modelUsed: modelKey, errorCode: committed.code, debug: committed.debug };
        return { ok: false, message: buildErrorMessage("git commit failed.", details), details };
      }

      commits.push({ branch: branchResult.branchUsed, message, hash: committed.hash, files: group });
    }

    if (commits.length === 0) {
      const details = { ...baseDetails, modelUsed: modelKey, errorCode: "no_commits_created" };
      return { ok: false, message: buildErrorMessage("No commits were created.", details), details };
    }

    const details: GcmDetails = { ...baseDetails, modelUsed: modelKey, branchStatus: await getBranchStatus(repoPath), commits };
    const summary = commits.map((c, i) => `${i + 1}. ${c.message} (${c.hash})`).join("\n");
    return { ok: true, message: summary, details };
  } catch (e) {
    const details = { ...baseDetails, errorCode: "unexpected_exception", debug: e instanceof Error ? e.message : "unknown" };
    return { ok: false, message: buildErrorMessage("Unexpected error.", details), details };
  }
}

export default function gcmExtension(pi: ExtensionAPI) {
  pi.registerMessageRenderer(GCM_REPORT_TYPE, (message, _options, theme) => {
    const details = message.details as { repoName?: string; branchUsed?: string; branchStatus?: string; commits?: CommitItem[] } | undefined;
    const commits = details?.commits || [];

    let out = theme.fg("accent", theme.bold("GCM Report"));
    if (details?.repoName) out += `\n${theme.fg("dim", "repo:")} ${theme.fg("text", details.repoName)}`;
    if (details?.branchUsed) out += `\n${theme.fg("dim", "branch:")} ${theme.fg("text", details.branchUsed)}`;
    if (details?.branchStatus) out += `\n${theme.fg("dim", "status:")} ${theme.fg("text", details.branchStatus)}`;
    if (commits.length === 0) {
      out += `\n${theme.fg("dim", "No commits to report")}`;
      return new Text(out, 0, 0);
    }

    for (const [idx, c] of commits.entries()) {
      out += `\n${theme.fg("muted", `#${idx + 1}`)}`;
      out += `\n${theme.fg("dim", "branch:")} ${theme.fg("text", c.branch)}`;
      out += `\n${theme.fg("dim", "message:")} ${theme.fg("text", c.message)}`;
      out += `\n${theme.fg("dim", "hash:")} ${theme.fg("text", c.hash)}`;
    }
    return new Text(out, 0, 0);
  });

  pi.registerTool({
    name: "get_commit_message",
    label: "Get Commit Message",
    description: "Generate commit message(s) and commit in repo (optional branch)",
    parameters: ToolParams,
    async execute(_toolCallId, params: ToolInput, signal, _onUpdate, ctx) {
      const selectedModel = getSelectedModel(ctx);
      const result = await generateAndCommit(params.repoPath, params.customInstructions, params.branchName, selectedModel, ctx, signal);
      return { content: [{ type: "text", text: result.message }], details: result.details, isError: !result.ok };
    },
    renderCall(args, theme) {
      const custom = args.customInstructions ? theme.fg("dim", " +custom") : "";
      const branch = args.branchName ? theme.fg("dim", ` @${args.branchName}`) : "";
      return new Text(theme.fg("toolTitle", theme.bold("gcm ")) + theme.fg("accent", args.repoPath) + custom + branch, 0, 0);
    },
    renderResult(result, _options, theme, context) {
      const details = result.details as GcmDetails | undefined;
      const marker = details?.modelUsed ? theme.fg("accent", `[${details.modelUsed}] `) : theme.fg("dim", `[${details?.modelSelected ?? "no-model"}] `);
      const text = result.content.find((c) => c.type === "text");
      const body = text?.type === "text" ? text.text : "";
      return new Text(marker + (context.isError ? theme.fg("error", body) : theme.fg("success", body)), 0, 0);
    },
  });

  pi.registerCommand("gcm", {
    description: "Generate+commit: /gcm [path-to-git-repo] ['initial custom instructions'] ['branch-name']",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args.trim());
      if (!parsed?.repoPath) {
        ctx.ui.notify("Usage: /gcm [path-to-git-repo] ['initial custom instructions'] ['branch-name']", "error");
        return;
      }

      let customInstructions = parsed.customInstructions?.trim() || "";
      if (ctx.hasUI) {
        const edited = await ctx.ui.editor(
          "GCM custom instructions",
          customInstructions,
        );
        if (edited === undefined) {
          ctx.ui.notify("/gcm cancelled", "info");
          return;
        }
        customInstructions = edited.trim();
      }

      const selectedModel = getSelectedModel(ctx);
      const suffix = parsed.branchName ? ` on ${parsed.branchName}` : "";
      const customSuffix = customInstructions ? " +custom instructions" : "";
      ctx.ui.notify(`Started /gcm (${selectedModel})${customSuffix}${suffix}`, "info");

      void generateAndCommit(parsed.repoPath, customInstructions || undefined, parsed.branchName, selectedModel, ctx)
        .then((result) => {
          if (!result.ok) {
            ctx.ui.notify(result.message, "error");
            return;
          }

          pi.sendMessage({
            customType: GCM_REPORT_TYPE,
            content: "gcm report",
            details: {
              repoName: result.details.repoName,
              branchUsed: result.details.branchUsed,
              branchStatus: result.details.branchStatus,
              commits: result.details.commits || [],
            },
            display: true,
          });

          ctx.ui.notify(`Created ${result.details.commits?.length || 0} commit(s).`, "info");
        })
        .catch((e) => {
          ctx.ui.notify(`gcm internal error: ${e instanceof Error ? e.message : "unknown"}`, "error");
        });
    },
  });

  pi.registerCommand("gcm-model", {
    description: "Select model for /gcm (gpt-5.6-luna)",
    handler: async (args, ctx) => {
      const raw = args.trim();
      const parse = (value: string): ModelChoice | null => {
        if (value === "luna" || value === "openai-codex/gpt-5.6-luna" || value === "openai/gpt-5.6-luna") return "openai-codex/gpt-5.6-luna";
        return null;
      };

      let selected: ModelChoice | null = parse(raw);
      if (!selected) {
        const picked = await ctx.ui.select("Select /gcm model", [
          "openai-codex/gpt-5.6-luna (current)",
        ]);
        if (!picked) return;
        selected = "openai-codex/gpt-5.6-luna";
      }

      pi.appendEntry("gcm-model", { selected });
      ctx.ui.notify(`gcm model set to ${selected}`, "info");
    },
  });
}
