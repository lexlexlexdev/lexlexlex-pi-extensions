import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Card rendering machinery lives in lexlexlex-tool-cards.ts so that
// lexlexlex-permission-gates (which owns the overridden `bash` tool) can
// attach identical renderers to its own bash registration.
import { cardRenderCall, cardRenderResult } from "./lexlexlex-tool-cards.ts";

type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

type BuiltinToolsModule = {
	createToolDefinition: (name: ToolName, cwd: string) => any;
};

const TOOL_NAMES: ToolName[] = ["read", "bash", "grep", "find", "ls"];

async function loadBuiltinToolFactory(): Promise<BuiltinToolsModule> {
	const candidates = [
		process.argv[1] ? join(dirname(process.argv[1]), "core/tools/index.js") : undefined,
		join(dirname(fileURLToPath(import.meta.url)), "../../npm/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js"),
		"/Users/aveaxii/.local/share/fnm/node-versions/v24.14.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js",
	].filter((candidate): candidate is string => Boolean(candidate));

	const toolsModulePath = candidates.find((candidate) => existsSync(candidate));
	if (!toolsModulePath) {
		throw new Error(`Could not locate Pi built-in tools module. Tried: ${candidates.join(", ")}`);
	}

	return (await import(pathToFileURL(toolsModulePath).href)) as BuiltinToolsModule;
}

export default async function lexlexlexToolRender(pi: ExtensionAPI) {
	const { createToolDefinition } = await loadBuiltinToolFactory();

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// Tools already overridden by another extension (e.g. bash owned by
		// lexlexlex-permission-gates) must not be clobbered here — same-name
		// registration replaces the whole definition. Those owners attach the
		// shared card renderers themselves.
		const externallyOwned = new Set(
			pi.getAllTools()
				.filter((tool) => TOOL_NAMES.includes(tool.name as ToolName))
				.filter((tool) => (tool.sourceInfo?.source ?? "builtin") !== "builtin")
				.map((tool) => tool.name),
		);

		for (const toolName of TOOL_NAMES) {
			if (externallyOwned.has(toolName)) continue;
			const tool = createToolDefinition(toolName, ctx.cwd);
			pi.registerTool({
				...tool,
				renderCall: (args, theme, context) => cardRenderCall(toolName, args, theme, context),
				renderResult: (result, options, theme, context) => cardRenderResult(toolName, result, options, theme, context),
			});
		}
	});
}
