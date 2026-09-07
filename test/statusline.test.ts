import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import {
	CustomEditor,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, type EditorTheme, getKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import statusline from "../extensions/statusline.js";

function createEditor(mode: "high" | "ultra" = "high"): CustomEditor {
	const plain = (text: string) => text;
	const editorTheme: EditorTheme = {
		borderColor: plain,
		selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
	};
	const tui = { terminal: { rows: 24 }, requestRender() {} } as TUI;
	let start: ((event: unknown, ctx: unknown) => void) | undefined;
	let editor: CustomEditor | undefined;
	statusline({
		on(event: string, handler: typeof start) {
			if (event === "session_start") start = handler;
		},
		getFlag: () => mode,
	} as never);
	assert.ok(start);
	start({}, {
		mode: "tui",
		cwd: "/workspace/project",
		sessionManager: { getBranch: () => [] },
		getContextUsage: () => ({ percent: 25 }),
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setHeader() {},
			setFooter() {},
			setEditorComponent(factory: NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>) {
				editor = factory(tui, editorTheme, getKeybindings() as KeybindingsManager) as CustomEditor;
			},
		},
	});
	assert.ok(editor instanceof CustomEditor);
	return editor;
}

function click(editor: CustomEditor, x: number, y: number, width: number, height: number): void {
	editor.handleMouse({
		type: "click", button: "left", x, y, screenX: x, screenY: y, width, height,
		shift: false, alt: false, ctrl: false,
	});
}

test("editor mouse clicks use the same text coordinates as rendering", () => {
	const editor = createEditor();
	editor.setText("abc");
	const lines = editor.render(80);
	const x = lines[1]!.indexOf("a");
	assert.ok(x >= 0);
	click(editor, x, 1, 80, lines.length);
	assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
});

test("editor preserves every autocomplete item below its border and accepts a mouse selection", async () => {
	const editor = createEditor();
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider([
		{ name: "alpha" }, { name: "beta" },
	], "/workspace/project"));
	editor.handleInput("/");
	await setImmediate();
	assert.equal(editor.isShowingAutocomplete(), true);
	const lines = editor.render(80);
	const borderRow = lines.findIndex((line) => line.startsWith("╰"));
	const alphaRow = lines.findIndex((line) => line.includes("alpha"));
	const betaRow = lines.findIndex((line) => line.includes("beta"));
	assert.ok(borderRow > 0);
	assert.ok(alphaRow > borderRow);
	assert.ok(betaRow > alphaRow);
	click(editor, 4, betaRow, 80, lines.length);
	assert.equal(editor.getText().trim(), "/beta");
});

test("editor keeps mode and context labels, scroll hints, and the standalone working indicator", () => {
	const editor = createEditor("ultra");
	assert.equal(editor.embedWorkingStatus, false);
	editor.setText(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"));
	const lines = editor.render(100);
	assert.match(lines[0]!, /75%.*ultra/);
	assert.doesNotMatch(lines.join("\n"), /xhigh|max/);
	assert.match(lines[0]!, /↑ \d+ more/);
	for (const width of [2, 10, 40, 100]) {
		for (const line of editor.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}`);
	}
});
