## Codex Master Plan – 2025‑02‑16

> _Objective:_ Deliver a fork of `google-gemini/gemini-cli` that can seamlessly
> switch between Google Gemini, OpenAI GPT (4o, etc.), and true local engines
> (Ollama/DeepSeek) while preserving all core agentic features (tooling, policy,
> telemetry, IDE integrations). This document is the running blueprint.

---

### Table of Contents

1. [Current State Snapshot](#1-current-state-snapshot)
2. [Work Completed Today](#2-work-completed-today)
3. [Detailed TODO Matrix](#3-detailed-todo-matrix)
4. [Technical Notes for Tomorrow (Linux Session)](#4-technical-notes-for-tomorrow-linux-session)
5. [Risk / Mitigation](#5-risk--mitigation)
6. [Immediate Next Actions](#6-immediate-next-actions)
7. [Deep Dive Appendix](#7-deep-dive-appendix)
   - [7.1 Provider Capability Matrix](#71-provider-capability-matrix)
   - [7.2 OpenAI Client Design Spec](#72-openai-client-design-spec)
   - [7.3 Ollama Adapter Design Spec](#73-ollama-adapter-design-spec)
   - [7.4 Testing Strategy](#74-testing-strategy)
   - [7.5 Doc Tasks Checklist](#75-doc-tasks-checklist)
8. [Changelog](#8-changelog)

---

### 1. Current State Snapshot

| Area                                    | Status      | Notes                                                                          |
| --------------------------------------- | ----------- | ------------------------------------------------------------------------------ |
| Auth surface / provider selection       | ✅ Complete | CLI + Zed + non-interactive flows expose “OpenAI / Custom / Local Models”.     |
| Local model config plumbing             | ✅ Complete | `settings.localModel` + `LOCAL_MODEL_*` env vars feed into core `Config`.      |
| Docs (README/auth guide)                | ✅ Updated  | Added Option 4 (OpenAI/custom/local), env examples, Ollama quickstart.         |
| Targeted unit tests                     | ✅ Passing  | `auth.test.ts`, `AuthDialog.test.tsx`, `validateNonInterActiveAuth.test.ts`.   |
| OpenAI client (tool calls, streaming)   | ⚠️ TODO     | Needs full rewrite to support `functionCalls`, finish reasons, usage metadata. |
| Local runtime adapter (Ollama/DeepSeek) | ⚠️ TODO     | Need dedicated adapter and detection.                                          |
| System/IDE integration verification     | ⚠️ Pending  | Ensure IDE sync + policy engine unaffected when switching providers.           |

---

### 2. Work Completed Today

1. **Provider-Agnostic Auth Flow**
   - Added `AuthType.USE_LOCAL_MODEL` UI entry labeled “OpenAI / Custom / Local
     Models”.
   - Extended non-interactive validation to detect `OPENAI_API_KEY` or
     `LOCAL_MODEL_PROVIDER`.
   - Allowed keyless operation when `provider=ollama`.

2. **Config + Settings Integration**
   - `settings.localModel` schema now includes `endpoint`, `model`, `apiKey`,
     `provider`.
   - CLI merges env vars (`LOCAL_MODEL_ENDPOINT`, `LOCAL_MODEL_MODEL`, etc.)
     with settings before constructing core `Config`.

3. **Docs + Telemetry Notes**
   - README + `docs/get-started/authentication.md` cover OpenAI gateways and
     Ollama instructions.
   - UI copy updated so tooling prompts reference the new provider.

4. **Testing & Validation**
   - Re-ran the relevant Vitest suites and confirmed they pass under the new
     auth conditions.
   - Verified CLI wiring manually (macOS sandbox prevented full
     `openAIClient.ts` swap—deferred to Linux session).

---

### 3. Detailed TODO Matrix

| #   | Task                                                                             | Owner         | Dependencies              | Notes                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------- | ------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Reimplement `OpenAIClient`** with proper streaming+tool-call mapping           | Codex (Linux) | None                      | Use OpenAI Chat Completions (`tool_calls`, streaming deltas). Output must mirror Gemini’s `functionCall` parts and `GenerateContentResponseUsageMetadata`. |
| 2   | **Add `OllamaClient` adapter**                                                   | Codex (Linux) | Task 1 (shared utilities) | Talks to local Ollama API (`/api/chat`). Needs best-effort tool-call translation (DeepSeek Coder, etc.).                                                   |
| 3   | **Refactor `createContentGenerator`** to select between multiple local providers | Codex (Linux) | Tasks 1–2                 | Replace placeholder logic with factory dispatch (OpenAI/Ollama).                                                                                           |
| 4   | **History + tool-response parity**                                               | Codex         | Task 1                    | Ensure `config.getGeminiClient().addHistory` receives identical `functionResponse` parts regardless of provider.                                           |
| 5   | **Usage + telemetry alignment**                                                  | Codex         | Task 1                    | Convert OpenAI usage counters into `GenerateContentResponseUsageMetadata`, feed UI quota + telemetry.                                                      |
| 6   | **Docs part 2**                                                                  | Codex         | 1–4                       | Document limitations (e.g., embeddings unsupported on Ollama), add sample settings JSON.                                                                   |
| 7   | **Full test sweep**                                                              | Codex         | 1–6                       | Run `npm run test --workspaces`, targeted integration tests (Linux).                                                                                       |
| 8   | **Git cleanup**                                                                  | Codex         | Post-tests                | Remove placeholder files blocked on macOS (`openAIClient.ts`), stage commits.                                                                              |

---

### 4. Technical Notes for Tomorrow (Linux Session)

1. **OpenAI Streaming Design**
   - Use `chat.completions.create({stream:true})`.
   - Accumulate `delta.tool_calls` segments; when finish reason is `tool_calls`,
     emit consolidated `functionCall` parts plus map to `FunctionCall[]`.
   - Guarantee at least a zero-width placeholder part if model finishes without
     text.

2. **Tool Call Echo**
   - After `coreToolScheduler` produces `functionResponse` parts, ensure they’re
     appended to history even when the provider isn’t Gemini (since Gemini API
     isn’t enforcing ordering, but our orchestrator expects the same shape).

3. **Finish Reasons**
   - Map OpenAI reasons: `stop → FinishReason.STOP`, `length → MAX_TOKENS`,
     `content_filter → SAFETY`, `tool_calls → OTHER`.

4. **Usage Metadata**
   - Convert OpenAI’s `usage.prompt_tokens` / `completion_tokens` onto
     `GenerateContentResponseUsageMetadata` for quota UI + telemetry.

5. **Ollama Adapter**
   - Minimal streaming support; if the API doesn’t expose tool-calls, we’ll rely
     on pure text (no `functionCalls`).
   - Document that embeddings aren’t supported in this provider.

6. **Filesystem Cleanup**
   - macOS sandbox blocked deleting/replacing files today. On Linux, remove the
     temporary `openAIClient.ts`, re-add the rewritten version, and drop any
     leftover artifacts.

---

### 5. Risk / Mitigation

- **Tool parity gap:** Until the OpenAI client emits `functionCall` parts, tool
  execution is Gemini-only. Mitigation: prioritize Task #1 before touching
  docs/tests further.
- **Local runtime variance:** Ollama/DeepSeek output formats differ. Provide
  clear docs + guardrails (warnings when tool calls unsupported).
- **Sandbox quirks (macOS):** File deletion failed despite `chmod`. Switching to
  Linux tomorrow avoids wasted cycles.

---

### 6. Immediate Next Actions

1. On Linux: replace `openAIClient.ts` with the new streaming/tool-aware
   implementation.
2. Wire factory selection + `OllamaClient`.
3. Re-run tests, document behavior, prep commits.

Once those are done we’ll have a fully provider-agnostic CLI capable of meeting
the “million-dollar grant” requirement set. Ready to resume tomorrow.

---

### 7. Deep Dive Appendix

#### 7.1 Provider Capability Matrix

| Capability          | Gemini (OAuth/API) | OpenAI-compatible            | Ollama / Local (DeepSeek, etc.)                   |
| ------------------- | ------------------ | ---------------------------- | ------------------------------------------------- |
| Streaming responses | ✅ native          | ✅ (Chat Completions stream) | ⚠️ (depends on backend; base plan: pseudo-stream) |
| Tool calls          | ✅                 | ⚠️ (requires mapping)        | 🚫 (not supported)                                |
| Usage metadata      | ✅                 | ⚠️ (map tokens)              | 🚫                                                |
| Embeddings          | ✅                 | ✅                           | 🚫                                                |
| Policy enforcement  | ✅                 | ⚠️ ensure parity             | ⚠️ (text only)                                    |

#### 7.2 OpenAI Client Design Spec

- Translate OpenAI streaming chunks into Gemini-style responses.
- Reconstruct tool calls by accumulating `delta.tool_calls`.
- Ensure zero-width placeholder parts when needed.
- Map finish reasons and usage metadata.
- Convert function declarations to OpenAI tool schema.

#### 7.3 Ollama Adapter Design Spec

- Detect `provider=ollama`.
- Call `/api/chat` with configured endpoint/model.
- Handle streaming or chunked responses.
- Emit plain text responses (no tool calls).
- Throw helpful errors for missing server or unsupported features.

#### 7.4 Testing Strategy

1. Unit tests for OpenAI client (tool calls, finish reasons, usage).
2. CLI config tests for env merges.
3. Full `npm run test --workspaces` on Linux.
4. Manual validation with real OpenAI key + local DeepSeek via Ollama.

#### 7.5 Doc Tasks Checklist

- [ ] Update README with OpenAI/Ollama caveats post-implementation.
- [ ] Add settings JSON example for DeepSeek via Ollama.
- [ ] Document `LOCAL_MODEL_*` env vars in config guide.
- [ ] Add FAQ entry for GPT-4o usage.

---

### 8. Changelog

- **2025-02-16**: Initial plan drafted; provider-agnostic auth/config merged;
  docs + tests updated.
- **2025-02-17 (planned)**: Implement OpenAI streaming client, Ollama adapter,
  run full tests, update docs again.
