import type {
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	AGENTS,
	isHarnessMode,
	MODE_STATE_ENTRY,
	MODES,
	resolveHarnessMode,
	taskAgentConfig,
	type HarnessMode,
} from "./config.js";
import { runChild, type AgentConfig, type ChildProgress } from "./runner.js";
import { registerWebTools } from "./web.js";

const PROMPTS = {
	oracle: [
		"You are an isolated, read-only expert oracle for difficult engineering judgment.",
		"Inspect only the local files needed to answer the delegated task; never modify files or run shell commands.",
		"Treat the caller's stated intent and constraints as the contract, but challenge unsupported assumptions.",
		"Return the recommendation first, then evidence, risks, and the smallest safe execution path.",
	].join(" "),
	finder: [
		"You are an isolated, read-only semantic codebase search specialist.",
		"Use multiple focused search passes to find and correlate code by behavior or concept without making changes.",
		"Stop once ownership and the relevant flow are clear.",
		"Return precise paths, symbols, line evidence, relationships, and the best starting point; do not return a search transcript.",
	].join(" "),
	reviewer: [
		"You are an isolated, independent, read-only code and plan reviewer.",
		"Review the stated intent before implementation details and report only evidence-backed findings, ordered by severity.",
		"Do not modify files or run shell commands. Ignore style unless it affects correctness.",
		"End with a clear ship or no-ship verdict and the smallest fix for each blocker.",
	].join(" "),
	librarian: [
		"You are an isolated external-code and primary-source research specialist.",
		"Use web_search to discover sources and read_web_page to inspect authoritative details.",
		"Do not use remote research for ordinary local workspace navigation.",
		"Return the answer in full with source URLs, then distinguish verified facts from uncertainty.",
	].join(" "),
	task: [
		"You are an isolated implementation subagent working in the caller's current workspace.",
		"Execute only the delegated outcome: inspect the relevant code, make the smallest correct changes, and run focused validation.",
		"Follow applicable AGENTS.md guidance, preserve unrelated worktree changes, and never commit, push, rewrite history, or perform destructive cleanup.",
		"Do not delegate further. Return a compact summary of the outcome, files changed, checks run, and any blocker.",
	].join(" "),
} as const;

export function buildHarnessPolicy(selectedTools: readonly string[] = []): string {
	const active = new Set(selectedTools);
	const lines = [
		"Work toward the requested outcome rather than stopping at a proposal unless the user asked for research, review, or planning only.",
		"Inspect enough local evidence to avoid guessing, prefer the smallest correct change, preserve unrelated worktree changes, and validate proportionally.",
		"Handle simple, localized work directly. Delegate only when an isolated context materially improves retrieval, judgment, review, or a known multi-step implementation.",
		"Every subagent starts fresh and returns only its final summary. Give it a self-contained goal, relevant paths and evidence, constraints, and the validation or output shape required; then inspect and integrate its result yourself.",
	];

	if (active.has("finder")) {
		lines.push("Use finder for conceptual or multi-module local code discovery; use direct local search for exact paths, symbols, or strings.");
	}
	if (active.has("librarian")) {
		lines.push("Use librarian for external repositories and dependency internals, never for first-party local code that can be read directly.");
	}
	if (active.has("oracle")) {
		lines.push("Use oracle selectively for hard judgment, subtle debugging, architecture, or high-impact review; its advice is read-only and must be checked against local evidence.");
	}
	if (active.has("reviewer")) {
		lines.push("Use reviewer after non-trivial changes when an independent intent-first review would materially reduce risk, not for routine edits.");
	}
	if (active.has("task")) {
		lines.push("Use task only after the implementation path is understood and the work is substantial enough to benefit from a fresh executor. It is a foreground single writer; inspect its diff and run the combined validation afterward.");
	}

	return `## Amp-Style Harness Policy\n\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

export async function applyMode(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	name: HarnessMode,
	persist = true,
): Promise<void> {
	const config = MODES[name];
	const model = ctx.modelRegistry.find(config.provider, config.model);
	if (!model) {
		throw new Error(`Harness mode ${name}: model ${config.provider}/${config.model} is unavailable`);
	}

	const modelChanged = ctx.model?.provider !== config.provider || ctx.model.id !== config.model;
	if (modelChanged && !(await pi.setModel(model))) {
		throw new Error(
			`Harness mode ${name}: authentication unavailable for ${config.provider}; use /login ${config.provider}`,
		);
	}
	if (modelChanged || ctx.thinkingLevel !== config.thinking) pi.setThinkingLevel(config.thinking);
	if (persist) pi.appendEntry(MODE_STATE_ENTRY, { mode: name });
}

interface ChildToolDetails {
	status: "running" | "completed";
	agent: string;
	model?: string;
	usage?: unknown;
	stderr?: string;
	progress?: ChildProgress;
}

function selector(config: AgentConfig): string {
	return `${config.provider}/${config.model}:${config.thinking}`;
}

function assertChildModelAvailable(ctx: ExtensionContext, name: string, config: AgentConfig): void {
	if (!ctx.modelRegistry.find(config.provider, config.model)) {
		throw new Error(`${name} requires ${selector(config)}, but that model is unavailable`);
	}
}

function progressText(name: string, progress: ChildProgress): string {
	if (progress.phase === "tool") {
		return `${name} is running ${progress.toolName ?? "a tool"} (${progress.completedTools} completed)`;
	}
	if (progress.phase === "responding") return `${name} is preparing its final result`;
	return `${name} is ${progress.phase} (${progress.completedTools} tools completed)`;
}

async function runAgentTool(
	name: string,
	config: AgentConfig,
	task: string,
	systemPrompt: string,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ChildToolDetails> | undefined,
	ctx: ExtensionContext,
) {
	try {
		assertChildModelAvailable(ctx, name, config);
		const result = await runChild(config, task, systemPrompt, signal, undefined, ctx.cwd, (progress) => {
			onUpdate?.({
				content: [{ type: "text", text: progressText(name, progress) }],
				details: { status: "running", agent: name, model: selector(config), progress },
			});
		});
		return {
			content: [{ type: "text" as const, text: result.text }],
			details: {
				status: "completed" as const,
				agent: name,
				model: result.model,
				usage: result.usage,
				stderr: result.stderr,
			},
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${message} ${name} is fixed to ${selector(config)}; no fallback was used.`);
	}
}

export default function harness(pi: ExtensionAPI): void {
	pi.registerFlag("harness-mode", {
		type: "string",
		description: "Harness mode: high or ultra",
	});

	const restore = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
		const flag = pi.getFlag("harness-mode");
		const flagMode = isHarnessMode(flag) ? flag : undefined;
		if (flag !== undefined && !flagMode) {
			ctx.ui.notify(`Invalid --harness-mode ${JSON.stringify(flag)}; expected high or ultra`, "error");
			ctx.shutdown();
			return;
		}

		const mode = resolveHarnessMode(flagMode, ctx.sessionManager.getBranch());
		try {
			await applyMode(pi, ctx, mode, false);
			ctx.ui.setStatus("harness-mode", ctx.ui.theme.fg("accent", `mode:${mode}`));
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			ctx.shutdown();
		}
	};

	pi.on("session_start", restore);
	pi.on("session_tree", restore);
	pi.on("input", async (event, ctx) => {
		if (event.streamingBehavior) return { action: "continue" as const };
		const mode = resolveHarnessMode(pi.getFlag("harness-mode"), ctx.sessionManager.getBranch());
		try {
			await applyMode(pi, ctx, mode, false);
			return { action: "continue" as const };
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return { action: "handled" as const };
		}
	});
	pi.on("before_agent_start", async (event, ctx) => {
		const mode = resolveHarnessMode(pi.getFlag("harness-mode"), ctx.sessionManager.getBranch());
		try {
			await applyMode(pi, ctx, mode, false);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			ctx.shutdown();
		}
		const policy = buildHarnessPolicy(event.systemPromptOptions.selectedTools ?? []);
		return { systemPrompt: `${event.systemPrompt}\n\n${policy}` };
	});

	pi.registerCommand("mode", {
		description: "Select high or ultra harness mode",
		handler: async (args, ctx) => {
			let requested: unknown = args.trim();
			if (!requested) requested = await ctx.ui.select("Harness mode", ["high", "ultra"]);
			if (!isHarnessMode(requested)) {
				if (requested !== undefined) ctx.ui.notify("Usage: /mode high|ultra", "error");
				return;
			}

			try {
				await applyMode(pi, ctx, requested);
				ctx.ui.setStatus("harness-mode", ctx.ui.theme.fg("accent", `mode:${requested}`));
				ctx.ui.notify(`Harness mode: ${requested}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: "oracle",
		label: "Oracle",
		description: "Consult a read-only expert for a hard engineering judgment, subtle bug, architecture decision, or high-impact review. Use it selectively after gathering relevant local evidence.",
		promptSnippet: "Get a read-only second opinion on difficult engineering judgment",
		promptGuidelines: [
			"Use oracle only when a hard judgment, subtle bug, architecture tradeoff, or high-impact review benefits from a stronger second opinion.",
			"Give oracle a focused self-contained task with intent, relevant files, constraints, and the exact decision or review output needed.",
		],
		executionMode: "parallel",
		parameters: Type.Object({
			task: Type.String({ minLength: 1, description: "Focused decision, debugging, planning, or review task with all necessary context" }),
		}),
		execute(_id, { task }, signal, onUpdate, ctx) {
			return runAgentTool("oracle", AGENTS.oracle, task, PROMPTS.oracle, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		name: "finder",
		label: "Finder",
		description: "Search and correlate local code by behavior or concept across multiple files. Use direct local search instead for an exact symbol, string, or known path.",
		promptSnippet: "Find conceptual local code flows in an isolated context",
		promptGuidelines: [
			"Use finder for conceptual, behavioral, or multi-module local code discovery; use direct search for exact strings, symbols, and known paths.",
			"Give finder a precise engineering query with success criteria and ask for paths, symbols, and line evidence.",
		],
		executionMode: "parallel",
		parameters: Type.Object({
			query: Type.String({ minLength: 1, description: "Precise local code-discovery objective and evidence required" }),
		}),
		execute(_id, { query }, signal, onUpdate, ctx) {
			return runAgentTool("finder", AGENTS.finder, query, PROMPTS.finder, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		name: "reviewer",
		label: "Reviewer",
		description: "Run an independent read-only intent-first review of a diff, implementation, or plan and return only evidence-backed findings.",
		promptSnippet: "Independently review code or a plan without modifying it",
		promptGuidelines: [
			"Use reviewer after non-trivial implementation or for an explicitly requested independent review, not for routine edits.",
			"Give reviewer the intended behavior, relevant paths or diff context, risk focus, and desired verdict format.",
		],
		executionMode: "parallel",
		parameters: Type.Object({
			task: Type.String({ minLength: 1, description: "Intent, relevant code or plan, risks to inspect, and desired review output" }),
		}),
		execute(_id, { task }, signal, onUpdate, ctx) {
			return runAgentTool("reviewer", AGENTS.reviewer, task, PROMPTS.reviewer, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		name: "librarian",
		label: "Librarian",
		description: "Research external repositories, dependency internals, implementation history, and authoritative web sources. Do not use it for local first-party code.",
		promptSnippet: "Research external repositories and authoritative sources",
		promptGuidelines: [
			"Use librarian for external repositories, dependency internals, cross-repository examples, or source history; never use librarian for local first-party code navigation.",
			"Ask librarian a specific question, name the repository or dependency when known, and include why the evidence is needed.",
		],
		executionMode: "parallel",
		parameters: Type.Object({
			query: Type.String({ minLength: 1, description: "Specific external codebase or source-research question" }),
			context: Type.Optional(Type.String({ description: "Why the research is needed and relevant local constraints" })),
		}),
		execute(_id, { query, context }, signal, onUpdate, ctx) {
			const task = context ? `${query}\n\nContext:\n${context}` : query;
			return runAgentTool("librarian", AGENTS.librarian, task, PROMPTS.librarian, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		name: "task",
		label: "Task",
		description: "Run a foreground implementation subagent after the path is understood. It has an isolated context but writes the current workspace, so use it as the single writer and inspect its work afterward.",
		promptSnippet: "Delegate a known multi-step implementation to a foreground single writer",
		promptGuidelines: [
			"Use task only for a known substantial implementation that benefits from an isolated executor; do discovery and resolve product or architecture decisions first.",
			"Give task a self-contained outcome, exact scope and paths, applicable constraints, non-goals, and validation to run; inspect its diff and validate the integrated result afterward.",
			"Never run task concurrently with another writer in the same workspace.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			task: Type.String({ minLength: 1, description: "Known implementation outcome, scope, constraints, relevant paths, and validation" }),
		}),
		execute(_id, { task }, signal, onUpdate, ctx) {
			const mode = resolveHarnessMode(pi.getFlag("harness-mode"), ctx.sessionManager.getBranch());
			return runAgentTool("task", taskAgentConfig(mode), task, PROMPTS.task, signal, onUpdate, ctx);
		},
	});

	registerWebTools(pi);
}
