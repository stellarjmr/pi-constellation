import assert from "node:assert/strict";
import test from "node:test";
import {
	createPinnedLookup,
	extractSearchResponse,
	isForbiddenAddress,
	readWebPage,
	webSearch,
} from "../extensions/harness/web.js";

const PUBLIC_ADDRESS = { address: "93.184.216.34", family: 4 };
const publicDns = async () => [PUBLIC_ADDRESS];

function codexToken(accountId = "account-123"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function codexContext(apiKey: string, headers: Record<string, string> = {}) {
	return {
		modelRegistry: {
			getAll: () => [{ provider: "openai-codex", id: "gpt-5.6-terra" }],
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey, headers }),
		},
	};
}

test("SSRF policy rejects private, reserved, mapped, translated, and tunnelled addresses", () => {
	for (const address of [
		"127.0.0.1",
		"10.1.2.3",
		"100.64.0.1",
		"169.254.169.254",
		"::1",
		"fc00::1",
		"fe80::1",
		"::ffff:192.168.1.2",
		"::ffff:0:10.0.0.1",
		"::ffff:0:8.8.8.8",
		"64:ff9b::0a00:0001",
		"64:ff9b:1::1",
		"2002:0a00:0001::1",
		"2001:db8::1",
	]) {
		assert.equal(isForbiddenAddress(address), true, address);
	}
	assert.equal(isForbiddenAddress("8.8.8.8"), false);
	assert.equal(isForbiddenAddress("2606:4700:4700::1111"), false);
});

test("pinned lookup ignores a second hostname resolution", async () => {
	const lookup = createPinnedLookup([PUBLIC_ADDRESS]);
	const result = await new Promise<{ address: string; family?: number }>((resolve, reject) => {
		lookup("rebinding.test", { family: 0, all: false }, (error, address, family) => {
			if (error) reject(error);
			else resolve({ address: address as string, family });
		});
	});
	assert.deepEqual(result, PUBLIC_ADDRESS);
});

test("page transport receives exactly the DNS addresses validated for that request", async () => {
	let lookups = 0;
	let connectedAddress = "";
	const result = await readWebPage("https://rebinding.test/page", {
		lookup: async () => {
			lookups++;
			return [PUBLIC_ADDRESS];
		},
		request: async (_url, addresses) => {
			connectedAddress = addresses[0]?.address ?? "";
			return new Response("safe", { headers: { "content-type": "text/plain" } });
		},
	});
	assert.equal(result.content, "safe");
	assert.equal(lookups, 1);
	assert.equal(connectedAddress, PUBLIC_ADDRESS.address);
});

test("every redirect target is DNS checked again", async () => {
	let dnsChecks = 0;
	let requests = 0;
	await assert.rejects(
		() =>
			readWebPage("https://good.test", {
				lookup: async (hostname) => {
					dnsChecks++;
					return [hostname === "evil.test" ? { address: "127.0.0.1", family: 4 } : PUBLIC_ADDRESS];
				},
				request: async () => {
					requests++;
					return new Response(null, { status: 302, headers: { location: "http://evil.test/x" } });
				},
			}),
		/private or reserved/,
	);
	assert.equal(dnsChecks, 2);
	assert.equal(requests, 1);
});

test("a mixed public/private DNS answer is rejected before transport", async () => {
	let requested = false;
	await assert.rejects(
		() =>
			readWebPage("https://mixed.test", {
				lookup: async () => [PUBLIC_ADDRESS, { address: "10.0.0.1", family: 4 }],
				request: async () => {
					requested = true;
					return new Response("unsafe");
				},
			}),
		/private or reserved/,
	);
	assert.equal(requested, false);
});

test("stream and declared content lengths are bounded", async () => {
	await assert.rejects(
		() =>
			readWebPage("https://stream.test", {
				lookup: publicDns,
				request: async () => new Response("123456", { headers: { "content-type": "text/plain" } }),
				maxBytes: 5,
			}),
		/byte limit/,
	);
	await assert.rejects(
		() =>
			readWebPage("https://length.test", {
				lookup: publicDns,
				request: async () =>
					new Response("x", {
						headers: { "content-type": "text/plain", "content-length": "100" },
					}),
				maxBytes: 5,
			}),
		/byte limit/,
	);
});

test("an already-aborted page request does not resolve DNS or start transport", async () => {
	const controller = new AbortController();
	controller.abort();
	let networkTouched = false;
	await assert.rejects(
		() =>
			readWebPage("https://aborted.test", {
				signal: controller.signal,
				lookup: async () => {
					networkTouched = true;
					return [PUBLIC_ADDRESS];
				},
				request: async () => {
					networkTouched = true;
					return new Response("late");
				},
			}),
		/abort/i,
	);
	assert.equal(networkTouched, false);
});

test("HTML pages are reduced to readable Markdown", async () => {
	const page = await readWebPage("https://article.test", {
		lookup: publicDns,
		request: async () =>
			new Response(
				"<html><head><title>Example</title></head><body><main><h1>Heading</h1><p>Useful text.</p></main></body></html>",
				{ headers: { "content-type": "text/html; charset=utf-8" } },
			),
	});
	assert.match(page.content, /Heading/);
	assert.match(page.content, /Useful text/);
});

test("search response extraction deduplicates cited sources", () => {
	assert.deepEqual(
		extractSearchResponse(
			{
				output: [
					{
						type: "message",
						content: [
							{
								text: "answer",
								annotations: [
									{ url: "https://a.test?utm_source=openai", title: "A" },
									{ url: "https://a.test/", title: "duplicate" },
								],
							},
						],
					},
				],
			},
			3,
		),
		{ answer: "answer", sources: [{ title: "A", url: "https://a.test/" }] },
	);
});

test("Codex web search uses Pi-managed auth with required account and originator headers", async () => {
	const ctx = codexContext(codexToken(), { "x-existing": "yes" });
	let endpoint = "";
	let headers = new Headers();
	let requestBody: Record<string, unknown> = {};
	const result = await webSearch(ctx as never, "current fact", ["query one"], 3, {
		fetch: async (url, init) => {
			endpoint = String(url);
			headers = new Headers(init?.headers);
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(
				JSON.stringify({ output: [{ type: "message", content: [{ text: "answer", annotations: [] }] }] }),
				{ headers: { "content-type": "application/json" } },
			);
		},
	});
	assert.equal(result.answer, "answer");
	assert.equal(endpoint, "https://chatgpt.com/backend-api/codex/responses");
	assert.equal(headers.get("originator"), "pi");
	assert.equal(headers.get("chatgpt-account-id"), "account-123");
	assert.equal(headers.get("x-existing"), "yes");
	assert.equal(requestBody.model, "gpt-5.6-terra");
});

test("web search falls back to a separately billed API key on the public endpoint", async () => {
	const ctx = {
		modelRegistry: {
			getAll: () => [],
		},
	};
	let endpoint = "";
	let headers = new Headers();
	const result = await webSearch(ctx as never, "current fact", ["query one"], 3, {
		env: { OPENAI_API_KEY: "  platform-api-key  " },
		fetch: async (url, init) => {
			endpoint = String(url);
			headers = new Headers(init?.headers);
			return new Response(
				JSON.stringify({ output: [{ type: "message", content: [{ text: "answer", annotations: [] }] }] }),
				{ headers: { "content-type": "application/json" } },
			);
		},
	});
	assert.equal(result.answer, "answer");
	assert.equal(endpoint, "https://api.openai.com/v1/responses");
	assert.equal(headers.get("authorization"), "Bearer platform-api-key");
	assert.equal(headers.has("originator"), false);
	assert.equal(headers.has("chatgpt-account-id"), false);
});

test("web search fails before transport when neither Pi login nor an API key is available", async () => {
	let requested = false;
	const ctx = { modelRegistry: { getAll: () => [] } };
	await assert.rejects(
		() =>
			webSearch(ctx as never, "current fact", ["query one"], 3, {
				env: {},
				fetch: async () => {
					requested = true;
					return new Response();
				},
			}),
		/use \/login openai-codex or set OPENAI_API_KEY/,
	);
	assert.equal(requested, false);
});

test("opaque Codex credentials never reach the private endpoint", async () => {
	const ctx = codexContext("opaque-credential");
	let endpoint = "";
	const result = await webSearch(ctx as never, "current fact", ["query one"], 3, {
		env: { OPENAI_API_KEY: "platform-api-key" },
		fetch: async (url) => {
			endpoint = String(url);
			return new Response(
				JSON.stringify({ output: [{ type: "message", content: [{ text: "answer", annotations: [] }] }] }),
			);
		},
	});
	assert.equal(result.answer, "answer");
	assert.equal(endpoint, "https://api.openai.com/v1/responses");

	let requested = false;
	await assert.rejects(
		() =>
			webSearch(ctx as never, "current fact", ["query one"], 3, {
				env: {},
				fetch: async () => {
					requested = true;
					return new Response();
				},
			}),
		/OpenAI web search credentials unavailable/,
	);
	assert.equal(requested, false);
});

test("an already-aborted web search does not resolve credentials or start transport", async () => {
	const controller = new AbortController();
	controller.abort();
	let registryReads = 0;
	let requested = false;
	const ctx = {
		modelRegistry: {
			getAll: () => {
				registryReads++;
				return [];
			},
		},
	};
	await assert.rejects(
		() =>
			webSearch(ctx as never, "current fact", ["query one"], 3, {
				signal: controller.signal,
				env: { OPENAI_API_KEY: "platform-api-key" },
				fetch: async () => {
					requested = true;
					return new Response();
				},
			}),
		/aborted/i,
	);
	assert.equal(registryReads, 0);
	assert.equal(requested, false);
});

test("Codex SSE terminal failures override previously collected search items", async () => {
	const secret = codexToken();
	const ctx = codexContext(secret);
	const partial = `data: ${JSON.stringify({
		type: "response.output_item.done",
		item: { type: "web_search_call", action: { sources: [{ url: "https://partial.test" }] } },
	})}\n\n`;
	const cases = [
		{
			event: { type: "response.failed", response: { status: "failed", error: { message: "backend failed" } } },
			expected: /backend failed/,
		},
		{
			event: {
				type: "response.incomplete",
				response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
			},
			expected: /max_output_tokens/,
		},
	];

	for (const testCase of cases) {
		await assert.rejects(
			() =>
				webSearch(ctx as never, "x", ["x"], 3, {
					fetch: async () =>
						new Response(`${partial}data: ${JSON.stringify(testCase.event)}\n\n`, {
							headers: { "content-type": "text/event-stream" },
						}),
				}),
			testCase.expected,
		);
	}
});

test("malformed Codex SSE data is rejected", async () => {
	const ctx = codexContext(codexToken());
	await assert.rejects(
		() =>
			webSearch(ctx as never, "x", ["x"], 3, {
				fetch: async () =>
					new Response("data: {not-json}\n\n", { headers: { "content-type": "text/event-stream" } }),
			}),
		/Invalid web_search SSE JSON/,
	);
});

test("web search redacts authentication secrets from errors", async () => {
	const secret = codexToken();
	const ctx = codexContext(secret);
	await assert.rejects(
		() =>
			webSearch(ctx as never, "x", ["x"], 3, {
				fetch: async () => new Response(secret, { status: 401 }),
			}),
		(error) => error instanceof Error && !error.message.includes(secret) && error.message.includes("REDACTED"),
	);
});
