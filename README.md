# Pi Amp-Style Harness

An installable, Amp-inspired agent harness for [Pi](https://github.com/earendil-works/pi). It provides two capability modes, isolated specialist subagents, bounded progress reporting, web research, and a TUI statusline that displays the harness mode instead of raw thinking effort.

This is an independent implementation built from Pi's public Extension API, the [Amp manual](https://ampcode.com/manual), the current [Amp modes page](https://ampcode.com/modes), and relevant MIT-licensed public projects. Amp's core harness is not public, and this project does not claim source compatibility with Amp.

## Requirements

- Pi 0.84.1
- Node.js 22.19 or newer
- An authenticated `openai-codex` provider

Before installing, authenticate once without loading extensions:

```sh
pi --no-extensions
```

Then run this command inside Pi:

```text
/login openai-codex
```

## Install

Install directly from GitHub:

```sh
pi install git:github.com/stellarjmr/pi-amp-harness
```

For project-local installation:

```sh
pi install -l git:github.com/stellarjmr/pi-amp-harness
```

During development, install the local checkout:

```sh
pi install /absolute/path/to/pi-amp-harness
```

Pi reads the `pi.extensions` manifest and loads `index.ts` directly. No build step or third-party Pi extension is required.

## Modes

| Mode | Main agent | Oracle |
|---|---|---|
| `high` | `openai-codex/gpt-5.6-sol:xhigh` | `openai-codex/gpt-5.6-sol:high` |
| `ultra` | `openai-codex/gpt-5.6-sol:max` | `openai-codex/gpt-5.6-sol:high` |

Select a mode with `/mode`, `/mode high`, `/mode ultra`, or `--harness-mode high|ultra`. The default is `high`. The selection is stored in the Pi session and restored when the session or branch changes.

The harness checks the selected preset before provider validation and again before each agent turn. Missing models and failed model switches stop explicitly instead of silently falling back to another model.

## Tools

| Tool | Model | Access | Purpose |
|---|---|---|---|
| `oracle` | Sol `high` | Read-only | Difficult reasoning, debugging, architecture, and high-impact review |
| `finder` | Terra `medium` | Read-only | Conceptual and multi-module local code discovery |
| `reviewer` | GPT-5.5 `high` | Read-only | Independent intent-first code and plan review |
| `librarian` | Sol `high` | Web-only | External repositories, dependency internals, and primary-source research |
| `task` | Current `high` or `ultra` mode | Read/write | Foreground implementation after the path is understood |
| `web_search` | Terra | Web-only | Current public web search with cited sources |
| `read_web_page` | None | Web-only | SSRF-safe bounded page retrieval and HTML-to-Markdown conversion |

The main agent handles simple work directly. It delegates only when an isolated context materially improves retrieval, judgment, review, or a known multi-step implementation.

Subagents run as fresh, sessionless `pi --mode json -p` processes with explicit models, reasoning levels, tools, and timeouts. They do not inherit the parent conversation. Automatic extension, skill, prompt-template, and theme discovery is disabled in children. Only the owned Librarian web entrypoint is loaded when web tools are required.

Read-only specialists cannot execute shell commands or edit files. `task` is the only writing child, runs sequentially in the caller's workspace, and cannot delegate further. The parent remains responsible for inspecting its diff and running integrated validation.

## Statusline

The TUI editor and statusline display `high` or `ultra`, never `xhigh` or `max`. They also show context remaining, project and branch information, and optional Codex usage limits when the external `codelim` command is available. Missing `codelim` does not prevent the extension from loading.

The statusline is disabled automatically in JSON, print, and RPC modes.

## Web authentication and security

`web_search` first asks Pi's public model-registry API for the credential and provider headers of the logged-in `openai-codex` model. It never reads `auth.json`, logs credentials, or persists tokens. A valid ChatGPT account ID is required before the Codex path can be selected.

The Codex path sends a bounded streaming request to `https://chatgpt.com/backend-api/codex/responses`. If Codex authentication is unavailable, a separately billed `OPENAI_API_KEY` can use `https://api.openai.com/v1/responses` instead. The request and response design follows patterns from the MIT-licensed [`pi-web-access`](https://github.com/nicobailon/pi-web-access) project.

The ChatGPT endpoint is a private backend rather than the public Platform API. No public source reviewed for this project explicitly prohibits this exact integration, but that is not an affirmative authorization or compliance guarantee. The MIT license covers source code, not OpenAI service terms or subscription rights. Use `OPENAI_API_KEY` or an official OpenAI client if a fully public, first-party documented transport is required.

`read_web_page` accepts only public HTTP(S) resources, validates DNS and SSRF policy on every redirect, pins each connection to the validated DNS answers, limits redirects and response sizes, and converts readable HTML to Markdown.

## Development

```sh
npm install
npm run check
npm run pack:check
```

The test suite covers mode enforcement, tool registration, child isolation, cancellation, temporary prompt cleanup, lifecycle progress, SSRF protections, response bounds, Codex authentication, API-key fallback, and credential redaction.

## License

MIT License. See [LICENSE](LICENSE).

## Contributor

- [stellarjmr](https://github.com/stellarjmr)
