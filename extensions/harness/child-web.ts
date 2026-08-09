import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWebTools } from "./web.js";

export default function childWeb(pi: ExtensionAPI): void {
	registerWebTools(pi);
}
