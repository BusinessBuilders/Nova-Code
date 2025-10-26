/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type {
  Candidate,
  Content,
  ContentListUnion,
  ContentUnion,
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  FinishReason,
  FunctionCall,
  GenerateContentParameters,
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
  Part,
  Tool,
  ToolListUnion,
} from '@google/genai';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from './contentGenerator.js';
import { toContents } from '../code_assist/converter.js';

function partToText(part: Part): string {
  if ('text' in part && typeof part.text === 'string') {
    return part.text;
  }
  if (part.functionCall) {
    return JSON.stringify(part.functionCall);
  }
  return '';
}

interface OllamaStreamChunk {
  model?: string;
  message?: { role?: string; content?: string };
  done?: boolean;
  done_reason?: string;
  eval_count?: number;
  prompt_eval_count?: number;
}

const DONE_REASON_TO_FINISH: Record<string, FinishReason> = {
  stop: FinishReason.STOP,
  length: FinishReason.MAX_TOKENS,
};

function parseToolCallPayload(payload?: string): FunctionCall | undefined {
  if (!payload) {
    return undefined;
  }
  try {
    const data = JSON.parse(payload.trim());
    const name =
      (typeof data.name === 'string' && data.name) ||
      (typeof data.tool === 'string' && data.tool) ||
      (typeof data.command === 'string' && data.command);
    if (!name) {
      return undefined;
    }
    const rawArgs =
      data.arguments ?? data.args ?? data.parameters ?? data.params ?? {};
    const args =
      rawArgs && typeof rawArgs === 'object'
        ? rawArgs
        : { value: rawArgs ?? null };
    return {
      id: randomUUID(),
      name,
      args,
      isClientInitiated: false,
    };
  } catch (_err) {
    return undefined;
  }
}

function extractToolCalls(content: string): {
  text: string;
  functionCalls: FunctionCall[];
} {
  const functionCalls: FunctionCall[] = [];
  const fencedRegex = /```tool_call\s*([\s\S]*?)```/gi;
  const xmlRegex = /<tool_call[^>]*>([\s\S]*?)<\/tool_call>/gi;

  const applyRegex = (regex: RegExp) => {
    content = content.replace(regex, (match, group) => {
      const call = parseToolCallPayload(group);
      if (call) {
        functionCalls.push(call);
        return '';
      }
      return match;
    });
  };

  applyRegex(fencedRegex);
  applyRegex(xmlRegex);

  return { text: content.trim(), functionCalls };
}

export class OllamaClient implements ContentGenerator {
  private readonly endpoint: string;
  private readonly defaultModel: string;

  constructor(private readonly contentGeneratorConfig: ContentGeneratorConfig) {
    this.endpoint = this.resolveEndpoint(
      this.contentGeneratorConfig.localModel?.endpoint ||
        'http://127.0.0.1:11434',
    );
    this.defaultModel =
      this.contentGeneratorConfig.localModel?.model || 'llama3';
  }

  private resolveEndpoint(rawEndpoint: string): string {
    const trimmed = rawEndpoint.replace(/\/+$/, '');
    if (trimmed.endsWith('/api/chat')) {
      return trimmed;
    }
    return `${trimmed}/api/chat`;
  }

  private mapRole(role?: string): 'user' | 'assistant' | 'system' {
    if (!role) {
      return 'user';
    }
    const normalized = role.toLowerCase();
    if (normalized === 'model' || normalized === 'assistant') {
      return 'assistant';
    }
    if (normalized === 'system') {
      return 'system';
    }
    return 'user';
  }

  private formatToolResult(response: NonNullable<Part['functionResponse']>) {
    const payload = {
      call_id: response.id ?? randomUUID(),
      name: response.name ?? 'tool',
      output: response.response ?? {},
    };
    return ['```tool_result', JSON.stringify(payload), '```'].join('\n');
  }

  private mapRole(role?: string): 'user' | 'assistant' | 'system' {
    if (!role) {
      return 'user';
    }
    const normalized = role.toLowerCase();
    if (normalized === 'model' || normalized === 'assistant') {
      return 'assistant';
    }
    if (normalized === 'system') {
      return 'system';
    }
    return 'user';
  }

  private formatToolResult(response: NonNullable<Part['functionResponse']>) {
    const payload = {
      call_id: response.id ?? randomUUID(),
      name: response.name ?? 'tool',
      output: response.response ?? {},
    };
    return ['```tool_result', JSON.stringify(payload), '```'].join('\n');
  }

  private normalizeToolHistory(contents: Content[]): Content[] {
    const normalized: Content[] = [];
    const callIds = new Set<string>();
    const resolvedCallIds = new Set<string>();

    contents.forEach((content) => {
      const parts = content.parts ?? [];
      const clonedParts: Part[] = [];
      for (const part of parts) {
        if (part.functionCall) {
          const callId = part.functionCall.id ?? randomUUID();
          if (!part.functionCall.id) {
            part.functionCall.id = callId;
          }
          callIds.add(callId);
          clonedParts.push(part);
        } else if (part.functionResponse) {
          const callId = part.functionResponse.id;
          if (!callId) {
            clonedParts.push(part);
          } else if (callIds.has(callId)) {
            resolvedCallIds.add(callId);
            clonedParts.push(part);
          }
        } else {
          clonedParts.push(part);
        }
      }
      if (clonedParts.length > 0) {
        normalized.push({ ...content, parts: clonedParts });
      }
    });

    if (callIds.size === resolvedCallIds.size) {
      return normalized;
    }

    const unresolvedIds = new Set<string>();
    for (const callId of callIds) {
      if (!resolvedCallIds.has(callId)) {
        unresolvedIds.add(callId);
      }
    }

    return normalized
      .map((content) => {
        const filtered = (content.parts ?? []).filter((part) => {
          const id = part.functionCall?.id;
          if (id && unresolvedIds.has(id)) {
            return false;
          }
          return true;
        });
        return filtered.length > 0 ? { ...content, parts: filtered } : null;
      })
      .filter((content): content is Content => content !== null);
  }

  private contentsToMessages(
    contents: ContentListUnion,
  ): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
    const normalized = this.normalizeToolHistory(toContents(contents));
    const messages: Array<{
      role: 'user' | 'assistant' | 'system';
      content: string;
    }> = [];

    for (const content of normalized) {
      const role = this.mapRole(content.role);
      let buffer = '';

      const flushBuffer = () => {
        const trimmed = buffer.trim();
        if (trimmed.length > 0) {
          messages.push({ role, content: trimmed });
          buffer = '';
        }
      };

      for (const part of content.parts ?? []) {
        if (part.functionResponse) {
          flushBuffer();
          messages.push({
            role: 'user',
            content: this.formatToolResult(part.functionResponse),
          });
          continue;
        }
        const fragment = partToText(part);
        if (fragment) {
          buffer += buffer.length === 0 ? fragment : `\n${fragment}`;
        }
      }

      flushBuffer();
    }

    return messages;
  }

  private systemInstructionToText(
    instruction?: ContentUnion,
  ): string | undefined {
    if (!instruction) {
      return undefined;
    }
    const text = toContents(instruction as ContentUnion)
      .map(
        (content) =>
          content.parts?.map((part: Part) => partToText(part)).join('') ?? '',
      )
      .join('\n')
      .trim();
    return text || undefined;
  }

  private buildToolPrompt(tools?: ToolListUnion): string | undefined {
    if (!tools) {
      return undefined;
    }
    const toolArray: Tool[] = Array.isArray(tools) ? tools : [tools];
    const declarations = toolArray.flatMap(
      (tool) => tool?.functionDeclarations ?? [],
    );
    if (declarations.length === 0) {
      return undefined;
    }
    const toolDescriptions = declarations
      .map((decl) => {
        const summary = decl.description?.trim() ?? '';
        return `- ${decl.name ?? 'tool'}${summary ? `: ${summary}` : ''}`;
      })
      .join('\n');
    return [
      'Available tools:',
      toolDescriptions,
      '',
      'When you want to call a tool, respond with a fenced code block exactly like this (no extra commentary):',
      '```tool_call',
      '{"name":"tool_name","arguments":{"param":"value"}}',
      '```',
      'Respond with multiple tool_call blocks if you must call more than one tool. When you are giving a normal reply, do not include any tool_call block.',
      '',
      'Tool results will be provided back to you in this format:',
      '```tool_result',
      '{"call_id":"same id you provided","name":"tool_name","output":{...}}',
      '```',
      'Always wait for the matching tool_result before continuing the conversation.',
    ].join('\n');
  }

  private buildSystemPrompt(
    instruction?: ContentUnion,
    tools?: ToolListUnion,
  ): string | undefined {
    const parts: string[] = [];
    const base = this.systemInstructionToText(instruction);
    if (base) {
      parts.push(base);
    }
    const toolPrompt = this.buildToolPrompt(tools);
    if (toolPrompt) {
      parts.push(toolPrompt);
    }
    return parts.length > 0 ? parts.join('\n\n') : undefined;
  }

  async generateContent(
    request: GenerateContentParameters,
    _userPromptId: string,
  ): Promise<GenerateContentResponse> {
    const targetModel = request.model || this.defaultModel;
    const messages = this.contentsToMessages(request.contents);
    const systemPrompt = this.buildSystemPrompt(
      request.config?.systemInstruction,
      request.config?.tools,
    );
    if (systemPrompt) {
      messages.unshift({
        role: 'system',
        content: systemPrompt,
      });
    }
    const body: Record<string, unknown> = {
      model: targetModel,
      messages,
      stream: false,
    };

    if (request.config?.temperature !== undefined) {
      body.options = {
        ...(body.options as Record<string, unknown> | undefined),
        temperature: request.config.temperature,
      };
    }

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama chat request failed (${response.status}): ${response.statusText}`,
      );
    }

    const data = (await response.json()) as {
      message?: { content?: string };
      eval_count?: number;
      prompt_eval_count?: number;
    };
    const text = data.message?.content ?? '';
    const { text: strippedText, functionCalls } = extractToolCalls(text);
    const parts: Part[] = [];
    if (strippedText) {
      parts.push({ text: strippedText });
    }
    for (const call of functionCalls) {
      parts.push({ functionCall: call });
    }

    const result: GenerateContentResponse = {
      modelVersion: targetModel,
      candidates: [
        {
          content: {
            role: 'model',
            parts: parts.length > 0 ? parts : [{ text: '' }],
          },
        },
      ],
    } as GenerateContentResponse;

    if (data.prompt_eval_count !== undefined || data.eval_count !== undefined) {
      result.usageMetadata = {
        promptTokenCount: data.prompt_eval_count,
        candidatesTokenCount: data.eval_count,
      } as GenerateContentResponseUsageMetadata;
    }

    if (functionCalls.length > 0) {
      result.functionCalls = functionCalls;
    }

    return result;
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const targetModel = request.model || this.defaultModel;
    const messages = this.contentsToMessages(request.contents);
    const systemPrompt = this.buildSystemPrompt(
      request.config?.systemInstruction,
      request.config?.tools,
    );
    if (systemPrompt) {
      messages.unshift({
        role: 'system',
        content: systemPrompt,
      });
    }
    const body: Record<string, unknown> = {
      model: targetModel,
      messages,
      stream: true,
    };

    if (request.config?.temperature !== undefined) {
      body.options = {
        ...(body.options as Record<string, unknown> | undefined),
        temperature: request.config.temperature,
      };
    }

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      throw new Error(
        `Ollama chat stream failed (${response.status}): ${response.statusText}`,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    async function* streamGenerator(): AsyncGenerator<GenerateContentResponse> {
      let buffer = '';
      let usage: GenerateContentResponseUsageMetadata | undefined;
      let finishReason: FinishReason | undefined;
      let accumulatedModel = targetModel;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          let newlineIndex = buffer.indexOf('\n');
          while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            newlineIndex = buffer.indexOf('\n');
            if (!line) {
              continue;
            }
            let payload: OllamaStreamChunk | undefined;
            try {
              payload = JSON.parse(line) as OllamaStreamChunk;
            } catch (_e) {
              continue;
            }
            if (!payload) {
              continue;
            }
            if (payload.model) {
              accumulatedModel = payload.model;
            }
            if (payload.done) {
              finishReason =
                DONE_REASON_TO_FINISH[payload.done_reason ?? 'stop'] ??
                FinishReason.STOP;
              usage = {
                promptTokenCount: payload.prompt_eval_count,
                candidatesTokenCount: payload.eval_count,
              };
              continue;
            }
            const chunkText = payload.message?.content ?? '';
            if (!chunkText) {
              continue;
            }
            const { text, functionCalls } = extractToolCalls(chunkText);
            const parts: Part[] = [];
            if (text) {
              parts.push({ text });
            }
            for (const call of functionCalls) {
              parts.push({ functionCall: call });
            }
            if (parts.length === 0) {
              continue;
            }
            const candidate: Candidate = {
              content: { role: 'model', parts },
            };
            if (functionCalls.length > 0) {
              candidate.finishReason = FinishReason.STOP;
            }
            const chunkResponse: GenerateContentResponse = {
              modelVersion: accumulatedModel,
              candidates: [candidate],
            };
            if (functionCalls.length > 0) {
              chunkResponse.functionCalls = functionCalls;
            }
            yield chunkResponse;
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (finishReason || usage) {
        const finalResponse: GenerateContentResponse = {
          modelVersion: accumulatedModel,
          candidates: [
            {
              content: { role: 'model', parts: [] },
              finishReason: finishReason ?? FinishReason.STOP,
            },
          ],
        };
        if (usage) {
          finalResponse.usageMetadata = usage;
        }
        yield finalResponse;
      }
    }

    return streamGenerator();
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    const contents = toContents(request.contents);
    const totalChars = contents.reduce((sum, content) => {
      const text =
        content.parts?.map((part) => partToText(part)).join('') || '';
      return sum + text.length;
    }, 0);

    const totalTokens = Math.max(1, Math.ceil(totalChars / 4));

    return {
      totalTokens,
      totalBillableCharacters: totalChars,
    } as CountTokensResponse;
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    throw new Error('Embeddings are not supported for Ollama providers.');
  }
}
