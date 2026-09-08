export const MODES = {
	high: { provider: "openai-codex", model: "gpt-6-astra", thinking: "xhigh" },
	ultra: { provider: "openai-codex", model: "gpt-6-astra", thinking: "max" },
} as const;
export type ConstellationMode = keyof typeof MODES;

export const MODE_STATE_ENTRY = "pi-constellation.mode";

export function isConstellationMode(value: unknown): value is ConstellationMode {
	return value === "high" || value === "ultra";
}

export function resolveConstellationMode(
	flag: unknown,
	entries: ReadonlyArray<{ type?: unknown; customType?: unknown; data?: unknown }>,
): ConstellationMode {
	if (isConstellationMode(flag)) return flag;
	let saved: ConstellationMode | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MODE_STATE_ENTRY) continue;
		const mode = (entry.data as { mode?: unknown } | undefined)?.mode;
		if (isConstellationMode(mode)) saved = mode;
	}
	return saved ?? "high";
}

export function taskAgentConfig(mode: ConstellationMode) {
	return {
		...MODES[mode],
		tools: "read,bash,edit,write,grep,find,ls",
		timeoutMs: 900_000,
	};
}

export const AGENTS = {
	oracle: {
		provider: "openai-codex",
		model: "gpt-6-astra",
		thinking: "high",
		tools: "read,grep,find,ls",
		timeoutMs: 600_000,
	},
	finder: {
		provider: "openai-codex",
		model: "gpt-5.6-terra",
		thinking: "medium",
		tools: "read,grep,find,ls",
		timeoutMs: 300_000,
	},
	reviewer: {
		provider: "openai-codex",
		model: "gpt-5.5",
		thinking: "high",
		tools: "read,grep,find,ls",
		timeoutMs: 600_000,
	},
	librarian: {
		provider: "openai-codex",
		model: "gpt-6-astra",
		thinking: "high",
		tools: "web_search,read_web_page",
		timeoutMs: 600_000,
	},
} as const;
