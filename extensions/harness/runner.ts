import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

export interface AgentConfig {
	provider: string;
	model: string;
	thinking: string;
	tools: string;
	timeoutMs: number;
}

export interface ChildProgress {
	phase: "starting" | "running" | "tool" | "responding";
	toolName?: string;
	completedTools: number;
}

export interface RunResult {
	text: string;
	model: string;
	usage?: unknown;
	stderr?: string;
}
export type SpawnFn = typeof spawn;

const CHILD_OUTPUT_LIMIT = 8 * 1024 * 1024;
const JSONL_LINE_LIMIT = 2 * 1024 * 1024;
const STDERR_TAIL_LIMIT = 256 * 1024;
const TOOL_NAME_LIMIT = 80;

function notifyProgress(
	onProgress: ((progress: ChildProgress) => void) | undefined,
	progress: ChildProgress,
): void {
	try {
		onProgress?.(progress);
	} catch {
		// UI progress is best-effort and must never abort child execution.
	}
}

export function resolvePiBinary(env: NodeJS.ProcessEnv = process.env): string {
	if (env.PI_HARNESS_PI_BINARY?.trim()) return env.PI_HARNESS_PI_BINARY.trim();
	const candidate = process.platform === "win32" ? "pi.cmd" : "pi";
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const path = join(dir, candidate);
		if (existsSync(path)) return path;
	}
	return candidate;
}

export function buildPiArgv(config: AgentConfig, promptFile: string, childWeb?: string): string[] {
	return [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--model",
		`${config.provider}/${config.model}`,
		"--thinking",
		config.thinking,
		"--tools",
		config.tools,
		"--append-system-prompt",
		promptFile,
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--approve",
		...(childWeb ? ["-e", childWeb] : []),
	];
}

export class JsonlCollector {
	private readonly decoder = new StringDecoder("utf8");
	private pending = "";
	private bytes = 0;
	private finalAssistant?: Record<string, unknown>;
	private completedTools = 0;

	constructor(
		private readonly limit = CHILD_OUTPUT_LIMIT,
		private readonly lineLimit = JSONL_LINE_LIMIT,
		private readonly onProgress?: (progress: ChildProgress) => void,
	) {}

	push(chunk: Buffer | string): void {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		this.bytes += buffer.byteLength;
		if (this.bytes > this.limit) throw new Error(`child output exceeded ${this.limit} byte limit`);

		this.pending += this.decoder.write(buffer);
		this.processPendingLines();
		if (Buffer.byteLength(this.pending) > this.lineLimit) {
			throw new Error(`child JSONL line exceeded ${this.lineLimit} byte limit`);
		}
	}

	finish(): RunResult {
		this.pending += this.decoder.end();
		this.processPendingLines();
		if (this.pending.trim()) this.processLine(this.pending);

		const message = this.finalAssistant;
		if (!message) throw new Error("child returned no final assistant message");

		const stopReason = message.stopReason;
		if (stopReason === "error" || stopReason === "aborted") {
			const providerError = message.errorMessage;
			throw new Error(
				typeof providerError === "string" && providerError
					? providerError
					: `child request ${stopReason}`,
			);
		}
		if (stopReason === "length" || stopReason === "toolUse") {
			throw new Error(`child response was incomplete (${stopReason})`);
		}

		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.flatMap((part) => {
								if (!part || typeof part !== "object") return [];
								const record = part as { type?: unknown; text?: unknown };
								return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
							})
							.join("\n")
					: "";

		return { text, model: String(message.model ?? "unknown"), usage: message.usage };
	}

	private processPendingLines(): void {
		for (;;) {
			const newline = this.pending.indexOf("\n");
			if (newline < 0) return;
			this.processLine(this.pending.slice(0, newline));
			this.pending = this.pending.slice(newline + 1);
		}
	}

	private processLine(line: string): void {
		if (!line.trim()) return;
		const event = JSON.parse(line) as Record<string, unknown>;
		if (event.type === "agent_start") {
			notifyProgress(this.onProgress, { phase: "running", completedTools: this.completedTools });
			return;
		}
		if (event.type === "tool_execution_start") {
			notifyProgress(this.onProgress, {
				phase: "tool",
				toolName: typeof event.toolName === "string" ? event.toolName.slice(0, TOOL_NAME_LIMIT) : "unknown",
				completedTools: this.completedTools,
			});
			return;
		}
		if (event.type === "tool_execution_end") {
			this.completedTools++;
			notifyProgress(this.onProgress, { phase: "running", completedTools: this.completedTools });
			return;
		}
		if (event.type === "message_start" && event.message && typeof event.message === "object") {
			const message = event.message as Record<string, unknown>;
			if (message.role === "assistant") {
				notifyProgress(this.onProgress, { phase: "responding", completedTools: this.completedTools });
			}
			return;
		}
		if (event.type !== "message_end" || !event.message || typeof event.message !== "object") return;

		const message = event.message as Record<string, unknown>;
		if (message.role === "assistant") this.finalAssistant = message;
	}
}

function appendTail(current: Buffer, chunk: Buffer, limit: number): Buffer {
	if (chunk.byteLength >= limit) return chunk.subarray(chunk.byteLength - limit);
	const keep = Math.min(current.byteLength, limit - chunk.byteLength);
	return Buffer.concat([current.subarray(current.byteLength - keep), chunk]);
}

export async function runChild(
	config: AgentConfig,
	task: string,
	systemPrompt: string,
	signal?: AbortSignal,
	spawnFn: SpawnFn = spawn,
	cwd = process.cwd(),
	onProgress?: (progress: ChildProgress) => void,
): Promise<RunResult> {
	if (signal?.aborted) throw new Error("child aborted before launch");
	if (!task.trim()) throw new Error("child task must not be empty");
	notifyProgress(onProgress, { phase: "starting", completedTools: 0 });

	const dir = await mkdtemp(join(tmpdir(), "pi-harness-"));
	try {
		const promptFile = join(dir, "system.txt");
		const taskFile = join(dir, "task.md");
		await writeFile(promptFile, systemPrompt, { encoding: "utf8", mode: 0o600 });
		await writeFile(taskFile, `Task:\n${task}`, { encoding: "utf8", mode: 0o600 });

		const childWeb = config.tools.includes("web_search")
			? join(dirname(fileURLToPath(import.meta.url)), "child-web.ts")
			: undefined;
		const collector = new JsonlCollector(CHILD_OUTPUT_LIMIT, JSONL_LINE_LIMIT, onProgress);
		let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let stderrBytes = 0;

		return await new Promise<RunResult>((resolve, reject) => {
			let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
			let settled = false;
			let stopping = false;
			let terminalError: Error | undefined;
			let killTimer: NodeJS.Timeout | undefined;

			const timeout = setTimeout(() => {
				stop(new Error(`child timed out after ${config.timeoutMs}ms`));
			}, config.timeoutMs);
			timeout.unref();

			const cleanup = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (killTimer) clearTimeout(killTimer);
				signal?.removeEventListener("abort", onAbort);
			};

			const stop = (error: Error): void => {
				if (settled || stopping) return;
				stopping = true;
				terminalError = error;
				if (!child) return;
				const runningChild = child;
				runningChild.stdout.pause();
				runningChild.stderr.pause();
				runningChild.kill("SIGTERM");
				killTimer = setTimeout(() => {
					if (!settled && runningChild.exitCode === null && runningChild.signalCode === null) {
						runningChild.kill("SIGKILL");
					}
				}, 2_000);
				killTimer.unref();
			};

			const onAbort = (): void => stop(new Error("child aborted"));

			try {
				const argv = [
					...buildPiArgv(config, promptFile, childWeb),
					`@${taskFile}`,
				];
				child = spawnFn(resolvePiBinary(), argv, {
					shell: false,
					cwd,
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (error) {
				cleanup();
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}

			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();

			child.stdout.on("data", (chunk: Buffer) => {
				try {
					collector.push(chunk);
				} catch (error) {
					stop(error instanceof Error ? error : new Error(String(error)));
				}
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderrBytes += chunk.byteLength;
				stderrTail = appendTail(stderrTail, chunk, STDERR_TAIL_LIMIT);
				if (stderrBytes > STDERR_TAIL_LIMIT) {
					stop(new Error(`child stderr exceeded ${STDERR_TAIL_LIMIT} byte limit`));
				}
			});

			child.once("error", (error) => {
				cleanup();
				reject(terminalError ?? error);
			});
			child.once("close", (code) => {
				cleanup();
				const stderr = stderrTail.toString("utf8");
				if (terminalError) {
					reject(terminalError);
					return;
				}
				if (code !== 0) {
					reject(new Error(`child exited ${code ?? "without a status"}: ${stderr.slice(-4_000)}`));
					return;
				}

				try {
					resolve({ ...collector.finish(), stderr: stderr || undefined });
				} catch (error) {
					reject(error);
				}
			});
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
