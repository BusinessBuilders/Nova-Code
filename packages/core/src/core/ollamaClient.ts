/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Content,
  ContentListUnion,
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
  Part,
} from '@google/genai';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from './contentGenerator.js';

function toContents(contents: ContentListUnion): Content[] {
  if (Array.isArray(contents)) {
    return contents.map(toContent);
  }
  return [toContent(contents)];
}

function toContent(content: Content | Part | string): Content {
  if (typeof content === 'string') {
    return { role: 'user', parts: [{ text: content }] };
  }
  if ('role' in content) {
    return content as Content;
  }
  return { role: 'user', parts: [content as Part] };
}

function partToText(part: Part): string {
  if ('text' in part && typeof part.text === 'string') {
    return part.text;
  }
  if (part.functionCall) {
    return JSON.stringify(part.functionCall);
  }
  if (part.functionResponse) {
    return JSON.stringify(part.functionResponse);
  }
  return '';
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

  private contentsToMessages(
    contents: ContentListUnion,
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    return toContents(contents).map((content) => ({
      role: content.role === 'model' ? 'assistant' : 'user',
      content:
        content.parts?.map((part: Part) => partToText(part)).join('') || '',
    }));
  }

  async generateContent(
    request: GenerateContentParameters,
    _userPromptId: string,
  ): Promise<GenerateContentResponse> {
    const targetModel = request.model || this.defaultModel;
    const messages = this.contentsToMessages(request.contents);
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
    };
    const text = data.message?.content ?? '';

    return {
      modelVersion: targetModel,
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text }],
          },
        },
      ],
    } as GenerateContentResponse;
  }

  async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const response = await this.generateContent(request, userPromptId);
    async function* generator() {
      yield response;
    }
    return generator();
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
