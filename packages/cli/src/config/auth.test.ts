/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@google/gemini-cli-core';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateAuthMethod } from './auth.js';

let mergedSettings: Record<string, unknown> = {};

vi.mock('./settings.js', () => ({
  loadEnvironment: vi.fn(),
  loadSettings: vi.fn().mockImplementation(() => ({
    merged: mergedSettings,
  })),
}));

describe('validateAuthMethod', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('GEMINI_API_KEY', undefined);
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', undefined);
    vi.stubEnv('GOOGLE_API_KEY', undefined);
    vi.stubEnv('OPENAI_API_KEY', undefined);
    vi.stubEnv('LOCAL_MODEL_API_KEY', undefined);
    mergedSettings = {};
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should return null for LOGIN_WITH_GOOGLE', () => {
    expect(validateAuthMethod(AuthType.LOGIN_WITH_GOOGLE)).toBeNull();
  });

  it('should return null for CLOUD_SHELL', () => {
    expect(validateAuthMethod(AuthType.CLOUD_SHELL)).toBeNull();
  });

  describe('USE_GEMINI', () => {
    it('should return null if GEMINI_API_KEY is set', () => {
      vi.stubEnv('GEMINI_API_KEY', 'test-key');
      expect(validateAuthMethod(AuthType.USE_GEMINI)).toBeNull();
    });

    it('should return an error message if GEMINI_API_KEY is not set', () => {
      vi.stubEnv('GEMINI_API_KEY', undefined);
      expect(validateAuthMethod(AuthType.USE_GEMINI)).toBe(
        'GEMINI_API_KEY not found. Find your existing key or generate a new one at: https://aistudio.google.com/apikey\n' +
          '\n' +
          'To continue, please set the GEMINI_API_KEY environment variable or add it to a .env file.',
      );
    });
  });

  describe('USE_VERTEX_AI', () => {
    it('should return null if GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION are set', () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'test-location');
      expect(validateAuthMethod(AuthType.USE_VERTEX_AI)).toBeNull();
    });

    it('should return null if GOOGLE_API_KEY is set', () => {
      vi.stubEnv('GOOGLE_API_KEY', 'test-api-key');
      expect(validateAuthMethod(AuthType.USE_VERTEX_AI)).toBeNull();
    });

    it('should return an error message if no required environment variables are set', () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', undefined);
      expect(validateAuthMethod(AuthType.USE_VERTEX_AI)).toBe(
        'When using Vertex AI, you must specify either:\n' +
          '• GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION environment variables.\n' +
          '• GOOGLE_API_KEY environment variable (if using express mode).\n' +
          'Update your environment and try again (no reload needed if using .env)!',
      );
    });
  });

  describe('USE_LOCAL_MODEL', () => {
    it('returns null if OPENAI_API_KEY is set', () => {
      vi.stubEnv('OPENAI_API_KEY', 'openai-key');
      expect(validateAuthMethod(AuthType.USE_LOCAL_MODEL)).toBeNull();
    });

    it('returns null if settings.localModel.apiKey is set', () => {
      mergedSettings = { localModel: { apiKey: 'from-settings' } };
      expect(validateAuthMethod(AuthType.USE_LOCAL_MODEL)).toBeNull();
    });

    it('returns error if no key is available', () => {
      expect(validateAuthMethod(AuthType.USE_LOCAL_MODEL)).toBe(
        'OPENAI_API_KEY not found. Provide an OpenAI-compatible key via environment variable, .env file, or settings.localModel.apiKey.',
      );
    });

    it('does not require API key when provider is ollama', () => {
      mergedSettings = { localModel: { provider: 'ollama' } };
      expect(validateAuthMethod(AuthType.USE_LOCAL_MODEL)).toBeNull();
    });

    it('honors LOCAL_MODEL_PROVIDER=ollama', () => {
      vi.stubEnv('LOCAL_MODEL_PROVIDER', 'ollama');
      expect(validateAuthMethod(AuthType.USE_LOCAL_MODEL)).toBeNull();
    });
  });

  it('should return an error message for an invalid auth method', () => {
    expect(validateAuthMethod('invalid-method')).toBe(
      'Invalid auth method selected.',
    );
  });
});
