import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import constellation from "./extensions/constellation/index.js";
import statusline from "./extensions/statusline.js";

export default function piConstellation(pi: ExtensionAPI): void {
	constellation(pi);
	statusline(pi);
}
