/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type {
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import { FinishReason } from '@google/genai';
import { OpenAIClient } from './openAIClient.js';
import { AuthType } from './contentGenerator.js';

function createClient() {
  return new OpenAIClient({
    authType: AuthType.USE_LOCAL_MODEL,
    localModel: {
      provider: 'openai-compatible',
      apiKey: 'sk-test',
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    },
  });
}

describe('OpenAIClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends chat completion requests and maps responses', async () => {
    const mockResponse = {
      id: 'resp_123',
      model: 'gpt-4o-mini',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello!' }],
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'ping', arguments: '{"input":"42"}' },
              },
            ],
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    };

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

    const client = createClient();
    const request: GenerateContentParameters = {
      model: 'gemini-2.0-flash',
      contents: [{ role: 'user', parts: [{ text: 'Say hi' }] }],
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: 'ping',
                description: 'Ping tool',
                parametersJsonSchema: {
                  type: 'object',
                  properties: { input: { type: 'string' } },
                },
              },
            ],
          },
        ],
      },
    };

    const response = await client.generateContent(request, 'prompt-1');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const payload = JSON.parse(init!.body as string) as {
      messages: Array<{ role: string; content: unknown }>;
      tools: unknown[];
    };
    expect(payload.messages[1]?.role).toBe('user');
    expect(payload.messages[1]?.content?.[0]?.text).toBe('Say hi');
    expect(payload.tools).toHaveLength(1);

    expect(response.modelVersion).toBe('gpt-4o-mini');
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    expect(parts[0]?.text).toBe('Hello!');
    expect(parts[1]?.functionCall?.name).toBe('ping');
    expect(response.functionCalls?.[0]?.name).toBe('ping');
    expect(response.usageMetadata?.totalTokenCount).toBe(14);
  });

  it('streams responses and surfaces finish reasons', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"id":"chunk_1","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":[{"type":"text","text":"Hello"}]}}]}\n\n',
      'data: {"id":"chunk_1","model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11}}\n\n',
      'data: [DONE]\n\n',
    ];

    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    const client = createClient();
    const request: GenerateContentParameters = {
      model: 'gemini-2.0-flash',
      contents: [{ role: 'user', parts: [{ text: 'Say hi' }] }],
    };

    const responseStream = await client.generateContentStream(
      request,
      'prompt-stream',
    );
    const collected: GenerateContentResponse[] = [];
    for await (const chunk of responseStream) {
      collected.push(chunk);
    }

    expect(collected).toHaveLength(2);
    expect(collected[0]?.candidates?.[0]?.content?.parts?.[0]?.text).toBe(
      'Hello',
    );
    expect(collected[1]?.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
    expect(collected[1]?.usageMetadata?.totalTokenCount).toBe(11);
  });
});
