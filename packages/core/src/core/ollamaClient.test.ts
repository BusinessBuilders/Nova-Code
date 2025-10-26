/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { GenerateContentParameters } from '@google/genai';
import { AuthType } from './contentGenerator.js';
import { OllamaClient } from './ollamaClient.js';

function createClient() {
  return new OllamaClient({
    authType: AuthType.USE_LOCAL_MODEL,
    localModel: {
      provider: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      model: 'deepseek-coder',
    },
  });
}

describe('OllamaClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('injects tool instructions and parses tool call blocks', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          message: {
            content:
              '```tool_call\n{"name":"run_shell","arguments":{"command":"ls"}}\n```\n',
          },
        }),
        { status: 200 },
      ),
    );

    const client = createClient();
    const request: GenerateContentParameters = {
      model: 'deepseek-coder',
      contents: [{ role: 'user', parts: [{ text: 'List files' }] }],
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: 'run_shell',
                description: 'Run a shell command',
                parametersJsonSchema: {
                  type: 'object',
                  properties: { command: { type: 'string' } },
                },
              },
            ],
          },
        ],
      },
    };

    const response = await client.generateContent(request, 'prompt-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1]?.body ?? '{}') as string,
    ) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0]).toMatchObject({
      role: 'system',
    });
    expect(body.messages[0]?.content).toContain('```tool_call');
    expect(body.messages[0]?.content).toContain('run_shell');
    expect(body.messages[0]?.content).toContain('tool_result');
    expect(body.messages[0]?.content).toContain('tool_result');

    expect(response.functionCalls?.[0]?.name).toBe('run_shell');
    expect(
      response.candidates?.[0]?.content?.parts?.some(
        (part) => !!part.functionCall,
      ),
    ).toBe(true);
  });

  it('formats tool responses as tool_result blocks', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          message: { content: 'ack' },
        }),
        { status: 200 },
      ),
    );

    const client = createClient();
    const request: GenerateContentParameters = {
      model: 'deepseek-coder',
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: 'run_shell',
                response: { output: 'ok' },
              },
            },
          ],
        },
      ],
    };

    await client.generateContent(request, 'prompt-2');

    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1]?.body ?? '{}') as string,
    ) as { messages: Array<{ role: string; content: string }> };
    const toolResultMessage = body.messages.find((msg) =>
      msg.content.includes('```tool_result'),
    );
    expect(toolResultMessage).toBeDefined();
    expect(toolResultMessage?.content).toContain('call-1');
    expect(toolResultMessage?.role).toBe('user');
  });

  it('removes orphaned tool calls before sending history', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          message: { content: 'Response' },
        }),
        { status: 200 },
      ),
    );

    const client = createClient();
    await client.generateContent(
      {
        model: 'deepseek-coder',
        contents: [
          {
            role: 'model',
            parts: [{ functionCall: { name: 'run_shell', args: {} } }],
          },
        ],
      },
      'prompt-3',
    );

    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1]?.body ?? '{}') as string,
    ) as { messages: Array<{ role: string; content: string }> };

    expect(
      body.messages.some(
        (msg) =>
          typeof msg.content === 'string' && msg.content.includes('run_shell'),
      ),
    ).toBe(false);
  });

  it('returns plain text when no tool call is present', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          message: { content: 'All files listed.' },
        }),
        { status: 200 },
      ),
    );

    const client = createClient();
    const request: GenerateContentParameters = {
      model: 'deepseek-coder',
      contents: [{ role: 'user', parts: [{ text: 'List files' }] }],
    };

    const response = await client.generateContent(request, 'prompt-2');
    expect(response.functionCalls).toBeUndefined();
    expect(response.candidates?.[0]?.content?.parts?.[0]?.text).toBe(
      'All files listed.',
    );
  });

  it('streams chunks and surfaces tool calls', async () => {
    const encoder = new TextEncoder();
    const payloads = [
      {
        model: 'deepseek-coder',
        message: {
          content:
            '```tool_call\n{"name":"run_shell","arguments":{"command":"ls"}}\n```',
        },
      },
      {
        done: true,
        done_reason: 'stop',
        eval_count: 10,
        prompt_eval_count: 5,
      },
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const payload of payloads) {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        }
        controller.close();
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(stream as unknown as ReadableStream<Uint8Array>, {
        status: 200,
        headers: { 'Content-Type': 'application/x-ndjson' },
      }),
    );

    const client = createClient();
    const request: GenerateContentParameters = {
      model: 'deepseek-coder',
      contents: [{ role: 'user', parts: [{ text: 'List files' }] }],
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: 'run_shell',
                parametersJsonSchema: {
                  type: 'object',
                  properties: { command: { type: 'string' } },
                },
              },
            ],
          },
        ],
      },
    };

    const streamResult = await client.generateContentStream(
      request,
      'prompt-stream',
    );
    const chunks: GenerateContentResponse[] = [];
    for await (const chunk of streamResult) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.functionCalls?.[0]?.name).toBe('run_shell');
    expect(chunks[1]?.candidates?.[0]?.finishReason).toBeDefined();
    expect(chunks[1]?.usageMetadata?.promptTokenCount).toBe(5);
  });
});
