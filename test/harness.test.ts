import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { PassThrough } from "node:stream";
import test from "node:test";
import extension from "../index.js";
import {
	AGENTS,
	MODE_STATE_ENTRY,
	MODES,
	resolveHarnessMode,
	taskAgentConfig,
} from "../extensions/harness/config.js";
import childWeb from "../extensions/harness/child-web.js";
import harness, {
	appendBundledAgents,
	applyMode,
	BUNDLED_AGENTS,
	buildChildSystemPrompt,
	shouldUseBundledAgents,
} from "../extensions/harness/index.js";
import { buildPiArgv, JsonlCollector, resolvePiBinary, runChild } from "../extensions/harness/runner.js";

test("package manifest exposes one installable Pi extension entrypoint", () => {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
		name?: unknown;
		private?: unknown;
		license?: unknown;
		contributors?: unknown;
		files?: unknown;
		pi?: { extensions?: unknown };
	};
	assert.equal(typeof extension, "function");
	assert.equal(manifest.name, "pi-amp-harness");
	assert.equal(manifest.private, undefined);
	assert.equal(manifest.license, "MIT");
	assert.deepEqual(manifest.contributors, ["stellarjmr"]);
	assert.ok(Array.isArray(manifest.files) && manifest.files.includes("AGENTS.md"));
	assert.deepEqual(manifest.pi?.extensions, ["./index.ts"]);
});

test("mode and subagent model mappings match the requested Amp-style harness", () => {
	assert.deepEqual(MODES, {
		high: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "xhigh" },
		ultra: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "max" },
	});
	assert.deepEqual(
		Object.fromEntries(
			Object.entries(AGENTS).map(([name, config]) => [
				name,
				`${config.provider}/${config.model}:${config.thinking}`,
			]),
		),
		{
			oracle: "openai-codex/gpt-5.6-sol:high",
			finder: "openai-codex/gpt-5.6-terra:medium",
			reviewer: "openai-codex/gpt-5.5:high",
			librarian: "openai-codex/gpt-5.6-sol:high",
		},
	);
	assert.deepEqual(taskAgentConfig("high"), {
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		thinking: "xhigh",
		tools: "read,bash,edit,write,grep,find,ls",
		timeoutMs: 900_000,
	});
	assert.equal(taskAgentConfig("ultra").thinking, "max");
});

test("bundled AGENTS.md is documented verbatim and contains the durable harness contract", () => {
	const file = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8").trim();
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	assert.equal(BUNDLED_AGENTS, file);
	assert.ok(readme.includes(`\`\`\`markdown\n${file}\n\`\`\``));
	assert.match(file, /main agent owns understanding, implementation, integration, and verification/);
	assert.match(file, /Keep a single writer/);
	assert.match(file, /Do not expose credentials/);
	assert.match(file, /Validate in proportion to risk/);
});

test("bundled AGENTS.md is a fallback for an empty Pi context and composes once", () => {
	assert.equal(shouldUseBundledAgents(undefined), true);
	assert.equal(shouldUseBundledAgents([]), true);
	assert.equal(shouldUseBundledAgents([], true), false);

	const prompt = appendBundledAgents("EARLIER EXTENSION", true);
	assert.match(prompt, /^EARLIER EXTENSION\n\n## Bundled AGENTS\.md Fallback/);
	assert.equal(prompt.match(/# Amp-Style Autonomous Coding Rules/g)?.length, 1);
	assert.equal(appendBundledAgents(prompt, false), prompt);
});

test("any Pi-discovered instruction context suppresses the bundled fallback", () => {
	for (const path of [
		"/home/user/.pi/agent/AGENTS.md",
		"/workspace/AGENTS.override.md",
		"/workspace/project/CLAUDE.md",
		"/custom/instructions.txt",
		new URL("../AGENTS.md", import.meta.url).pathname,
	]) {
		assert.equal(shouldUseBundledAgents([{ path, content: "USER RULES" }]), false, path);
	}
});

test("child prompts use the parent instruction snapshot without mixing fallback context", () => {
	const fallback = buildChildSystemPrompt("CHILD", [], true);
	assert.equal(fallback.match(/# Amp-Style Autonomous Coding Rules/g)?.length, 1);
	assert.doesNotMatch(fallback, /<project_context>/);

	const custom = buildChildSystemPrompt(
		"CHILD",
		[
			{ path: "/global/AGENTS.md", content: "GLOBAL RULES" },
			{ path: "/workspace/AGENTS.md", content: "PROJECT RULES" },
		],
		false,
	);
	assert.match(custom, /^CHILD\n\n<project_context>/);
	assert.match(custom, /<project_instructions path="\/global\/AGENTS\.md">\nGLOBAL RULES/);
	assert.match(custom, /<project_instructions path="\/workspace\/AGENTS\.md">\nPROJECT RULES/);
	assert.doesNotMatch(custom, /Bundled AGENTS\.md Fallback/);

	assert.equal(buildChildSystemPrompt("CHILD", [], false), "CHILD");
});

test("restoring an already-correct mode does not append native session transitions", async () => {
	const model = { provider: "openai-codex", id: "gpt-5.6-sol" };
	let modelChanges = 0;
	const thinkingChanges: string[] = [];
	let customEntries = 0;
	const pi = {
		setModel: async () => {
			modelChanges++;
			return true;
		},
		setThinkingLevel: (level: string) => thinkingChanges.push(level),
		appendEntry: () => customEntries++,
	};
	const ctx = {
		model,
		thinkingLevel: "xhigh",
		modelRegistry: {
			find: () => model,
		},
	};

	await applyMode(pi as never, ctx as never, "high", false);
	assert.equal(modelChanges, 0);
	assert.deepEqual(thinkingChanges, []);
	assert.equal(customEntries, 0);

	await applyMode(pi as never, ctx as never, "ultra");
	assert.equal(modelChanges, 0);
	assert.deepEqual(thinkingChanges, ["max"]);
	assert.equal(customEntries, 1);
});

test("statusline mode resolution prefers the startup flag, then session state, then high", () => {
	const entries = [
		{ type: "custom", customType: MODE_STATE_ENTRY, data: { mode: "high" } },
		{ type: "custom", customType: MODE_STATE_ENTRY, data: { mode: "ultra" } },
	];
	assert.equal(resolveHarnessMode(undefined, []), "high");
	assert.equal(resolveHarnessMode(undefined, entries), "ultra");
	assert.equal(resolveHarnessMode("high", entries), "high");
});

test("startup mode errors fail closed instead of continuing with an arbitrary model", async () => {
	type Restore = (event: unknown, ctx: unknown) => Promise<void>;
	let restore: Restore | undefined;
	let flag: string = "medium";
	const pi = {
		registerFlag() {},
		on(event: string, handler: Restore) {
			if (event === "session_start") restore = handler;
		},
		registerCommand() {},
		registerTool() {},
		getFlag: () => flag,
		setModel: async () => true,
		setThinkingLevel() {},
		appendEntry() {},
	};
	harness(pi as never);
	assert.ok(restore);

	let shutdowns = 0;
	const notifications: string[] = [];
	const baseContext = {
		sessionManager: { getBranch: () => [] },
		model: { provider: "openai-codex", id: "gpt-5.6-sol" },
		thinkingLevel: "xhigh",
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus() {},
			theme: { fg: (_color: string, text: string) => text },
		},
		shutdown: () => shutdowns++,
	};
	await restore({}, baseContext);
	assert.equal(shutdowns, 1);
	assert.match(notifications.at(-1) ?? "", /Invalid --harness-mode/);

	flag = "high";
	await restore({}, {
		...baseContext,
		modelRegistry: {
			find: () => undefined,
		},
	});
	assert.equal(shutdowns, 2);
	assert.match(notifications.at(-1) ?? "", /model openai-codex\/gpt-5\.6-sol is unavailable/);
});

test("Pi child argv is fresh, isolated, and loads only the owned librarian extension", () => {
	assert.equal(resolvePiBinary({ PI_HARNESS_PI_BINARY: "/fake/pi" }), "/fake/pi");
	const argv = buildPiArgv(AGENTS.librarian, "/tmp/system.txt", "/private/child-web.ts");
	assert.deepEqual(argv.slice(0, 4), ["--mode", "json", "-p", "--no-session"]);
	assert.ok(argv.includes("--no-extensions"));
	assert.ok(argv.includes("--no-skills"));
	assert.ok(argv.includes("--no-context-files"));
	assert.deepEqual(
		argv.slice(argv.indexOf("--append-system-prompt"), argv.indexOf("--append-system-prompt") + 2),
		["--append-system-prompt", "/tmp/system.txt"],
	);
	assert.deepEqual(argv.slice(-2), ["-e", "/private/child-web.ts"]);
	assert.equal(buildPiArgv(AGENTS.oracle, "/tmp/system.txt").includes("-e"), false);

	const taskArgv = buildPiArgv(taskAgentConfig("ultra"), "/tmp/system.txt");
	assert.deepEqual(taskArgv.slice(taskArgv.indexOf("--model"), taskArgv.indexOf("--model") + 2), [
		"--model",
		"openai-codex/gpt-5.6-sol",
	]);
	assert.deepEqual(taskArgv.slice(taskArgv.indexOf("--thinking"), taskArgv.indexOf("--thinking") + 2), [
		"--thinking",
		"max",
	]);
	assert.equal(taskArgv[taskArgv.indexOf("--tools") + 1], "read,bash,edit,write,grep,find,ls");
	assert.ok(taskArgv.includes("--no-session"));
	assert.ok(taskArgv.includes("--no-extensions"));
	assert.equal(taskArgv.includes("-e"), false);
});

test("fragmented UTF-8 JSONL retains the final assistant text and usage", () => {
	const collector = new JsonlCollector();
	const line = Buffer.from(
		`${JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				model: "model-id",
				content: [{ type: "text", text: "café ✅" }],
				usage: { totalTokens: 9 },
			},
		})}\n`,
	);
	const multibyte = line.indexOf(Buffer.from("é"));
	collector.push(line.subarray(0, multibyte + 1));
	collector.push(line.subarray(multibyte + 1));
	assert.deepEqual(collector.finish(), {
		text: "café ✅",
		model: "model-id",
		usage: { totalTokens: 9 },
	});
});

test("JSONL progress reports bounded lifecycle metadata without exposing tool arguments", () => {
	const progress: unknown[] = [];
	const collector = new JsonlCollector(1024 * 1024, 1024 * 1024, (update) => progress.push(update));
	const events = [
		{ type: "agent_start" },
		{ type: "message_start", message: { role: "assistant" } },
		{ type: "tool_execution_start", toolName: "x".repeat(100), args: { secret: "do-not-report" } },
		{ type: "tool_execution_end", toolName: "read", isError: false },
		{ type: "tool_execution_start", toolName: 42, args: { secret: "still-hidden" } },
		{
			type: "message_end",
			message: { role: "assistant", model: "model-id", content: [{ type: "text", text: "done" }] },
		},
	];
	collector.push(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
	assert.equal(collector.finish().text, "done");
	assert.deepEqual(progress, [
		{ phase: "running", completedTools: 0 },
		{ phase: "responding", completedTools: 0 },
		{ phase: "tool", toolName: "x".repeat(80), completedTools: 0 },
		{ phase: "running", completedTools: 1 },
		{ phase: "tool", toolName: "unknown", completedTools: 1 },
	]);
	assert.doesNotMatch(JSON.stringify(progress), /do-not-report|still-hidden|secret/);
});

test("progress callback failures do not interrupt child result collection", () => {
	const collector = new JsonlCollector(1024, 1024, () => {
		throw new Error("UI unavailable");
	});
	assert.doesNotThrow(() =>
		collector.push(
			`${JSON.stringify({ type: "agent_start" })}\n${JSON.stringify({
				type: "message_end",
				message: { role: "assistant", model: "model-id", content: [{ type: "text", text: "ok" }] },
			})}\n`,
		),
	);
	assert.equal(collector.finish().text, "ok");
});

test("JSONL collector rejects bounded and incomplete child output", () => {
	const collector = new JsonlCollector(16, 16);
	assert.throws(() => collector.push("x".repeat(17)), /output exceeded/);
	assert.throws(() => new JsonlCollector().finish(), /no final assistant/);
});

test("parent and librarian child register only their intended tools", () => {
	const parentNames: string[] = [];
	const executionModes = new Map<string, string | undefined>();
	const parent = {
		registerFlag() {},
		on() {},
		registerCommand() {},
		registerTool(tool: { name: string; executionMode?: string }) {
			parentNames.push(tool.name);
			executionModes.set(tool.name, tool.executionMode);
		},
	};
	harness(parent as never);
	assert.deepEqual(parentNames, [
		"oracle",
		"finder",
		"reviewer",
		"librarian",
		"task",
		"web_search",
		"read_web_page",
	]);
	assert.equal(executionModes.get("task"), "sequential");
	assert.equal(executionModes.get("finder"), "parallel");

	const childNames: string[] = [];
	childWeb({ registerTool: (tool: { name: string }) => childNames.push(tool.name) } as never);
	assert.deepEqual(childNames, ["web_search", "read_web_page"]);
});

test("input preflight repairs mode drift and applies instructions only as a fallback", async () => {
	type BeforeStart = (event: any, ctx: any) => Promise<{ systemPrompt: string }>;
	type Input = (event: any, ctx: any) => Promise<{ action: "continue" | "handled" }>;
	let beforeStart: BeforeStart | undefined;
	let input: Input | undefined;
	let modelChanges = 0;
	const thinkingChanges: string[] = [];
	let customEntries = 0;
	const targetModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
	let ctx: any;
	const pi = {
		registerFlag() {},
		on(event: string, handler: BeforeStart | Input) {
			if (event === "before_agent_start") beforeStart = handler as BeforeStart;
			if (event === "input") input = handler as Input;
		},
		registerCommand() {},
		registerTool() {},
		getFlag: () => "high",
		setModel: async (model: unknown) => {
			modelChanges++;
			ctx.model = model;
			return true;
		},
		setThinkingLevel: (level: string) => {
			thinkingChanges.push(level);
			ctx.thinkingLevel = level;
		},
		appendEntry: () => customEntries++,
	};
	harness(pi as never);
	assert.ok(beforeStart);
	assert.ok(input);

	ctx = {
		model: { provider: "openai-codex", id: "gpt-5.5" },
		thinkingLevel: "low",
		modelRegistry: { find: () => targetModel },
		sessionManager: { getBranch: () => [] },
		ui: { notify() {} },
	};
	assert.deepEqual(await input({ source: "interactive" }, ctx), { action: "continue" });
	const result = await beforeStart(
		{
			systemPrompt: "BASE",
			systemPromptOptions: { contextFiles: [] },
		},
		ctx,
	);
	assert.equal(modelChanges, 1);
	assert.deepEqual(thinkingChanges, ["xhigh"]);
	assert.equal(customEntries, 0);
	assert.equal(result.systemPrompt.match(/## Bundled AGENTS\.md Fallback/g)?.length, 1);
	assert.match(result.systemPrompt, /^BASE\n\n## Bundled AGENTS\.md Fallback/);

	const existing = await beforeStart(
		{
			systemPrompt: "BASE\n\nUSER RULES",
			systemPromptOptions: {
				contextFiles: [{ path: "/workspace/AGENTS.md", content: "USER RULES" }],
			},
		},
		ctx,
	);
	assert.equal(existing.systemPrompt, "BASE\n\nUSER RULES");
});

test("input preflight handles failed mode repair before a provider turn", async () => {
	type Input = (event: any, ctx: any) => Promise<{ action: "continue" | "handled" }>;
	let input: Input | undefined;
	const notifications: string[] = [];
	let switchAllowed = true;
	let availableModel: { provider: string; id: string } | undefined;
	const pi = {
		registerFlag() {},
		on(event: string, handler: Input) {
			if (event === "input") input = handler;
		},
		registerCommand() {},
		registerTool() {},
		getFlag: () => "high",
		setModel: async () => switchAllowed,
		setThinkingLevel() {},
		appendEntry() {},
	};
	harness(pi as never);
	assert.ok(input);
	const ctx = {
		model: { provider: "openai-codex", id: "gpt-5.5" },
		thinkingLevel: "low",
		modelRegistry: { find: () => availableModel },
		sessionManager: { getBranch: () => [] },
		ui: { notify: (message: string) => notifications.push(message) },
	};
	assert.deepEqual(await input({ source: "interactive" }, ctx), { action: "handled" });
	assert.match(notifications.at(-1) ?? "", /model openai-codex\/gpt-5\.6-sol is unavailable/);

	availableModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
	switchAllowed = false;
	assert.deepEqual(await input({ source: "interactive" }, ctx), { action: "handled" });
	assert.match(notifications.at(-1) ?? "", /authentication unavailable/);

	assert.deepEqual(await input({ source: "interactive", streamingBehavior: "followUp" }, ctx), {
		action: "continue",
	});
});

test("abort terminates a running child and rejects", async () => {
	const child = new EventEmitter() as EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
		exitCode: number | null;
		signalCode: NodeJS.Signals | null;
		kill: (signal: NodeJS.Signals) => boolean;
	};
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.exitCode = null;
	child.signalCode = null;
	const kills: NodeJS.Signals[] = [];
	child.kill = (signal) => {
		kills.push(signal);
		child.signalCode = signal;
		queueMicrotask(() => child.emit("close", null));
		return true;
	};

	const controller = new AbortController();
	const promise = runChild(AGENTS.finder, "task", "system", controller.signal, (() => child) as never);
	setTimeout(() => controller.abort(), 5);
	await assert.rejects(promise, /aborted/);
	assert.deepEqual(kills, ["SIGTERM"]);
});

test("an already-aborted child is never spawned", async () => {
	const controller = new AbortController();
	controller.abort();
	let spawned = false;
	await assert.rejects(
		() =>
			runChild(AGENTS.finder, "task", "system", controller.signal, (() => {
				spawned = true;
			}) as never),
		/before launch/,
	);
	assert.equal(spawned, false);
});

test("temporary prompts are private, absent from argv, and cleaned after spawn failure", async () => {
	let promptFile = "";
	let taskFile = "";
	const task = "confidential task text";
	const system = "confidential system text";

	await assert.rejects(
		() =>
			runChild(AGENTS.finder, task, system, undefined, ((_binary: string, argv: readonly string[]) => {
				const promptIndex = argv.indexOf("--append-system-prompt");
				promptFile = argv[promptIndex + 1] ?? "";
				taskFile = (argv.find((argument) => argument.startsWith("@")) ?? "").slice(1);
				assert.equal(argv.some((argument) => argument.includes(task) || argument.includes(system)), false);
				assert.equal(readFileSync(promptFile, "utf8"), system);
				assert.equal(readFileSync(taskFile, "utf8"), `Task:\n${task}`);
				assert.equal(statSync(promptFile).mode & 0o777, 0o600);
				assert.equal(statSync(taskFile).mode & 0o777, 0o600);
				throw new Error("spawn failed");
			}) as never),
		/spawn failed/,
	);

	assert.equal(existsSync(promptFile), false);
	assert.equal(existsSync(taskFile), false);
});
