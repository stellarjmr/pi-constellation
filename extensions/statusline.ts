import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { CustomEditor, type ExtensionAPI, type ExtensionContext, InteractiveMode, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorTheme, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { resolveConstellationMode, type ConstellationMode } from "./constellation/config.js";

// Suppress the framework's built-in "Thinking level: xxx" status message,
// since the custom editor border shows the Constellation mode instead.
const SUPPRESS_STATUS_PATTERNS: RegExp[] = [/^Thinking level: /];
const interactiveProto = InteractiveMode.prototype as unknown as { showStatus: (message: string) => void };
if (!(interactiveProto as { __statuslineSuppressPatched?: boolean }).__statuslineSuppressPatched) {
	const originalShowStatus = interactiveProto.showStatus;
	interactiveProto.showStatus = function patchedShowStatus(message: string) {
		if (SUPPRESS_STATUS_PATTERNS.some((re) => re.test(message))) return;
		return originalShowStatus.call(this, message);
	};
	(interactiveProto as { __statuslineSuppressPatched?: boolean }).__statuslineSuppressPatched = true;
}

type CodeLimit = {
	usedPercent: number;
	windowDurationMins: number;
	resetsAt: number;
};

type CodeLimCache = {
	session: CodeLimit | null;
	weekly: CodeLimit | null;
	loading: boolean;
	error: string | null;
};

type CodeLimJson = {
	limits?: {
		session?: Partial<CodeLimit>;
		weekly?: Partial<CodeLimit>;
	};
};

type StatusState = {
	branch: string | null;
	codeLimits: CodeLimCache;
};

type SettingsJson = {
	packages?: Array<string | { source?: string }>;
};

function sep(theme: Theme): string {
	return theme.fg("dim", " · ");
}

function uniqSorted(items: string[]): string[] {
	return [...new Set(items.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function packageLabel(source: string): string {
	const label = source.replace(/^(npm:|git:)/, "");
	return label.startsWith("@") ? label.replace(/@[^/]+$/, "") : label.split("@")[0] || source;
}

function readSettingsPackages(agentDir: string): string[] {
	const settingsPath = join(agentDir, "settings.json");
	if (!existsSync(settingsPath)) return [];

	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsJson;
		return (settings.packages ?? [])
			.map((pkg) => (typeof pkg === "string" ? pkg : pkg.source ?? ""))
			.map(packageLabel);
	} catch {
		return [];
	}
}

function readLocalExtensionLabels(agentDir: string): string[] {
	const extensionDir = join(agentDir, "extensions");
	if (!existsSync(extensionDir)) return [];

	try {
		return readdirSync(extensionDir, { withFileTypes: true })
			.flatMap((entry) => {
				if (entry.isFile() && /\.[tj]s$/.test(entry.name)) return [entry.name];
				if (entry.isDirectory() && existsSync(join(extensionDir, entry.name, "index.ts"))) return [`${entry.name}/index.ts`];
				return [];
			});
	} catch {
		return [];
	}
}

function formatStartupResources(pi: ExtensionAPI, ctx: ExtensionContext): string[] {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const skills = uniqSorted(
		pi
			.getCommands()
			.filter((command) => command.source === "skill")
			.map((command) => command.name.replace(/^skill:/, "")),
	);
	const extensions = uniqSorted([...readSettingsPackages(agentDir), ...readLocalExtensionLabels(agentDir)]);

	const lines: string[] = [];
	const addSection = (title: string, items: string[]) => {
		if (items.length === 0) return;
		if (lines.length > 0) lines.push("");
		lines.push(`[${title}]`);
		lines.push(`  ${items.join(", ")}`);
	};

	addSection("Skills", skills);
	addSection("Extensions", extensions);
	return lines;
}

function colorForConstellationMode(theme: Theme, mode: ConstellationMode): string {
	return mode === "ultra" ? theme.fg("thinkingMax", mode) : theme.fg("thinkingHigh", mode);
}

function formatProjectName(cwd: string): string {
	return basename(cwd) || cwd;
}

function isCodeLimit(value: Partial<CodeLimit> | undefined): value is CodeLimit {
	return (
		typeof value?.usedPercent === "number" &&
		typeof value.windowDurationMins === "number" &&
		typeof value.resetsAt === "number"
	);
}

function formatDurationUntil(unixSeconds: number): string {
	const mins = Math.max(0, Math.round((unixSeconds * 1000 - Date.now()) / 60000));
	const days = Math.floor(mins / 1440);
	const hours = Math.floor((mins % 1440) / 60);
	const minutes = mins % 60;

	if (days > 0) return `${days}d${hours}h`;
	if (hours > 0) return `${hours}h${minutes}m`;
	return `${minutes}m`;
}

function formatLimit(label: string, limit: CodeLimit | null, cache: CodeLimCache): string {
	if (limit) {
		const remaining = Math.max(0, Math.min(100, 100 - limit.usedPercent));
		return `${label} ${Math.round(remaining)}% (${formatDurationUntil(limit.resetsAt)})`;
	}
	if (cache.loading) return `${label} ...`;
	return `${label} ?`;
}

function formatLimitCompact(label: string, limit: CodeLimit | null, cache: CodeLimCache): string {
	if (limit) {
		const remaining = Math.max(0, Math.min(100, 100 - limit.usedPercent));
		return `${label} ${Math.round(remaining)}%`;
	}
	if (cache.loading) return `${label} ...`;
	return `${label} ?`;
}

function getContextLeftPercent(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	if (!usage || usage.percent === null) return "?%";

	const left = Math.max(0, Math.min(100, 100 - usage.percent));
	return `${Math.round(left)}%`;
}

function buildBorderLine(left: string, right: string, width: number, theme: Theme, leftCorner: string, rightCorner: string): string {
	if (width <= 0) return "";
	if (width === 1) return theme.fg("borderAccent", leftCorner);

	const minMiddle = Math.max(0, width - 2);
	const gap = Math.max(1, minMiddle - visibleWidth(left) - visibleWidth(right));
	const middle = `${left}${theme.fg("borderAccent", "─".repeat(gap))}${right}`;
	return `${theme.fg("borderAccent", leftCorner)}${truncateToWidth(middle, minMiddle, "", true)}${theme.fg("borderAccent", rightCorner)}`;
}

// Internal zero-width marker: removed before any rows reach the terminal.
const EDITOR_BOTTOM_MARKER = "\x1b_constellation-bottom-border\x1b\\";

class LimitEditor extends CustomEditor {
	private frameWidth = 0;
	private bottomBorder = "";
	private nativeBottomRow = 0;
	private fillerRows = 0;

	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly uiTheme: Theme,
		private readonly ctx: ExtensionContext,
		private readonly pi: ExtensionAPI,
		private readonly statusState: StatusState,
	) {
		super(tui, editorTheme, keybindings, { embedWorkingStatus: false });
	}

	override render(width: number): string[] {
		this.frameWidth = width;
		this.nativeBottomRow = 0;
		this.fillerRows = 0;
		if (width <= 0) return [];
		const innerWidth = Math.max(0, width - 2);
		const rendered = super.render(this.nativeWidth(width));
		// Pi appends autocomplete after its bottom border. Never assume the last row is a border.
		this.nativeBottomRow = rendered.indexOf(EDITOR_BOTTOM_MARKER);
		if (this.nativeBottomRow < 1) throw new Error("Pi editor did not render its bottom border");
		const body = rendered.slice(1, this.nativeBottomRow);
		this.fillerRows = Math.max(0, 2 - body.length);
		body.push(...Array<string>(this.fillerRows).fill(""));
		const side = this.uiTheme.fg("borderAccent", "│");
		return [
			rendered[0]!,
			...body.map((line) => width === 1 ? side : `${side}${truncateToWidth(line, innerWidth, "", true)}${side}`),
			this.bottomBorder,
			...rendered.slice(this.nativeBottomRow + 1).map((line) => truncateToWidth(` ${line}`, width, "", true)),
		];
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return super.handleMouse({
			...event,
			x: event.x - 1,
			y: event.y >= this.nativeBottomRow ? Math.max(this.nativeBottomRow, event.y - this.fillerRows) : event.y,
			width: this.nativeWidth(event.width),
			height: Math.max(0, event.height - this.fillerRows),
		});
	}

	private nativeWidth(width: number): number {
		// Pi needs space for a wide grapheme and its cursor. Clip only when the frame is narrower.
		return Math.max(width - 2, 3 + 2 * this.getPaddingX());
	}

	protected override renderTopBorder(_width: number, hiddenLineCount: number): string {
		const mode = resolveConstellationMode(this.pi.getFlag("constellation-mode"), this.ctx.sessionManager.getBranch());
		const borderJoin = this.uiTheme.fg("borderAccent", " ─ ");
		const borderEdgeLeft = this.uiTheme.fg("borderAccent", "─ ");
		const borderEdgeRight = this.uiTheme.fg("borderAccent", " ──");
		const scrollHint = hiddenLineCount > 0 ? `↑ ${hiddenLineCount} more ` : "";
		const topLeft = `${borderEdgeLeft}${this.uiTheme.fg("borderAccent", ` ${scrollHint}`)}`;
		const topRight = ` ${getContextLeftPercent(this.ctx)}${borderJoin}${colorForConstellationMode(this.uiTheme, mode)}${borderEdgeRight}`;
		return buildBorderLine(topLeft, topRight, this.frameWidth, this.uiTheme, "╭", "╮");
	}

	protected override renderBottomBorder(_width: number, hiddenLineCount: number): string {
		const borderJoin = this.uiTheme.fg("borderAccent", " ─ ");
		const borderEdgeLeft = this.uiTheme.fg("borderAccent", "─ ");
		const borderEdgeRight = this.uiTheme.fg("borderAccent", " ──");
		const scrollHint = hiddenLineCount > 0 ? this.uiTheme.fg("borderAccent", `↓ ${hiddenLineCount} more `) : "";
		const bottomLeft =
			borderEdgeLeft +
			scrollHint +
			this.uiTheme.fg("warning", formatLimitCompact("5h", this.statusState.codeLimits.session, this.statusState.codeLimits)) +
			borderJoin +
			this.uiTheme.fg("mdListBullet", formatLimitCompact("W", this.statusState.codeLimits.weekly, this.statusState.codeLimits)) +
			borderEdgeRight;
		const bottomRight =
			borderEdgeLeft +
			this.uiTheme.fg("customMessageLabel", formatProjectName(this.ctx.cwd)) +
			borderJoin +
			(this.statusState.branch ? this.uiTheme.fg("mdLink", this.statusState.branch) : this.uiTheme.fg("dim", "no git")) +
			borderEdgeRight;
		this.bottomBorder = buildBorderLine(bottomLeft, bottomRight, this.frameWidth, this.uiTheme, "╰", "╯");
		return EDITOR_BOTTOM_MARKER;
	}
}

function refreshCodeLimits(cache: CodeLimCache, requestRender: () => void): void {
	if (cache.loading) return;
	cache.loading = true;

	execFile("codelim", ["--json"], { encoding: "utf8", timeout: 5000 }, (error, stdout) => {
		cache.loading = false;

		if (error) {
			cache.error = error.message;
			requestRender();
			return;
		}

		try {
			const parsed = JSON.parse(stdout) as CodeLimJson;
			cache.session = isCodeLimit(parsed.limits?.session) ? parsed.limits.session : null;
			cache.weekly = isCodeLimit(parsed.limits?.weekly) ? parsed.limits.weekly : null;
			cache.error = null;
		} catch (parseError) {
			cache.session = null;
			cache.weekly = null;
			cache.error = parseError instanceof Error ? parseError.message : String(parseError);
		}

		requestRender();
	});
}

function formatContextLeft(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	if (!usage || usage.percent === null) return "Context ? left";

	const left = Math.max(0, Math.min(100, 100 - usage.percent));
	return `Context ${Math.round(left)}% left`;
}

function renderStatusline(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	theme: Theme,
	branch: string | null,
	codeLimits: CodeLimCache,
): string {
	const model = ctx.model?.id || "no-model";
	const mode = resolveConstellationMode(pi.getFlag("constellation-mode"), ctx.sessionManager.getBranch());
	const parts = [
		`${theme.fg("accent", model)} ${colorForConstellationMode(theme, mode)}`,
		theme.fg("borderAccent", formatContextLeft(ctx)),
		theme.fg("warning", formatLimit("5h", codeLimits.session, codeLimits)),
		theme.fg("mdListBullet", formatLimit("Weekly", codeLimits.weekly, codeLimits)),
		theme.fg("customMessageLabel", formatProjectName(ctx.cwd)),
		branch ? theme.fg("mdLink", branch) : theme.fg("dim", "no git"),
	];

	return parts.join(sep(theme));
}

export default function (pi: ExtensionAPI) {
	let requestRender: (() => void) | undefined;
	let codeLimitTimer: ReturnType<typeof setInterval> | undefined;
	const codeLimits: CodeLimCache = { session: null, weekly: null, loading: false, error: null };

	const refresh = () => requestRender?.();

	pi.on("model_select", refresh);
	pi.on("thinking_level_select", refresh);
	pi.on("message_end", refresh);
	pi.on("turn_end", refresh);
	pi.on("session_compact", refresh);
	pi.on("session_tree", refresh);

	pi.on("session_shutdown", () => {
		if (codeLimitTimer) {
			clearInterval(codeLimitTimer);
			codeLimitTimer = undefined;
		}
		requestRender = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const statusState: StatusState = { branch: null, codeLimits };

		ctx.ui.setHeader((_tui, theme) => ({
			invalidate() {},
			render() {
				return formatStartupResources(pi, ctx).map((line) =>
					line.startsWith("[") ? theme.fg("mdHeading", line) : theme.fg("dim", line),
				);
			},
		}));

		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) =>
			new LimitEditor(tui, editorTheme, keybindings, ctx.ui.theme, ctx, pi, statusState),
		);

		ctx.ui.setFooter((tui, _theme, footerData) => {
			requestRender = () => tui.requestRender();
			statusState.branch = footerData.getGitBranch();
			refreshCodeLimits(codeLimits, refresh);
			if (codeLimitTimer) clearInterval(codeLimitTimer);
			codeLimitTimer = setInterval(() => refreshCodeLimits(codeLimits, refresh), 60_000);
			const unsubscribeBranch = footerData.onBranchChange(() => {
				statusState.branch = footerData.getGitBranch();
				refresh();
			});

			return {
				dispose() {
					unsubscribeBranch();
					ctx.ui.setEditorComponent(undefined);
					if (codeLimitTimer) {
						clearInterval(codeLimitTimer);
						codeLimitTimer = undefined;
					}
					if (requestRender) requestRender = undefined;
				},
				invalidate() {},
				render(): string[] {
					return [];
				},
			};
		});
	});
}
