import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { Readability } from "@mozilla/readability";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { Type } from "typebox";

export type FetchLike = typeof fetch;
export type ResolvedAddress = { address: string; family: number };
export type Lookup = (hostname: string) => Promise<ResolvedAddress[]>;

const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_SEARCH_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const PAGE_TIMEOUT_MS = 20_000;
const SEARCH_TIMEOUT_MS = 60_000;
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function ipv4Number(address: string): number {
	return address.split(".").reduce((value, part) => value * 256 + Number(part), 0) >>> 0;
}

function isBlockedIpv4(address: string): boolean {
	const value = ipv4Number(address);
	const inRange = (base: string, bits: number): boolean =>
		(value >>> (32 - bits)) === (ipv4Number(base) >>> (32 - bits));

	return (
		inRange("0.0.0.0", 8) ||
		inRange("10.0.0.0", 8) ||
		inRange("100.64.0.0", 10) ||
		inRange("127.0.0.0", 8) ||
		inRange("169.254.0.0", 16) ||
		inRange("172.16.0.0", 12) ||
		inRange("192.0.0.0", 24) ||
		inRange("192.0.2.0", 24) ||
		inRange("192.88.99.0", 24) ||
		inRange("192.168.0.0", 16) ||
		inRange("198.18.0.0", 15) ||
		inRange("198.51.100.0", 24) ||
		inRange("203.0.113.0", 24) ||
		inRange("224.0.0.0", 4) ||
		inRange("240.0.0.0", 4)
	);
}

function parseIpv6(address: string): number[] | null {
	let expandedAddress = address;
	if (expandedAddress.includes(".")) {
		const lastColon = expandedAddress.lastIndexOf(":");
		const ipv4 = expandedAddress.slice(lastColon + 1);
		if (isIP(ipv4) !== 4) return null;
		const octets = ipv4.split(".").map(Number);
		if (octets.length !== 4) return null;
		expandedAddress = `${expandedAddress.slice(0, lastColon)}:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
	}

	const pieces = expandedAddress.split("::");
	if (pieces.length > 2) return null;
	const left = pieces[0] ? pieces[0].split(":") : [];
	const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
	const missing = 8 - left.length - right.length;
	if ((pieces.length === 1 && missing !== 0) || missing < 0) return null;

	const groups = [...left, ...Array(missing).fill("0"), ...right].map((part) =>
		/^[0-9a-f]{1,4}$/i.test(part) ? Number.parseInt(part, 16) : -1,
	);
	return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff) ? groups : null;
}

function ipv6Bytes(groups: number[]): Uint8Array {
	const bytes = new Uint8Array(16);
	for (let index = 0; index < groups.length; index++) {
		bytes[index * 2] = groups[index]! >> 8;
		bytes[index * 2 + 1] = groups[index]! & 0xff;
	}
	return bytes;
}

function matchesIpv6Prefix(groups: number[], base: string, prefix: number): boolean {
	const baseGroups = parseIpv6(base);
	if (!baseGroups) throw new Error(`Invalid internal IPv6 prefix: ${base}/${prefix}`);
	const address = ipv6Bytes(groups);
	const network = ipv6Bytes(baseGroups);
	const completeBytes = prefix >> 3;
	const remainingBits = prefix & 7;
	for (let index = 0; index < completeBytes; index++) {
		if (address[index] !== network[index]) return false;
	}
	if (remainingBits === 0) return true;
	const mask = (0xff << (8 - remainingBits)) & 0xff;
	return (address[completeBytes]! & mask) === (network[completeBytes]! & mask);
}

export function isForbiddenAddress(input: string): boolean {
	const address = input.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!;
	const version = isIP(address);
	if (version === 4) return isBlockedIpv4(address);
	if (version !== 6) return true;

	const groups = parseIpv6(address);
	if (!groups) return true;

	const mappedIpv4 = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
	if (mappedIpv4) {
		const embedded = [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join(".");
		return isBlockedIpv4(embedded);
	}

	// Block IPv4-compatible and translation/tunnelling ranges. They can encode a
	// private destination even though the outer address itself appears public.
	if (groups.slice(0, 6).every((group) => group === 0)) return true;
	if (matchesIpv6Prefix(groups, "::ffff:0:0:0", 96)) return true;
	if (matchesIpv6Prefix(groups, "64:ff9b::", 96)) return true;
	if (matchesIpv6Prefix(groups, "64:ff9b:1::", 48)) return true;
	if (matchesIpv6Prefix(groups, "2002::", 16)) return true;

	return (
		matchesIpv6Prefix(groups, "100::", 64) ||
		matchesIpv6Prefix(groups, "2001::", 23) ||
		matchesIpv6Prefix(groups, "2001:db8::", 32) ||
		matchesIpv6Prefix(groups, "3fff::", 20) ||
		matchesIpv6Prefix(groups, "5f00::", 16) ||
		matchesIpv6Prefix(groups, "fc00::", 7) ||
		matchesIpv6Prefix(groups, "fe80::", 10) ||
		matchesIpv6Prefix(groups, "fec0::", 10) ||
		matchesIpv6Prefix(groups, "ff00::", 8)
	);
}

async function resolvePublicAddresses(url: URL, lookup: Lookup): Promise<ResolvedAddress[]> {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only public HTTP(S) URLs are allowed");
	}
	if (url.username || url.password) throw new Error("URL credentials are forbidden");

	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (!hostname) throw new Error("URL must include a hostname");
	if (hostname === "localhost" || hostname.endsWith(".localhost")) {
		throw new Error(`Blocked internal hostname: ${hostname}`);
	}

	let addresses: ResolvedAddress[];
	if (isIP(hostname)) {
		addresses = [{ address: hostname, family: isIP(hostname) }];
	} else {
		try {
			addresses = await lookup(hostname);
		} catch (error) {
			throw new Error(`Failed to resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	if (addresses.length === 0) throw new Error(`Failed to resolve ${hostname}: no addresses returned`);
	for (const resolved of addresses) {
		if (isForbiddenAddress(resolved.address)) {
			throw new Error(`URL resolves to a private or reserved address: ${resolved.address}`);
		}
	}
	return addresses;
}

export function createPinnedLookup(addresses: readonly ResolvedAddress[]): LookupFunction {
	const pinned = addresses.map((entry) => ({ address: entry.address, family: entry.family }));
	return (_hostname, options, callback) => {
		const family = options.family;
		const eligible = family === 4 || family === 6 ? pinned.filter((entry) => entry.family === family) : pinned;
		if (eligible.length === 0) {
			const error = new Error(`No validated address for requested family ${family}`) as NodeJS.ErrnoException;
			error.code = "ENOTFOUND";
			callback(error, "");
			return;
		}
		if (options.all) {
			callback(null, eligible);
			return;
		}
		callback(null, eligible[0]!.address, eligible[0]!.family);
	};
}

function responseHeaders(rawHeaders: string[]): Headers {
	const headers = new Headers();
	for (let index = 0; index < rawHeaders.length; index += 2) {
		const name = rawHeaders[index];
		const value = rawHeaders[index + 1];
		if (name && value !== undefined) headers.append(name, value);
	}
	return headers;
}

async function requestPinned(
	url: URL,
	addresses: readonly ResolvedAddress[],
	signal: AbortSignal,
): Promise<Response> {
	return new Promise<Response>((resolve, reject) => {
		const request = url.protocol === "https:" ? httpsRequest : httpRequest;
		const outgoing = request(
			url,
			{
				method: "GET",
				headers: {
					Accept: "text/html,application/xhtml+xml,text/plain,application/json,text/markdown;q=0.9,*/*;q=0.1",
					"User-Agent": "pi-amp-harness/1.0",
				},
				lookup: createPinnedLookup(addresses),
				signal,
			},
			(incoming) => {
				const status = incoming.statusCode ?? 500;
				const noBody = status === 204 || status === 304;
				const body = noBody ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
				try {
					resolve(new Response(body, { status, headers: responseHeaders(incoming.rawHeaders) }));
				} catch (error) {
					incoming.destroy();
					reject(error);
				}
			},
		);
		outgoing.once("error", reject);
		outgoing.end();
	});
}

async function cancelBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// Cancellation is best effort after a terminal policy or size decision.
	}
}

export type RequestLike = (
	url: URL,
	addresses: readonly ResolvedAddress[],
	signal: AbortSignal,
) => Promise<Response>;

async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > limit) {
		await cancelBody(response);
		throw new Error(`Response exceeds ${limit} byte limit`);
	}
	if (!response.body) return new Uint8Array();

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				try {
					await reader.cancel();
				} catch {
					// Preserve the policy error if transport cancellation itself fails.
				}
				throw new Error(`Response exceeds ${limit} byte limit`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

export interface ReadWebPageDependencies {
	fetch?: FetchLike;
	lookup?: Lookup;
	request?: RequestLike;
	signal?: AbortSignal;
	maxBytes?: number;
}

export async function readWebPage(
	rawUrl: string,
	dependencies: ReadWebPageDependencies = {},
): Promise<{ url: string; content: string; title?: string }> {
	const lookup: Lookup = dependencies.lookup ?? ((hostname) => dnsLookup(hostname, { all: true }));
	const timeout = AbortSignal.timeout(PAGE_TIMEOUT_MS);
	const signal = dependencies.signal ? AbortSignal.any([dependencies.signal, timeout]) : timeout;
	let url = new URL(rawUrl);

	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
		signal.throwIfAborted();
		const addresses = await resolvePublicAddresses(url, lookup);
		const response = dependencies.fetch
			? await dependencies.fetch(url, { redirect: "manual", signal })
			: await (dependencies.request ?? requestPinned)(url, addresses, signal);

		if (REDIRECT_STATUSES.has(response.status)) {
			const location = response.headers.get("location");
			await cancelBody(response);
			if (!location) throw new Error("Redirect response lacks Location header");
			if (redirects === MAX_REDIRECTS) throw new Error(`Too many redirects fetching ${url.toString()}`);
			url = new URL(location, url);
			continue;
		}

		if (!response.ok) {
			await cancelBody(response);
			throw new Error(`HTTP ${response.status} fetching ${url.toString()}`);
		}

		const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
		const supported =
			contentType.includes("html") ||
			contentType.startsWith("text/") ||
			contentType.includes("json") ||
			contentType.includes("markdown");
		if (!supported) {
			await cancelBody(response);
			throw new Error(`Unsupported content type: ${contentType || "unknown"}`);
		}

		const bytes = await readLimited(response, dependencies.maxBytes ?? MAX_PAGE_BYTES);
		const text = new TextDecoder().decode(bytes);
		if (!contentType.includes("html")) return { url: url.toString(), content: text };

		const { document } = parseHTML(text);
		Object.defineProperty(document, "baseURI", { configurable: true, value: url.toString() });
		const article = new Readability(document as unknown as Document).parse();
		const html = article?.content ?? document.body?.innerHTML ?? "";
		const markdown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }).turndown(html);
		const title = article?.title?.trim() || undefined;
		return {
			url: url.toString(),
			title,
			content: title ? `# ${title}\n\n${markdown}` : markdown,
		};
	}

	throw new Error(`Too many redirects fetching ${url.toString()}`);
}

type CodexSearchAuth = {
	kind: "codex";
	apiKey: string;
	accountId: string;
	headers: Record<string, string>;
};

type PlatformSearchAuth = {
	kind: "platform";
	apiKey: string;
	headers: Record<string, string>;
};

type SearchAuth = CodexSearchAuth | PlatformSearchAuth;

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const pieces = token.split(".");
	if (pieces.length !== 3 || !pieces[1]) return null;
	try {
		const base64 = pieces[1].replace(/-/g, "+").replace(/_/g, "/");
		const parsed: unknown = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function codexAccountId(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	const auth = payload?.["https://api.openai.com/auth"];
	if (!auth || typeof auth !== "object") return undefined;
	const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
	return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
}

async function resolveSearchAuth(ctx: ExtensionContext, env: NodeJS.ProcessEnv): Promise<SearchAuth> {
	const model = ctx.modelRegistry
		.getAll()
		.find((candidate) => candidate.provider === "openai-codex" && candidate.id === "gpt-5.6-terra");
	if (model) {
		const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (resolved.ok && resolved.apiKey) {
			const accountId = codexAccountId(resolved.apiKey);
			if (accountId) {
				return {
					kind: "codex",
					apiKey: resolved.apiKey,
					accountId,
					headers: Object.fromEntries(
						Object.entries(resolved.headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== null),
					),
				};
			}
		}
	}

	const apiKey = env.OPENAI_API_KEY?.trim();
	if (apiKey) {
		return { kind: "platform", apiKey, headers: {} };
	}
	throw new Error("OpenAI web search credentials unavailable; use /login openai-codex or set OPENAI_API_KEY");
}

function redact(text: string, secret: string): string {
	return text.split(secret).join("[REDACTED]").replace(/Bearer\s+[\w.-]+/gi, "Bearer [REDACTED]");
}

function cleanSourceUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		if (url.searchParams.get("utm_source") !== "openai") return rawUrl;
		url.searchParams.delete("utm_source");
		return url.toString();
	} catch {
		return rawUrl;
	}
}

export function extractSearchResponse(
	data: Record<string, unknown>,
	maxResults = 5,
): { answer: string; sources: Array<{ title: string; url: string }> } {
	const output = Array.isArray(data.output) ? data.output : [];
	const answers: string[] = [];
	const sources = new Map<string, string>();
	const addSource = (url: unknown, title: unknown): void => {
		if (typeof url !== "string" || !url.trim()) return;
		const cleaned = cleanSourceUrl(url);
		if (!sources.has(cleaned)) sources.set(cleaned, typeof title === "string" && title.trim() ? title : cleaned);
	};

	for (const item of output) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (record.type === "message" && Array.isArray(record.content)) {
			for (const part of record.content) {
				if (!part || typeof part !== "object") continue;
				const content = part as Record<string, unknown>;
				if (typeof content.text === "string" && content.text.trim()) answers.push(content.text);
				if (Array.isArray(content.annotations)) {
					for (const annotation of content.annotations) {
						if (!annotation || typeof annotation !== "object") continue;
						const citation = annotation as Record<string, unknown>;
						addSource(citation.url, citation.title);
					}
				}
			}
		}
		if (record.type === "web_search_call") {
			const action = record.action as Record<string, unknown> | undefined;
			const groups = [action?.sources, record.sources, record.results];
			for (const group of groups) {
				if (!Array.isArray(group)) continue;
				for (const source of group) {
					if (!source || typeof source !== "object") continue;
					const entry = source as Record<string, unknown>;
					addSource(entry.url ?? entry.source_website_url, entry.title ?? entry.caption);
				}
			}
		}
	}

	return {
		answer: answers.join("\n").trim(),
		sources: [...sources]
			.slice(0, Math.max(1, Math.min(maxResults, 10)))
			.map(([url, title]) => ({ title, url })),
	};
}

function searchFailureMessage(value: unknown, fallback: string): string {
	if (!value || typeof value !== "object") return fallback;
	const record = value as Record<string, unknown>;
	const error = record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : undefined;
	const incomplete =
		record.incomplete_details && typeof record.incomplete_details === "object"
			? (record.incomplete_details as Record<string, unknown>)
			: undefined;
	if (typeof record.message === "string" && record.message) return record.message;
	if (typeof error?.message === "string" && error.message) return error.message;
	if (typeof error?.code === "string" && error.code) return error.code;
	if (typeof incomplete?.reason === "string" && incomplete.reason) return `incomplete: ${incomplete.reason}`;
	return fallback;
}

function assertCompletedSearchResponse(response: Record<string, unknown>, fallback: string): void {
	const status = response.status;
	if (typeof status === "string" && status !== "completed") {
		throw new Error(searchFailureMessage(response, `${fallback} (${status})`));
	}
}

function parseSearchPayload(text: string): Record<string, unknown> {
	if (text.trimStart().startsWith("{")) {
		const response = JSON.parse(text) as Record<string, unknown>;
		if (response.error) throw new Error(searchFailureMessage(response, "web_search failed"));
		assertCompletedSearchResponse(response, "web_search did not complete");
		return response;
	}

	let completed: Record<string, unknown> | undefined;
	const items: unknown[] = [];
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	for (const frame of normalized.split(/\n\n+/)) {
		const dataLines = frame
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim());
		if (dataLines.length === 0) continue;
		const raw = dataLines.join("\n").trim();
		if (!raw || raw === "[DONE]") continue;

		let event: Record<string, unknown>;
		try {
			event = JSON.parse(raw) as Record<string, unknown>;
		} catch (error) {
			throw new Error(`Invalid web_search SSE JSON: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (event.type === "error") throw new Error(searchFailureMessage(event, "web_search failed"));
		if (event.type === "response.failed") {
			throw new Error(searchFailureMessage(event.response, "web_search response failed"));
		}
		if (event.type === "response.incomplete") {
			throw new Error(searchFailureMessage(event.response, "web_search response was incomplete"));
		}
		if (event.type === "response.output_item.done" && event.item) items.push(event.item);
		if (event.type === "response.completed" || event.type === "response.done") {
			if (!event.response || typeof event.response !== "object") {
				throw new Error("web_search terminal event lacks a response");
			}
			completed = event.response as Record<string, unknown>;
			assertCompletedSearchResponse(completed, "web_search did not complete");
			break;
		}
	}

	if (!completed) throw new Error("web_search stream ended before a terminal response event");
	return Array.isArray(completed.output) && completed.output.length > 0 ? completed : { ...completed, output: items };
}

export async function webSearch(
	ctx: ExtensionContext,
	objective: string,
	queries: string[],
	maxResults: number,
	dependencies: { fetch?: FetchLike; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<{ answer: string; sources: Array<{ title: string; url: string }> }> {
	dependencies.signal?.throwIfAborted();
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	const signal = dependencies.signal ? AbortSignal.any([dependencies.signal, timeout]) : timeout;
	const auth = await resolveSearchAuth(ctx, dependencies.env ?? process.env);
	signal.throwIfAborted();
	const endpoint = auth.kind === "codex" ? CODEX_RESPONSES_URL : OPENAI_RESPONSES_URL;
	const headers = new Headers(auth.headers);
	headers.set("Authorization", `Bearer ${auth.apiKey}`);
	headers.set("Accept", "text/event-stream");
	headers.set("Content-Type", "application/json");
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("User-Agent", "pi-amp-harness/1.0");
	if (auth.kind === "codex") {
		headers.set("originator", "pi");
		headers.set("chatgpt-account-id", auth.accountId);
	}

	const normalizedQueries = queries.map((query) => query.trim()).filter(Boolean).slice(0, 3);
	const searchQueries = normalizedQueries.length > 0 ? normalizedQueries : [objective];
	const body = {
		model: "gpt-5.6-terra",
		instructions: [
			"Search the web and answer the objective using only the retrieved sources.",
			"Prefer primary and current sources. Include clickable citations in the answer.",
			`Objective: ${objective}`,
			`Return up to ${Math.max(1, Math.min(maxResults, 10))} distinct sources.`,
		].join(" "),
		input: [
			{
				role: "user",
				content: [{ type: "input_text", text: searchQueries.map((query) => `- ${query}`).join("\n") }],
			},
		],
		tools: [{ type: "web_search" }],
		include: ["web_search_call.action.sources"],
		store: false,
		stream: true,
		tool_choice: "required",
		parallel_tool_calls: true,
	};

	try {
		const response = await (dependencies.fetch ?? fetch)(endpoint, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal,
		});
		const bytes = await readLimited(response, MAX_SEARCH_BYTES);
		const text = new TextDecoder().decode(bytes);
		if (!response.ok) throw new Error(`OpenAI API error ${response.status}: ${text.slice(0, 300)}`);

		const result = extractSearchResponse(parseSearchPayload(text), maxResults);
		if (!result.answer && result.sources.length === 0) throw new Error("web_search returned no answer or sources");
		return result;
	} catch (error) {
		throw new Error(redact(error instanceof Error ? error.message : String(error), auth.apiKey));
	}
}

export function registerWebTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search current public web information for a focused objective and return cited sources.",
		parameters: Type.Object({
			objective: Type.String({ description: "What the research must establish and why" }),
			search_queries: Type.Optional(
				Type.Array(Type.String(), {
					description: "One to three short, complementary search queries",
					minItems: 1,
					maxItems: 3,
				}),
			),
			max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
		}),
		async execute(_id, parameters, signal, _onUpdate, ctx) {
			const result = await webSearch(
				ctx,
				parameters.objective,
				parameters.search_queries ?? [],
				parameters.max_results ?? 5,
				{ signal },
			);
			const sources = result.sources.map((source) => `- [${source.title}](${source.url})`).join("\n");
			return {
				content: [{ type: "text", text: `${result.answer}\n\nSources:\n${sources || "(none returned)"}` }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "read_web_page",
		label: "Read Web Page",
		description: "Safely fetch one public HTTP(S) page and return bounded readable Markdown or text.",
		parameters: Type.Object({
			url: Type.String(),
			objective: Type.Optional(Type.String({ description: "Why this page is being read" })),
			full_content: Type.Optional(
				Type.Boolean({ description: "Accepted for Amp-style compatibility; output is always bounded full content" }),
			),
		}),
		async execute(_id, parameters, signal) {
			const result = await readWebPage(parameters.url, { signal });
			const context = parameters.objective ? `Objective context: ${parameters.objective}\n\n` : "";
			return {
				content: [{ type: "text", text: context + result.content }],
				details: { url: result.url, title: result.title, fullContent: true },
			};
		},
	});
}
