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
  FunctionDeclaration,
  FunctionCallingConfigMode,
  GenerateContentParameters,
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
  Part,
  Tool,
  ToolListUnion,
} from '@google/genai';
import { toContents } from '../code_assist/converter.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
  LocalModelConfig,
} from './contentGenerator.js';
import { getErrorMessage } from '../utils/errors.js';

const DEFAULT_OPENAI_ENDPOINT = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DATA_PREFIX = 'data:';
const SSE_TERMINATOR = '[DONE]';
const OPENROUTER_HOST = 'openrouter.ai';

type GeminiFunctionCall = FunctionCall & { isClientInitiated?: boolean };

interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIChatMessage[];
  temperature?: number;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  max_tokens?: number;
  n?: number;
  stop?: string[];
  tools?: OpenAIToolDefinition[];
  tool_choice?:
    | 'auto'
    | 'required'
    | 'none'
    | { type: 'function'; function: { name: string } };
  response_format?:
    | { type: 'json_object' }
    | {
        type: 'json_schema';
        json_schema: { name: string; schema: Record<string, unknown> };
      };
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  user?: string;
}

type OpenAIChatMessage =
  | {
      role: 'system' | 'user' | 'assistant';
      content: string | OpenAIMessageContentPart[];
      tool_calls?: OpenAIToolCallMessage[];
    }
  | {
      role: 'tool';
      content: string;
      tool_call_id: string;
      name?: string;
    };

type OpenAIMessageContentPart =
  | { type: 'text'; text?: string }
  | { type: 'input_text'; text?: string }
  | { type: 'image_url'; image_url?: { url?: string } }
  | Record<string, unknown>;

interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface OpenAIToolCallMessage {
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
  index?: number;
}

interface OpenAIChatCompletionResponse {
  id: string;
  model: string;
  created?: number;
  choices: Array<{
    index: number;
    message?: {
      role?: string;
      content?: string | OpenAIMessageContentPart[];
      tool_calls?: OpenAIToolCallMessage[];
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage;
}

interface OpenAIChatCompletionChunk {
  id: string;
  model: string;
  choices: OpenAIChatCompletionChunkChoice[];
  usage?: OpenAIUsage;
}

interface OpenAIChatCompletionChunkChoice {
  index: number;
  delta: {
    role?: string;
    content?: string | OpenAIMessageContentPart[];
    tool_calls?: OpenAIToolCallMessage[];
  };
  finish_reason?: string | null;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

function safeJsonParse(
  value: string | undefined,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function cloneSchema(schema?: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

function openAIContentToGeminiParts(
  content?: string | OpenAIMessageContentPart[],
): Part[] {
  if (!content) {
    return [];
  }

  if (typeof content === 'string') {
    return content ? [{ text: content }] : [];
  }

  const parts: Part[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const type = item.type;
    if (type === 'text' || type === 'input_text') {
      const text = (item as { text?: string }).text;
      if (typeof text === 'string' && text.length > 0) {
        parts.push({ text });
      }
      continue;
    }
    if (type === 'image_url') {
      const url = (item as { image_url?: { url?: string } }).image_url?.url;
      if (typeof url === 'string' && url.length > 0) {
        parts.push({
          text: `[Image content: ${url}]`,
        });
      }
    }
  }
  return parts;
}

function mapFinishReason(reason?: string | null): FinishReason | undefined {
  if (!reason) {
    return undefined;
  }
  switch (reason) {
    case 'stop':
      return FinishReason.STOP;
    case 'length':
      return FinishReason.MAX_TOKENS;
    case 'content_filter':
      return FinishReason.SAFETY;
    case 'tool_calls':
      return undefined;
    default:
      return FinishReason.OTHER;
  }
}

function usageToMetadata(
  usage?: OpenAIUsage,
): GenerateContentResponseUsageMetadata | undefined {
  if (!usage) {
    return undefined;
  }
  const metadata: GenerateContentResponseUsageMetadata = {};
  if (typeof usage.prompt_tokens === 'number') {
    metadata.promptTokenCount = usage.prompt_tokens;
  }
  if (typeof usage.completion_tokens === 'number') {
    metadata.candidatesTokenCount = usage.completion_tokens;
  }
  if (typeof usage.total_tokens === 'number') {
    metadata.totalTokenCount = usage.total_tokens;
  }
  return metadata;
}

class ToolCallAccumulator {
  private id?: string;
  private name?: string;
  private rawArguments = '';
  private parsedArgs?: Record<string, unknown>;
  private emitted = false;

  append(delta: OpenAIToolCallMessage): void {
    if (!delta) {
      return;
    }
    if (delta.id) {
      this.id = delta.id;
    }
    if (delta.function?.name) {
      this.name = delta.function.name;
    }
    if (typeof delta.function?.arguments === 'string') {
      this.rawArguments += delta.function.arguments;
      const parsed = safeJsonParse(this.rawArguments);
      if (parsed) {
        this.parsedArgs = parsed;
      }
    }
  }

  tryBuild(): GeminiFunctionCall | undefined {
    if (this.emitted) {
      return undefined;
    }
    if (!this.id || !this.name || !this.parsedArgs) {
      return undefined;
    }
    this.emitted = true;
    return {
      id: this.id,
      name: this.name,
      args: this.parsedArgs,
      isClientInitiated: false,
    };
  }

  finalize(): GeminiFunctionCall | undefined {
    if (this.emitted) {
      return undefined;
    }
    if (!this.id) {
      this.id = randomUUID();
    }
    if (!this.name) {
      this.name = 'tool_call';
    }
    const args =
      this.parsedArgs ??
      safeJsonParse(this.rawArguments) ??
      (this.rawArguments ? { raw: this.rawArguments } : {});
    this.emitted = true;
    return {
      id: this.id,
      name: this.name,
      args,
      isClientInitiated: false,
    };
  }
}

class OpenAIStreamParser {
  private readonly toolCallBuffers = new Map<number, ToolCallAccumulator>();
  private lastResponseId?: string;

  constructor(private readonly fallbackModel: string) {}

  processChoice(
    choice: OpenAIChatCompletionChunkChoice,
    chunk: OpenAIChatCompletionChunk,
  ): GenerateContentResponse | undefined {
    const parts: Part[] = [];
    const contentParts = openAIContentToGeminiParts(choice.delta?.content);
    if (contentParts.length > 0) {
      parts.push(...contentParts);
    }

    const toolCalls = this.captureToolCalls(choice.delta?.tool_calls);
    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        parts.push({ functionCall: call });
      }
    }

    const finishReason = mapFinishReason(choice.finish_reason);
    const usageMetadata = usageToMetadata(chunk.usage);
    this.lastResponseId = chunk.id;

    if (
      parts.length === 0 &&
      !finishReason &&
      !usageMetadata &&
      toolCalls.length === 0
    ) {
      return undefined;
    }

    const candidate: Candidate = {
      content: {
        role: 'model',
        parts,
      },
    };
    if (finishReason) {
      candidate.finishReason = finishReason;
    }

    const response: GenerateContentResponse = {
      modelVersion: chunk.model || this.fallbackModel,
      responseId: chunk.id,
      candidates: [candidate],
    };

    if (toolCalls.length > 0) {
      response.functionCalls = toolCalls;
    }
    if (usageMetadata) {
      response.usageMetadata = usageMetadata;
    }
    return response;
  }

  flushToolCalls(): GenerateContentResponse | undefined {
    if (this.toolCallBuffers.size === 0) {
      return undefined;
    }
    const calls: GeminiFunctionCall[] = [];
    for (const [index, accumulator] of this.toolCallBuffers.entries()) {
      const call = accumulator.finalize();
      if (call) {
        calls.push(call);
      }
      this.toolCallBuffers.delete(index);
    }
    if (calls.length === 0) {
      return undefined;
    }
    return {
      modelVersion: this.fallbackModel,
      responseId: this.lastResponseId,
      candidates: [
        {
          content: {
            role: 'model',
            parts: calls.map((call) => ({ functionCall: call })),
          },
        },
      ],
      functionCalls: calls,
    };
  }

  private captureToolCalls(
    deltas?: OpenAIToolCallMessage[],
  ): GeminiFunctionCall[] {
    if (!deltas || deltas.length === 0) {
      return [];
    }
    const completed: GeminiFunctionCall[] = [];
    for (const delta of deltas) {
      const index = delta.index ?? 0;
      let accumulator = this.toolCallBuffers.get(index);
      if (!accumulator) {
        accumulator = new ToolCallAccumulator();
        this.toolCallBuffers.set(index, accumulator);
      }
      accumulator.append(delta);
      const fnCall = accumulator.tryBuild();
      if (fnCall) {
        completed.push(fnCall);
        this.toolCallBuffers.delete(index);
      }
    }
    return completed;
  }
}

export class OpenAIClient implements ContentGenerator {
  private readonly localModel: LocalModelConfig;
  private readonly chatEndpoint: string;
  private readonly embeddingsEndpoint: string;
  private readonly headers: Record<string, string>;
  private readonly defaultModel: string;
  private readonly isOpenRouter: boolean;

  constructor(private readonly contentGeneratorConfig: ContentGeneratorConfig) {
    if (!contentGeneratorConfig.localModel) {
      throw new Error(
        'Local model configuration is required when using local auth.',
      );
    }
    this.localModel = contentGeneratorConfig.localModel;
    this.defaultModel =
      this.localModel.model ||
      process.env['OPENAI_MODEL'] ||
      DEFAULT_OPENAI_MODEL;
    const endpoint = this.normalizeBaseUrl(
      this.localModel.endpoint ||
        process.env['OPENAI_BASE_URL'] ||
        DEFAULT_OPENAI_ENDPOINT,
    );
    this.chatEndpoint = this.ensurePath(endpoint, 'chat/completions');
    this.embeddingsEndpoint = this.ensurePath(endpoint, 'embeddings');
    this.isOpenRouter = endpoint.includes(OPENROUTER_HOST);
    this.headers = this.buildHeaders();
  }

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    const payload = this.buildChatCompletionRequest(
      request,
      false,
      userPromptId,
    );
    const response = await this.postJson(
      this.chatEndpoint,
      payload,
      request.config?.abortSignal,
    );
    const body = (await response.json()) as OpenAIChatCompletionResponse;
    return this.fromChatCompletionResponse(body);
  }

  async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const payload = this.buildChatCompletionRequest(
      request,
      true,
      userPromptId,
    );
    const response = await this.postJson(
      this.chatEndpoint,
      payload,
      request.config?.abortSignal,
    );

    if (!response.body) {
      throw new Error('OpenAI streaming response had no body.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new OpenAIStreamParser(this.resolveModel(request.model));

    const stream = async function* (): AsyncGenerator<GenerateContentResponse> {
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value ?? new Uint8Array(), {
            stream: !done,
          });

          let newlineIndex = buffer.indexOf('\n');
          while (newlineIndex !== -1) {
            const rawLine = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            const line = rawLine.trim();
            if (line.startsWith(DATA_PREFIX)) {
              const data = line.slice(DATA_PREFIX.length).trim();
              if (!data) {
                newlineIndex = buffer.indexOf('\n');
                continue;
              }
              if (data === SSE_TERMINATOR) {
                const trailing = parser.flushToolCalls();
                if (trailing) {
                  yield trailing;
                }
                return;
              }
              try {
                const chunk = JSON.parse(data) as OpenAIChatCompletionChunk;
                for (const choice of chunk.choices ?? []) {
                  const parsed = parser.processChoice(choice, chunk);
                  if (parsed) {
                    yield parsed;
                  }
                }
              } catch {
                // Ignore malformed chunk
              }
            }
            newlineIndex = buffer.indexOf('\n');
          }

          if (done) {
            if (buffer.trim().length > 0) {
              try {
                const chunk = JSON.parse(
                  buffer.trim(),
                ) as OpenAIChatCompletionChunk;
                for (const choice of chunk.choices ?? []) {
                  const parsed = parser.processChoice(choice, chunk);
                  if (parsed) {
                    yield parsed;
                  }
                }
              } catch {
                // Ignore malformed trailing data
              }
            }
            const trailing = parser.flushToolCalls();
            if (trailing) {
              yield trailing;
            }
            return;
          }
        }
      } finally {
        reader.releaseLock();
      }
    };

    return stream();
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    const contents = toContents(request.contents);
    const totalChars = contents.reduce((sum, content) => {
      const text =
        content.parts
          ?.map((part) => ('text' in part && part.text ? part.text : ''))
          .join('') ?? '';
      return sum + text.length;
    }, 0);
    const totalTokens = Math.max(1, Math.ceil(totalChars / 4));
    return { totalTokens };
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    throw new Error(
      'Embeddings are not supported for OpenAI-compatible providers yet.',
    );
  }

  private resolveModel(requestedModel?: string): string {
    if (this.localModel.model) {
      return this.localModel.model;
    }
    if (requestedModel && !requestedModel.toLowerCase().includes('gemini')) {
      return requestedModel;
    }
    return this.defaultModel;
  }

  private buildChatCompletionRequest(
    request: GenerateContentParameters,
    stream: boolean,
    userPromptId: string,
  ): OpenAIChatCompletionRequest {
    const messages = this.buildMessages(request);
    if (messages.length === 0) {
      throw new Error('Unable to build OpenAI request: no messages provided.');
    }

    const config = request.config ?? {};
    const payload: OpenAIChatCompletionRequest = {
      model: this.resolveModel(request.model),
      messages,
      temperature: config.temperature,
      top_p: config.topP,
      presence_penalty: config.presencePenalty,
      frequency_penalty: config.frequencyPenalty,
      max_tokens: config.maxOutputTokens,
      stop: config.stopSequences,
      user: userPromptId.slice(0, 64),
      stream,
    };

    const candidateCount = config.candidateCount ?? 1;
    if (!stream) {
      payload.n = candidateCount;
    }

    const functionDeclarations = this.extractFunctionDeclarations(config.tools);
    if (functionDeclarations.length > 0) {
      payload.tools = functionDeclarations.map((fn) => ({
        type: 'function',
        function: {
          name: fn.name ?? 'tool_call',
          description: fn.description,
          parameters: cloneSchema(fn.parametersJsonSchema ?? fn.parameters) ?? {
            type: 'object',
            properties: {},
          },
        },
      }));
      const toolChoice = this.resolveToolChoice(config);
      if (toolChoice) {
        payload.tool_choice = toolChoice;
      }
    }

    if (config.responseMimeType === 'application/json') {
      if (config.responseJsonSchema) {
        const schema = cloneSchema(config.responseJsonSchema) ?? {
          type: 'object',
          properties: {},
        };
        payload.response_format = {
          type: 'json_schema',
          json_schema: {
            name: 'gemini_response',
            schema,
          },
        };
      } else {
        payload.response_format = { type: 'json_object' };
      }
    }

    if (stream) {
      payload.stream_options = { include_usage: true };
    }

    return payload;
  }

  private resolveToolChoice(
    config: GenerateContentParameters['config'],
  ): OpenAIChatCompletionRequest['tool_choice'] | undefined {
    const mode = config?.toolConfig?.functionCallingConfig?.mode;
    const allowed =
      config?.toolConfig?.functionCallingConfig?.allowedFunctionNames;
    if (!mode) {
      return undefined;
    }
    switch (mode) {
      case FunctionCallingConfigMode.NONE:
        return 'none';
      case FunctionCallingConfigMode.ANY:
        if (allowed && allowed.length === 1) {
          return { type: 'function', function: { name: allowed[0]! } };
        }
        return 'required';
      case FunctionCallingConfigMode.AUTO:
      case FunctionCallingConfigMode.VALIDATED:
      default:
        return 'auto';
    }
  }

  private buildMessages(
    request: GenerateContentParameters,
  ): OpenAIChatMessage[] {
    const messages: OpenAIChatMessage[] = [];
    const toolCallIdQueue = new Map<string, string[]>();

    const pushContent = (content: Content): void => {
      const role = this.mapRole(content.role);
      if (role === 'tool') {
        // Tool responses are handled via functionResponse parts.
        return;
      }
      const textParts: OpenAIMessageContentPart[] = [];
      const toolCalls: OpenAIToolCallMessage[] = [];

      for (const part of content.parts ?? []) {
        if (part.functionResponse) {
          const toolMessage = this.toToolMessage(
            part.functionResponse,
            toolCallIdQueue,
          );
          if (toolMessage) {
            messages.push(toolMessage);
          }
          continue;
        }
        if (part.functionCall) {
          const toolCall = this.fromFunctionCallPart(
            part.functionCall,
            toolCallIdQueue,
          );
          if (toolCall) {
            toolCalls.push(toolCall);
          }
          continue;
        }
        const converted = this.partToOpenAIContentParts(part);
        if (converted.length > 0) {
          textParts.push(...converted);
        }
      }

      if (textParts.length === 0 && toolCalls.length === 0) {
        return;
      }

      const message: OpenAIChatMessage = {
        role: role === 'system' || role === 'assistant' ? role : 'user',
        content: textParts.length > 0 ? textParts : '',
      };
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
        if (textParts.length === 0) {
          message.content = '';
        }
      }
      messages.push(message);
    };

    const systemMessages = this.normalizeContentUnion(
      request.config?.systemInstruction,
    );
    for (const content of systemMessages) {
      messages.push({
        role: 'system',
        content:
          content.parts && content.parts.length > 0
            ? content.parts
                .map((part) => ('text' in part && part.text ? part.text : ''))
                .join('\n')
            : '',
      });
    }

    const normalizedContents = toContents(request.contents);
    for (const content of normalizedContents) {
      pushContent(content);
    }

    return messages;
  }

  private normalizeContentUnion(content?: ContentUnion): Content[] {
    if (!content) {
      return [];
    }
    return toContents(content as ContentListUnion);
  }

  private partToOpenAIContentParts(part: Part): OpenAIMessageContentPart[] {
    if (!part) {
      return [];
    }
    if (typeof part.text === 'string') {
      return part.text ? [{ type: 'text', text: part.text }] : [];
    }
    if (part.inlineData?.data) {
      if (part.inlineData.mimeType?.startsWith('image/')) {
        return [
          {
            type: 'image_url',
            image_url: {
              url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
            },
          },
        ];
      }
      return [
        {
          type: 'text',
          text: `[Binary data: ${part.inlineData.mimeType ?? 'application/octet-stream'}]`,
        },
      ];
    }
    if (part.fileData?.fileUri) {
      const label = part.fileData.displayName ?? part.fileData.fileUri;
      return [{ type: 'text', text: `[File reference: ${label}]` }];
    }
    if (part.executableCode?.code) {
      const language = part.executableCode.language ?? 'text';
      return [
        {
          type: 'text',
          text: `\`\`\`${language}\n${part.executableCode.code}\n\`\`\``,
        },
      ];
    }
    if (part.codeExecutionResult) {
      return [
        {
          type: 'text',
          text: `Code execution result:\n${stringifyUnknown(part.codeExecutionResult)}`,
        },
      ];
    }
    return [];
  }

  private fromFunctionCallPart(
    fnCall: FunctionCall,
    queue: Map<string, string[]>,
  ): OpenAIToolCallMessage | undefined {
    if (!fnCall) {
      return undefined;
    }
    const id = fnCall.id ?? randomUUID();
    if (fnCall.name) {
      this.rememberToolCallId(queue, fnCall.name, id);
    }
    return {
      id,
      type: 'function',
      function: {
        name: fnCall.name ?? 'tool_call',
        arguments: JSON.stringify(fnCall.args ?? {}),
      },
    };
  }

  private toToolMessage(
    functionResponse: Part['functionResponse'],
    queue: Map<string, string[]>,
  ): OpenAIChatMessage | undefined {
    if (!functionResponse) {
      return undefined;
    }
    const callId =
      functionResponse.id ||
      this.consumeToolCallId(queue, functionResponse.name) ||
      randomUUID();
    return {
      role: 'tool',
      tool_call_id: callId,
      name: functionResponse.name,
      content: stringifyUnknown(functionResponse.response ?? {}),
    };
  }

  private rememberToolCallId(
    queue: Map<string, string[]>,
    name: string,
    id: string,
  ): void {
    const existing = queue.get(name) ?? [];
    existing.push(id);
    queue.set(name, existing);
  }

  private consumeToolCallId(
    queue: Map<string, string[]>,
    name?: string,
  ): string | undefined {
    if (!name) {
      return undefined;
    }
    const existing = queue.get(name);
    if (!existing || existing.length === 0) {
      return undefined;
    }
    const value = existing.shift();
    if (existing.length === 0) {
      queue.delete(name);
    }
    return value;
  }

  private extractFunctionDeclarations(
    tools?: ToolListUnion,
  ): FunctionDeclaration[] {
    if (!tools) {
      return [];
    }
    const toolArray: Tool[] = Array.isArray(tools) ? tools : [tools];
    const declarations: FunctionDeclaration[] = [];
    for (const tool of toolArray) {
      if (tool?.functionDeclarations) {
        declarations.push(...tool.functionDeclarations);
      }
    }
    return declarations;
  }

  private mapRole(role?: string): 'system' | 'user' | 'assistant' | 'tool' {
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
    if (normalized === 'tool') {
      return 'tool';
    }
    return 'user';
  }

  private fromChatCompletionResponse(
    response: OpenAIChatCompletionResponse,
  ): GenerateContentResponse {
    const candidates: Candidate[] = [];
    const functionCalls: GeminiFunctionCall[] = [];

    for (const choice of response.choices ?? []) {
      const parts = openAIContentToGeminiParts(choice.message?.content);
      const toolCalls = (choice.message?.tool_calls ?? [])
        .map((call) => this.toFunctionCall(call))
        .filter((call): call is GeminiFunctionCall => !!call);
      if (toolCalls.length > 0) {
        functionCalls.push(...toolCalls);
        for (const call of toolCalls) {
          parts.push({ functionCall: call });
        }
      }
      const candidate: Candidate = {
        content: {
          role: 'model',
          parts,
        },
        index: choice.index,
      };
      const finishReason = mapFinishReason(choice.finish_reason);
      if (finishReason) {
        candidate.finishReason = finishReason;
      }
      candidates.push(candidate);
    }

    const result: GenerateContentResponse = {
      modelVersion: response.model || this.defaultModel,
      responseId: response.id,
      candidates,
      usageMetadata: usageToMetadata(response.usage),
    };
    if (response.created) {
      result.createTime = new Date(response.created * 1000).toISOString();
    }
    if (functionCalls.length > 0) {
      result.functionCalls = functionCalls;
    }
    return result;
  }

  private toFunctionCall(
    call?: OpenAIToolCallMessage,
  ): GeminiFunctionCall | undefined {
    if (!call) {
      return undefined;
    }
    const id = call.id ?? randomUUID();
    const name = call.function?.name ?? 'tool_call';
    const args =
      safeJsonParse(call.function?.arguments) ??
      (call.function?.arguments ? { raw: call.function.arguments } : {});
    return {
      id,
      name,
      args,
      isClientInitiated: false,
    };
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': this.buildUserAgent(),
    };
    const apiKey =
      this.localModel.apiKey ||
      process.env['OPENAI_API_KEY'] ||
      process.env['LOCAL_MODEL_API_KEY'] ||
      process.env['OPENROUTER_API_KEY'];
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    if (this.isOpenRouter) {
      headers['HTTP-Referer'] =
        process.env['OPENROUTER_SITE_URL'] ||
        'https://github.com/google-gemini/gemini-cli';
      headers['X-Title'] = process.env['OPENROUTER_APP_NAME'] || 'Gemini CLI';
    }
    return headers;
  }

  private buildUserAgent(): string {
    const version =
      process.env['CLI_VERSION'] || process.env['npm_package_version'] || 'dev';
    return `GeminiCLI/${version} (${process.platform}; ${process.arch})`;
  }

  private normalizeBaseUrl(url: string): string {
    return url.replace(/\/+$/, '');
  }

  private ensurePath(baseUrl: string, suffix: string): string {
    if (baseUrl.endsWith(suffix)) {
      return baseUrl;
    }
    return `${baseUrl}/${suffix}`;
  }

  private async postJson(
    url: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      throw new Error(`OpenAI request failed: ${getErrorMessage(error)}`);
    }

    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        const errorBody = await response.json();
        if (errorBody?.error?.message) {
          message = errorBody.error.message;
        }
      } catch {
        // ignore
      }
      throw new Error(`OpenAI request failed: ${message}`);
    }

    return response;
  }
}
