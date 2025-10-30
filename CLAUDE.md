# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a fork of `google-gemini/gemini-cli` (now rebranded as "Gemini CLI") with modifications to support multiple AI providers including Google Gemini, OpenAI GPT models, and local models via Ollama/DeepSeek. The project maintains all core agentic features (tooling, policy, telemetry, IDE integrations) while enabling provider flexibility.

See `Codex.md` for the detailed master plan and current implementation status of multi-provider support.

## Essential Development Commands

### Build and Run
```bash
# Install dependencies (required after clone or package.json changes)
npm install
# or
make install

# Generate git metadata (run before build)
npm run generate

# Build entire project (all packages)
npm run build

# Build sandbox container
npm run build:sandbox

# Build all including sandbox + IDE bundles
npm run build:all

# Start CLI from source (uses .gemini/config.yaml)
npm start

# Debug mode with inspector
npm run debug
# or
DEBUG=1 npm start
```

### Testing
```bash
# Run all unit tests
npm run test

# Run integration tests (end-to-end)
npm run test:e2e

# Run full test suite including integration tests
npm run test:integration:all

# Run tests without sandbox
npm run test:integration:sandbox:none

# Run tests with Docker sandbox
npm run test:integration:sandbox:docker

# Run CI test suite
npm run test:ci
```

### Quality Checks
```bash
# CRITICAL: Run before submitting any changes
npm run preflight
# or
make preflight

# This single command runs: clean, install, format, lint, build, typecheck, and test:ci

# Individual quality commands
npm run lint          # Run ESLint
npm run lint:fix      # Auto-fix linting + format with Prettier
npm run format        # Format with Prettier only
npm run typecheck     # Run TypeScript type checking
```

## Monorepo Structure

This is a **Node.js monorepo** using npm workspaces:

```
packages/
├── cli/              # Command-line interface (user-facing)
├── core/             # Backend logic, API orchestration, tool execution
├── a2a-server/       # Agent-to-agent communication server
├── test-utils/       # Shared testing utilities
└── vscode-ide-companion/  # VS Code extension

integration-tests/    # End-to-end integration tests
scripts/              # Build, release, and utility scripts
docs/                 # Comprehensive documentation
```

### Key Architecture Patterns

**CLI ↔ Core Separation**: The `cli` package (React/Ink UI) is completely separate from `core` (backend logic). The `core` package handles all AI model interactions, tool execution, and state management. This separation enables different frontends (CLI, IDE extensions) to use the same backend.

**Provider Abstraction**: AI model providers (Gemini, OpenAI, Ollama) are abstracted through a unified interface in `packages/core`. Provider selection is configured via environment variables or settings file (`~/.gemini/settings.json`).

**Tool System**: Extensions to AI capabilities are implemented as tools in `packages/core/src/tools/`. Tools can be built-in (file system, shell, web fetch) or provided via MCP (Model Context Protocol) servers.

## Multi-Provider Support (Critical Implementation Details)

### Current Status (from Codex.md and AGENTS.md)
- ✅ Auth surface and provider selection complete
- ✅ Local model config plumbing complete
- ✅ **OpenAI client shipped** with streaming + tool-call parity + OpenRouter headers
- ✅ **Ollama adapter shipped** with strict tool_call instructions, streaming parser, fenced tool_result echoes
- ✅ Vitest coverage + docs for both providers
- ⚙️ **In progress**: Guardrails for Ollama history (prune orphaned calls, similar to Qwen's `cleanOrphanedToolCalls`)
- ⚙️ **In progress**: Inject real tool output back into tool_result block for local model reasoning
- ⚙️ **In progress**: Prompt-tune + validate on actual Ollama models (DeepSeek/Qwen)
- ⏳ **Blocked**: Full integration tests pending Gemini quota reset/higher-tier key
- 📌 **Next**: Explore sharing converter logic (à la Qwen `openaiContentGenerator/converter.ts`) for future providers

### Reference Implementations
- [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) — subagent flow + tool result feedback
- [cline/cline](https://github.com/cline/cline/) — mature OpenRouter/local model orchestration

### Authentication Flow
The system supports four authentication types (see `packages/cli/src/components/AuthDialog.tsx`):
1. **Login with Google** (OAuth, free tier: 60 req/min, 1000 req/day)
2. **Gemini API Key** (from aistudio.google.com/apikey)
3. **Vertex AI** (enterprise, requires `GOOGLE_API_KEY` + `GOOGLE_GENAI_USE_VERTEXAI=true`)
4. **OpenAI / Custom / Local Models** (uses `OPENAI_API_KEY` or `LOCAL_MODEL_*` env vars)

### Configuration Priority
Settings are merged in this order (highest to lowest priority):
1. Environment variables (`LOCAL_MODEL_ENDPOINT`, `LOCAL_MODEL_MODEL`, `LOCAL_MODEL_PROVIDER`, `LOCAL_MODEL_API_KEY`)
2. Settings file (`~/.gemini/settings.json` with `localModel` object)
3. CLI flags (e.g., `--model gpt-4o-mini`)
4. Defaults

### Provider-Specific Notes
- **Gemini**: Full tool support, streaming, embeddings, usage metadata
- **OpenAI**: Requires mapping from OpenAI Chat Completions format to Gemini-style responses (tool_calls → functionCall parts)
- **Ollama**: Local runtime, no API key required when `provider=ollama`, limited/no tool call support

## Testing Framework (Vitest)

### Critical Testing Conventions
- **Framework**: Vitest exclusively (`describe`, `it`, `expect`, `vi`)
- **File Location**: Keep `*.test.ts` beside their sources
- **Scenario coverage**: Place under `integration-tests/<feature>`
- **Shared helpers**: Import from `packages/test-utils`
- **Mock Placement**: For critical dependencies (os, fs), place `vi.mock()` at the **very top** of test file before imports
- **Coverage targets**: Maintain ~80% coverage per package (`packages/*/coverage`)
- **Coverage report**: `npm run test:ci` emits coverage

### Mocking Patterns
```typescript
// ES Module mocking with selective override
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, homedir: vi.fn() };
});

// Hoisted mocks (when needed in factory)
const myMock = vi.hoisted(() => vi.fn());

vi.mock('some-module', () => ({
  someFunction: myMock
}));
```

### Common Mock Targets
- Node built-ins: `fs`, `fs/promises`, `os`, `path`, `child_process`
- External SDKs: `@google/genai`, `@modelcontextprotocol/sdk`
- Internal packages: Cross-package dependencies

### React/Ink Testing
```typescript
import { render } from 'ink-testing-library';

const { lastFrame } = render(<MyComponent />);
expect(lastFrame()).toMatch(/expected output/);
```

## Code Style and Conventions

### Module System
- **TypeScript ES modules only**: No CommonJS
- **Exports**: Add new code next to the owning package and re-export via its `src/index.ts`
- **Config review**: Review `Codex.md` before touching auth/config to keep Gemini/OpenAI/local engines consistent

### Code Formatting
- **Prettier**: 2-space indent, single quotes, trailing commas
- **ESLint**: Defined in `eslint.config.js`
- **Auto-fix**: `npm run lint:fix` applies both Prettier and ESLint

### Naming Conventions
- **Directories**: `kebab-case`
- **Locals/functions**: `camelCase`
- **Exported classes/components**: `PascalCase`
- **npm scripts**: Verb-based (`sync:providers`, `build:sandbox`)
- **CLI flags**: Use hyphens not underscores (`--my-flag`, not `--my_flag`)

### TypeScript Best Practices
- **NO classes**: Use plain objects + TypeScript interfaces/types instead
- **NO `any`**: Use `unknown` and type narrowing instead
- **Minimal type assertions**: Avoid `as Type` unless absolutely necessary
- **Exhaustiveness checking**: Use `checkExhaustive` helper in switch default clauses (see `packages/cli/src/utils/checks.ts`)
- **Dependency injection**: Within `packages/core`, prefer dependency injection so provider adapters remain swappable

### ES Module Encapsulation
- Use `export` to define public API, leave everything else unexported (private)
- Avoid Java-style `private`/`public` keywords
- If you need to test unexported functions, that's a code smell—extract to a separate testable module

### Functional Programming
- Leverage array operators: `.map()`, `.filter()`, `.reduce()`, `.slice()`, `.sort()`
- Prefer immutability: return new arrays/objects rather than mutating
- Keep functions pure when possible

### React Conventions (Ink CLI UI)
- **Functional components only**, no classes
- **Hooks**: `useState`, `useEffect`, `useContext`
- **Pure render logic**: No side effects in component body
- **Avoid `useEffect` when possible**: Only use for synchronization with external state
- **Never setState inside useEffect**: Degrades performance
- **Don't use `useMemo`/`useCallback`/`React.memo`**: Let React Compiler handle optimization

### Comments Policy
- **Minimal comments**: Code should be self-documenting
- **High-value only**: Only add comments for complex algorithms or non-obvious design decisions
- **Never talk to users through comments**: Use tool outputs instead

### Provider Adapter Testing Requirements
Provider adapters **must** test:
- Streaming responses
- Tool-call handling
- Telemetry cases from the matrix in `Codex.md`
- Always run both `sandbox:none` and `sandbox:docker` before requesting review

## Git Workflow

- **Main branch**: `main`
- **Before submitting PR**: Run `npm run preflight` or `make preflight`
- **Commit format**: Use Conventional Commits with issue reference (e.g., `feat(cli): Add --json flag (#1234)`)
- **PR requirements**:
  - State motivation, functional changes, and test proof (command output or screenshots)
  - Link ROADMAP or Codex tasks to keep provider work auditable
  - Tag CODEOWNERS
  - Only assign reviewers once CI passes
  - Link to existing issue
  - Keep PRs small and focused (one feature/fix)
  - Update docs if user-facing changes
  - Ensure all checks pass

## Sandboxing and Security

### Security Best Practices
- **Never commit secrets**: `.env` and nested `.gemini/` remain local
- **Provider testing**: Rely on `GEMINI_SANDBOX`, `OPENAI_API_KEY`, and `LOCAL_MODEL_*` to exercise multi-provider paths
- **Docker auth**: Run `npm run auth:docker` before sandbox-dependent tests
- **Log scrubbing**: Remove sensitive details from logs attached to issues

### macOS (Seatbelt)
- Uses `sandbox-exec` with profiles: `{permissive,restrictive}-{open,closed,proxied}`
- Default: `permissive-open` (restricts writes to project folder)
- Configure: `SEATBELT_PROFILE=restrictive-closed`
- Custom profiles: `.gemini/sandbox-macos-<profile>.sb`

### Container-based (Docker/Podman)
- Enable: `GEMINI_SANDBOX=true|docker|podman`
- Build sandbox: `npm run build:sandbox`
- First build: 20-30s, subsequent builds: minimal overhead
- Auto-mounts project directory with read-write access
- Custom sandbox: `.gemini/sandbox.Dockerfile` + `.gemini/sandbox.bashrc`

## Important Files to Understand

### Configuration
- `packages/cli/src/utils/settings.ts` - Settings schema and loading
- `packages/core/src/utils/config.ts` - Core configuration object
- `~/.gemini/settings.json` - User settings file (runtime)

### Authentication
- `packages/cli/src/components/AuthDialog.tsx` - Auth UI
- `packages/cli/src/utils/auth.ts` - Auth logic
- `packages/cli/src/utils/validateNonInteractiveAuth.ts` - Headless auth validation

### Provider Integration
- `packages/core/src/genai/genaiClient.ts` - Gemini API client
- `packages/core/src/core/openAIClient.ts` - OpenAI-compatible adapter with streaming + tool-call parity
- `packages/core/src/genai/createContentGenerator.ts` - Provider factory

### Tools
- `packages/core/src/tools/` - All built-in tools
- `packages/core/src/mcp/` - MCP server integration

## Known Limitations and Active Work

### Completed ✅
1. OpenAI-compatible adapter with streaming + tool-call parity + OpenRouter headers
2. Ollama adapter with strict tool_call instructions, streaming parser, fenced tool_result echoes
3. Vitest coverage + docs for both providers
4. `.gitignore` + lint ignores for env/context files

### In Progress ⚙️
1. Guardrails for Ollama history (prune orphaned calls, similar to Qwen's `cleanOrphanedToolCalls`)
2. Inject real tool output back into tool_result block so local models can reason mid-run
3. Prompt-tune + validate on actual Ollama models (DeepSeek/Qwen) to ensure reliable tool_call/tool_result usage

### Blocked ⏳
1. Full `npm run test:integration:sandbox:none` pending Gemini quota reset/higher-tier key

### Planned 📌
1. Explore sharing converter logic (à la Qwen `openaiContentGenerator/converter.ts`) for future provider adapters
2. Embeddings support: Not currently supported on Ollama provider

## Development Tips

- Use `npm link path/to/gemini-cli/packages/cli` or `alias gemini="node path/to/gemini-cli/packages/cli"` to run development build outside repo
- React DevTools v4.28.5 compatible: `DEV=true npm start` then `npx react-devtools@4.28.5`
- Debug sandbox container: `DEBUG=1 gemini`
- Project-specific env: Use `.gemini/.env` (not `.env` in project root)

## Node.js Version Requirements

- **Development**: Use Node.js `~20.19.0` (upstream dependency constraint)
- **Production**: Any version `>=20` is acceptable
- Recommend using `nvm` to manage Node versions

## Ollama + Local Model Setup (Production-Ready)

### Installation

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Start Ollama server
ollama serve &

# Pull Qwen 2.5 Coder model (3B recommended for testing)
ollama pull qwen2.5-coder:3b
```

### Running Nova-Code with Ollama

**Interactive conversational mode:**
```bash
cd /models/novavoice/Nova-Code
./test_nova_ollama.sh
```

**One-off commands:**
```bash
./test_nova_ollama.sh "Write a Python function to calculate fibonacci"
```

### Configuration

The working setup uses **OpenAI-compatible provider** pointing to Ollama's OpenAI-compatible endpoint:

```bash
export LOCAL_MODEL_PROVIDER=openai-compatible
export LOCAL_MODEL_MODEL=qwen2.5-coder:3b
export LOCAL_MODEL_ENDPOINT=http://127.0.0.1:11434/v1
export OPENAI_API_KEY=ollama  # Dummy key (Ollama doesn't require auth)
```

### Fixes Applied

1. **FinishReason Import Fix**: Changed from `import type` to regular import in ollamaClient.ts and openAIClient.ts
2. **Ollama Endpoint Fix**: Updated to use `/v1/chat/completions` (OpenAI-compatible)
3. **Response Parsing**: Updated to parse OpenAI format (`choices[0].message.content`)
4. **Provider Selection**: Using `openai-compatible` provider for better stability

### Known Issues

- **ClassifierStrategy JSON Schema Error**: The routing classifier tries to use structured JSON output which Qwen 3B doesn't fully support. This is cosmetic - the main conversational and tool-calling functionality works correctly.
- **Duplicate Function Warnings**: Build warnings about duplicate `mapRole` and `formatToolResult` functions are known upstream bugs, but don't affect functionality.

### Model Recommendations

- **qwen2.5-coder:3b** - Fast, good for testing (~2GB)
- **qwen2.5-coder:7b** - Better quality, still fast (~4.7GB)
- **qwen2.5-coder:14b** - Best quality for coding tasks (~8.7GB)

## llama.cpp + Qwen3-Coder-30B Setup (RECOMMENDED for Jetson)

### Why llama.cpp Instead of Ollama?

For the Qwen3-Coder-30B model on Jetson Orin AGX:
- ✅ **Better tool calling support**: Proper OpenAI-compatible function calling format
- ✅ **No Modelfile bugs**: Ollama 0.12.6 has CLI/server version mismatch issues
- ✅ **Memory optimization**: Can set context window to 8192 tokens (reduces from ~38GB to ~25GB)
- ✅ **Uses existing GGUF**: Works with `/mnt/ssd/models/qwen3-coder-30b/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf`

### Quick Setup (Compile from Source - WORKING METHOD)

**⚠️ NOTE: jetson-containers build is currently broken due to pip index issues**

```bash
# 1. Enter your nova_backup_with_deps container (has build tools + CUDA)
docker run -it --rm \
    --runtime nvidia \
    --network host \
    --privileged \
    --device /dev/snd \
    --device /dev/bus/usb \
    --device /dev/dri \
    -v /dev:/dev \
    -v /mnt/ssd/models:/models \
    -v /mnt/ssd/humanrobot:/workspace \
    -v ~/.asoundrc:/root/.asoundrc:ro \
    --group-add audio \
    --cap-add SYS_ADMIN \
    nova_backup_with_deps:latest bash

# 2. Clone and build llama.cpp (only needed once)
cd /models
git clone https://github.com/ggerganov/llama.cpp.git
cd llama.cpp
mkdir build && cd build
cmake .. -DGGML_CUDA=ON
cmake --build . --config Release -j8

# 3. Start llama-server in background
/models/llama.cpp/build/bin/llama-server \
    -m /models/qwen3-coder-30b/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf \
    --host 0.0.0.0 \
    --port 8080 \
    -c 8192 \
    -ngl 99 \
    --chat-template qwen \
    > /tmp/llama-server.log 2>&1 &

# 4. Configure Nova-Code environment
export LOCAL_MODEL_PROVIDER=openai-compatible
export LOCAL_MODEL_MODEL=qwen3-coder-30b
export LOCAL_MODEL_ENDPOINT=http://127.0.0.1:8080/v1
export OPENAI_API_KEY=dummy

# 5. Setup Node.js
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 20

# 6. Test Nova-Code
cd /models/novavoice/Nova-Code
./bundle/gemini.js "Write a Python function to add two numbers"
```

### Manual Commands (if setup script doesn't work)

```bash
# Start llama-server manually
llama-server \
    -m /models/qwen3-coder-30b/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf \
    --host 0.0.0.0 \
    --port 8080 \
    -c 8192 \
    -ngl 99 \
    --chat-template qwen \
    > /tmp/llama-server.log 2>&1 &

# Configure environment
export LOCAL_MODEL_PROVIDER=openai-compatible
export LOCAL_MODEL_MODEL=qwen3-coder-30b
export LOCAL_MODEL_ENDPOINT=http://127.0.0.1:8080/v1
export OPENAI_API_KEY=dummy

# Set up Node.js
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use 20

# Test Nova-Code
cd /mnt/ssd/models/novavoice/Nova-Code
./bundle/gemini.js "Write a Python function to add two numbers"
```

### Key Parameters Explained

- **`-c 8192`**: Context window size (optimized from 32768 to reduce memory from ~38GB to ~25GB)
- **`-ngl 99`**: Offload all layers to GPU for maximum performance
- **`--chat-template qwen`**: Use Qwen's chat format (handles `<|im_start|>` tokens)
- **`--port 8080`**: Avoids conflict with Ollama on port 11434

### Testing llama-server API

```bash
# Check server health
curl http://localhost:8080/health

# List models
curl http://localhost:8080/v1/models

# Test tool calling
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-coder-30b",
    "messages": [{"role": "user", "content": "What is 2+2?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "calculate",
        "description": "Do math",
        "parameters": {"type": "object", "properties": {"expr": {"type": "string"}}}
      }
    }],
    "max_tokens": 100
  }'
```

### Memory Optimization Notes

**Original Modelfile** (`num_ctx 32768`):
- Model: 18GB
- KV Cache: ~15-20GB
- **Total: ~35-38GB** → Causes memory starvation and swapping on 64GB Jetson

**Optimized** (`-c 8192`):
- Model: 18GB
- KV Cache: ~5-7GB
- **Total: ~23-25GB** → Leaves headroom for system and other processes

### Troubleshooting

**If server won't start:**
```bash
# Check if port is in use
netstat -tlnp | grep 8080

# Check logs
tail -f /tmp/llama-server.log

# Check GPU memory
nvidia-smi
```

**If Nova-Code times out:**
```bash
# Test llama-server directly first
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3-coder-30b","messages":[{"role":"user","content":"Hi"}]}'
```

**If tool calling doesn't work:**
- llama.cpp should return proper `tool_calls` in OpenAI format
- If it returns JSON text instead, the model may need `--grammar` or different prompt

### Files Created

- `/mnt/ssd/models/novavoice/Nova-Code/setup_llama_cpp.sh` - Automated setup script
- `/mnt/ssd/models/qwen3-coder-30b/Modelfile` - Optimized Ollama Modelfile (backup, with lowercase directives and `num_ctx 8192`)

## Inference Engine Comparison (2025-10-28 Session Notes)

### What We Learned About Ollama Issues

**Problem:** Qwen3-Coder-30B was taking 60+ seconds per query with Ollama
**Root Cause:** Memory starvation from `num_ctx 32768` in Modelfile
- 18GB model + 15-20GB KV cache = ~38GB total memory
- System had only 556MB free RAM → swapping → extreme slowness

**Attempted Fixes:**
1. Reduced `num_ctx` to 8192 in Modelfile ✅
2. Tried to recreate model with `ollama create` ❌
3. Hit Ollama 0.12.6 CLI/server version mismatch bug ❌

**Ollama Bug Details:**
- CLI client expects old Modelfile format
- Server expects new JSON API format
- Cannot recreate models without workarounds
- See: https://github.com/ollama/ollama/issues/7935

### Inference Engine Landscape

| Engine | Best For | Speed | Memory | Jetson Support | Quantization |
|--------|----------|-------|--------|----------------|--------------|
| **llama.cpp** | Edge devices, single-user | Fast | Excellent (GGUF Q4) | ✅ Perfect | INT4/INT8 |
| **Ollama** | Quick testing, demos | Fast | Good | ✅ Works | Uses llama.cpp |
| **vLLM** | Multi-user, high throughput | Very Fast | Good (PagedAttention) | ⚠️ Limited | INT4/INT8/AWQ |
| **TensorRT-LLM** | Maximum performance | Fastest | Excellent | ✅ Optimized | FP8/INT4/INT8 |
| **Transformers** | Development, research | Slow | Poor (FP16/FP32) | ✅ Works | Via bitsandbytes |
| **SGLang** | Structured output | Very Fast | Good (RadixAttention) | ⚠️ Unknown | INT4/INT8 |

### Why llama.cpp for Jetson Orin AGX

**Current Setup (Recommended):**
- Engine: llama.cpp compiled from source with CUDA support
- Model: Qwen3-Coder-30B Q4_K_M quantization (18GB GGUF)
- Memory: ~25GB total (18GB model + 7GB context at 8192 tokens)
- Speed: Fast inference (~2-5 tok/s on Jetson)
- Integration: OpenAI-compatible API → works with Nova-Code

**Future Optimization Option:**
- Engine: TensorRT-LLM with INT4-AWQ quantization
- Expected speedup: 2-4x faster than llama.cpp
- Setup complexity: Higher (need to build engines, ~30-60 min)
- Worth it for: Production use, maximum performance

### Memory Optimization Notes

**Qwen3-Coder-30B Memory Usage:**

```
Context Size | KV Cache | Model | Total | Jetson 64GB Status
-------------|----------|-------|-------|-------------------
32,768 tokens| ~20GB    | 18GB  | 38GB  | ❌ Too tight, causes swapping
8,192 tokens | ~5-7GB   | 18GB  | 25GB  | ✅ Comfortable, leaves headroom
4,096 tokens | ~3GB     | 18GB  | 21GB  | ✅ Safe, but limited context
```

**Key Insight:** Lower context = more free memory for other processes (Nova voice assistant, vision, etc.)

### Container Issues Encountered

**jetson-containers pip index broken (as of 2025-10-28):**
```
ERROR: Could not find a version that satisfies the requirement pip (from versions: none)
Looking in indexes: https://pypi.jetson-ai-lab.io/jp6/cu122
```

**Workaround:** Compile llama.cpp from source in existing containers (nova_backup_with_deps)

### Quick Commands Reference

```bash
# Kill Ollama and free VRAM
docker kill $(docker ps -q --filter ancestor=ollama/ollama)

# Check if llama.cpp is built
ls -lh /models/llama.cpp/build/bin/llama-server

# Start llama-server (port 8080)
/models/llama.cpp/build/bin/llama-server \
    -m /models/qwen3-coder-30b/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf \
    --host 0.0.0.0 --port 8080 -c 8192 -ngl 99 \
    > /tmp/llama-server.log 2>&1 &

# Test llama-server
curl http://localhost:8080/v1/models

# Check GPU memory
nvidia-smi
```

## Reference Documentation

- Architecture deep-dive: `docs/architecture.md`
- Integration testing: `docs/integration-tests.md`
- Contributing guide: `CONTRIBUTING.md`
- Security policy: `SECURITY.md`
- Full docs: `docs/` directory
