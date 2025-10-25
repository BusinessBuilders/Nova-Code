# Repository Guidelines

https://github.com/QwenLM/qwen-code

#has local model support https://github.com/cline/cline/

## Project Structure & Module Organization

Gemini CLI is split across npm workspaces: `packages/cli` (UX + entrypoints),
`packages/core` (config, transport, provider selection), `packages/a2a-server`
(agent bridge), `packages/test-utils` (shared fixtures), and
`packages/vscode-ide-companion` (IDE hooks). `integration-tests/` stores
black-box specs, `scripts/` holds release automation, and `docs/` contains the
public site. Add new code next to the owning package and re-export via its
`src/index.ts`. Review `Codex.md` before touching auth/config so
Gemini/OpenAI/local engines stay consistent.

## Build, Test, and Development Commands

`npm install` (or `make install`) hydrates dependencies. `npm run generate`
refreshes git metadata, `npm run build` compiles the CLI, and
`npm run build:sandbox` / `npm run build:all` cover sandbox + IDE bundles.
`npm run start` uses `.gemini/config.yaml`; add `DEBUG=1` or run `npm run debug`
for inspector mode. Testing shortcuts: `npm run test` (all workspaces),
`npm run test:integration:sandbox:none` (fast path),
`npm run test:integration:sandbox:docker` (pre-release), and `npm run test:ci`
(coverage). Enforce quality with `npm run lint`, `npm run format`,
`npm run typecheck`, or the combined `make preflight`.

## Coding Style & Naming Conventions

Stick to TypeScript ES modules; no CommonJS. Prettier (2-space indent, single
quotes, trailing commas) plus ESLint (`eslint.config.js`) define
formatting—`npm run lint:fix` applies both. Use kebab-case for directories,
camelCase for locals/functions, PascalCase for exported classes/components, and
verb-based npm scripts (`sync:providers`, `build:sandbox`). Within
`packages/core`, prefer dependency injection so provider adapters remain
swappable.

## Testing Guidelines

Vitest powers all suites. Keep `*.test.ts` beside their sources, import helpers
from `packages/test-utils`, and place scenario coverage under
`integration-tests/<feature>`. `npm run test:ci` emits coverage; hold each
package near its current ~80 % level (`packages/*/coverage`). Provider adapters
must test streaming, tool-call, and telemetry cases from the matrix in
`Codex.md`. Always run both `sandbox:none` and `sandbox:docker` before
requesting review.

## Commit & Pull Request Guidelines

Use Conventional Commits (`type(scope): summary (#1234)`) like the existing
history. PR descriptions must state motivation, functional changes, and test
proof (command output or screenshots). Link any ROADMAP or Codex tasks so the
provider work stays auditable, tag CODEOWNERS, and only assign reviewers once CI
passes.

## Provider & Security Notes

Never commit secrets; `.env` and nested `.gemini/` remain local. Rely on
`GEMINI_SANDBOX`, `OPENAI_API_KEY`, and `LOCAL_MODEL_*` to exercise the
multi-provider paths. Run `npm run auth:docker` before sandbox-dependent tests,
and scrub sensitive details from logs attached to issues.
