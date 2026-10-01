# Constellation — Agent Harness for Pi

A high-performance, two-mode multi-agent harness for [Pi](https://github.com/earendil-works/pi). Constellation provides isolated specialist subagents, bounded progress reporting, web research, and a TUI statusline that displays the active capability mode instead of raw thinking effort.

Constellation is an independent implementation built with Pi's public Extension API and relevant MIT-licensed public projects. It has no runtime dependency on third-party Pi extensions.

## Requirements

- Pi 0.85.1 or newer (tested with 0.85.1)
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
pi install git:github.com/stellarjmr/pi-constellation
```

For project-local installation:

```sh
pi install -l git:github.com/stellarjmr/pi-constellation
```

During development, install the local checkout:

```sh
pi install /absolute/path/to/pi-constellation
```

Pi reads the `pi.extensions` manifest and loads `index.ts` directly. No build step or third-party Pi extension is required.

## Agent instruction fallback

The package includes a fallback [`AGENTS.md`](AGENTS.md), but installing the package never copies, creates, replaces, or edits an instruction file in the user's Pi directory or project.

On every agent turn, the extension inspects the context files that Pi already discovered:

1. If Pi loaded any global, ancestor, project, or custom instruction file, the bundled fallback is not injected. The user's normal Pi instructions apply by themselves.
2. If Pi loaded no instruction file, the extension appends the bundled `AGENTS.md` to the main agent's system prompt and to isolated subagent prompts.
3. After `/reload`, a session switch, or a workspace change, Pi rebuilds its context and the extension evaluates the rule again on the next turn.

Pi 0.85.1 recognizes the first readable file in each applicable directory in this order: `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, then `CLAUDE.MD`. It loads the global Pi directory first, followed by project ancestors from outermost to innermost. Any resulting context file suppresses the package fallback; the extension does not reimplement or weaken Pi's native precedence rules.

An installed package's own `AGENTS.md` is not part of Pi's automatic project discovery. The extension reads its packaged copy through `import.meta.url`, and `package.json` includes the file in published archives. Running Pi from this repository is also safe: Pi discovers the repository file natively, so the extension does not inject a duplicate.

Each isolated subagent receives the main turn's instruction snapshot. Child Pi processes run with `--no-context-files`, so they cannot independently rediscover a different global or project file. This also preserves custom context supplied through Pi's SDK and keeps the opt-out behavior consistent between parent and child agents.

`--no-context-files` makes Pi report an empty context list, so the fallback remains active. Use `--no-constellation-agents` as well when no native or bundled instructions should be applied:

```sh
pi --no-context-files --no-constellation-agents
```

The complete bundled fallback is:

```markdown
# Constellation Autonomous Coding Rules

## Ownership and Execution

- The main agent owns understanding, implementation, integration, and verification. Work toward the requested outcome unless the user explicitly asks only for research, review, brainstorming, or a plan.
- Read enough relevant code and evidence to avoid guessing, then make the smallest correct change that follows the project's existing patterns.
- Keep unrelated worktree changes intact. Never discard, overwrite, or reformat work outside the requested scope.

## Tools and Delegation

- Handle simple and well-defined work directly. Delegate only when an isolated context materially improves code discovery, external research, difficult judgment, independent review, or a known substantial implementation.
- Use direct local tools for exact paths, symbols, and strings; use Finder for conceptual or multi-module local code discovery and Librarian for external repositories or dependency internals.
- Use Oracle selectively for difficult decisions, subtle debugging, architecture tradeoffs, or high-impact review. Use Reviewer when an independent intent-first review materially reduces risk.
- Give every subagent a self-contained goal, relevant paths and evidence, constraints, non-goals, and the required validation or output shape. The parent must inspect and integrate the result.
- Keep a single writer. Task is a foreground implementation agent, not a substitute for understanding the change, and must not run concurrently with another writer in the same workspace.

## Safety and Verification

- Do not expose credentials or other secrets. Ask before destructive or shared actions, including discarding work, deleting user data, committing, pushing, publishing, or changing shared infrastructure.
- Validate in proportion to risk with the narrowest useful test, typecheck, build, formatter, or manual check. Report failures and anything that remains unverified honestly.
- Follow higher-priority user instructions and every applicable project or scoped instruction file. When rules conflict, the more specific or higher-priority instruction wins.

## Communication

- Keep progress updates and final reports concise and evidence-based. State what changed, why it is correct, what was checked, and any remaining blocker or uncertainty.
```

## Modes

| Mode | Main agent | Oracle |
|---|---|---|
| `high` | `openai-codex/gpt-6-astra:xhigh` | `openai-codex/gpt-6-astra:xhigh` |
| `ultra` | `openai-codex/gpt-6-astra:max` | `openai-codex/gpt-6-astra:xhigh` |

Select a mode with `/mode`, `/mode high`, `/mode ultra`, or `--constellation-mode high|ultra`. The default is `high`. The selection is stored in the Pi session and restored when the session or branch changes.

Constellation checks the selected preset before provider validation and again before each agent turn. Missing models and failed model switches stop explicitly instead of silently falling back to another model.

## Tools

| Tool | Model | Access | Purpose |
|---|---|---|---|
| `oracle` | Astra `xhigh` | Read-only | Difficult reasoning, debugging, architecture, and high-impact review |
| `finder` | Terra `medium` | Read-only | Conceptual and multi-module local code discovery |
| `reviewer` | GPT-5.5 `high` | Read-only | Independent intent-first code and plan review |
| `librarian` | Astra `high` | Web-only | External repositories, dependency internals, and primary-source research |
| `task` | Current `high` or `ultra` mode | Read/write | Foreground implementation after the path is understood |
| `web_search` | Terra | Web-only | Current public web search with cited sources |
| `read_web_page` | None | Web-only | SSRF-safe bounded page retrieval and HTML-to-Markdown conversion |

The main agent handles simple work directly. It delegates only when an isolated context materially improves retrieval, judgment, review, or a known multi-step implementation.

Subagents run as fresh, sessionless `pi --mode json -p` processes with explicit models, reasoning levels, tools, and timeouts. They do not inherit the parent conversation. Automatic extension, skill, prompt-template, and theme discovery is disabled in children. Only the owned Librarian web entrypoint is loaded when web tools are required.

Read-only specialists cannot execute shell commands or edit files. `task` is the only writing child, runs sequentially in the caller's workspace, and cannot delegate further. The parent remains responsible for inspecting its diff and running integrated validation.

## Statusline

The TUI editor and statusline display `high` or `ultra`, never `xhigh` or `max`. They also show context remaining, project and branch information, and optional Codex usage limits when the external `codelim` command is available. Missing `codelim` does not prevent the extension from loading.

The editor has a full-width closed frame with at least two input rows. Pi handles text layout and scrolling inside the frame; Constellation adjusts mouse coordinates for the side borders and empty rows, with all autocomplete suggestions displayed below the bottom border. The working indicator is displayed separately from the custom borders.

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

The test suite covers mode enforcement, tool registration, child isolation, cancellation, temporary prompt cleanup, lifecycle progress, SSRF protections, response bounds, Codex authentication, API-key fallback, and credential redaction. It also loads the package through Pi's real SDK in an isolated temporary directory without making model requests, exercises editor mouse and autocomplete behavior, and checks SSE terminal events without trailing blank lines.

## License

MIT License. See [LICENSE](LICENSE).

## Contributor

- [stellarjmr](https://github.com/stellarjmr)
