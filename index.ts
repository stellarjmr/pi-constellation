import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import harness from "./extensions/harness/index.js";
import statusline from "./extensions/statusline.js";

export default function piAmpHarness(pi: ExtensionAPI): void {
	harness(pi);
	statusline(pi);
}
