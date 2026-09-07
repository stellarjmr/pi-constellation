import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AGENTS, MODES } from "../extensions/constellation/config.js";

test("Pi SDK loads the package and enforces modes with its real extension runtime", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-constellation-sdk-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({ defaultThinkingLevel: "medium" });
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		settingsManager,
		additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	assert.equal(loader.getExtensions().extensions.length, 1);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	for (const config of [...Object.values(MODES), ...Object.values(AGENTS)]) {
		assert.ok(modelRuntime.getModel(config.provider, config.model), `${config.provider}/${config.model}`);
	}
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		modelRuntime,
		model: modelRuntime.getModel(MODES.high.provider, MODES.high.model),
		thinkingLevel: "medium",
		settingsManager,
		sessionManager: SessionManager.inMemory(dir),
		resourceLoader: loader,
	});
	t.after(() => session.dispose());
	const errors: unknown[] = [];
	const notifications: string[] = [];
	t.mock.method(session.extensionRunner.getUIContext(), "notify", (message: string) => notifications.push(message));
	let shutdowns = 0;
	await session.bindExtensions({
		mode: "json",
		onError: (error) => errors.push(error),
		shutdownHandler: () => shutdowns++,
	});
	assert.equal(session.thinkingLevel, "xhigh");
	assert.deepEqual(session.extensionRunner.getAllRegisteredTools().map(({ definition }) => definition.name), [
		"oracle", "finder", "reviewer", "librarian", "task", "web_search", "read_web_page",
	]);
	const command = session.extensionRunner.getCommand("mode");
	assert.ok(command);
	await command.handler("ultra", session.extensionRunner.createCommandContext());
	assert.equal(session.thinkingLevel, "max");
	session.setThinkingLevel("off");
	await session.extensionRunner.emitInput("check mode", undefined, "interactive");
	assert.equal(session.thinkingLevel, "max");
	const beforeStart = await session.extensionRunner.emitBeforeAgentStart("test", undefined, "BASE", { cwd: dir, contextFiles: [] });
	assert.match(beforeStart?.systemPrompt ?? "", /Bundled AGENTS\.md Fallback/);
	assert.equal(settingsManager.getDefaultThinkingLevel(), "medium");
	assert.equal(shutdowns, 0, notifications.join("\n"));
	assert.deepEqual(notifications, ["Constellation mode: ultra"]);
	assert.deepEqual(errors, []);
});
