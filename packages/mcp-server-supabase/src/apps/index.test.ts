import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import {
  CLIENT_CAPABILITIES_META_KEY,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { describe, expect, test } from 'vitest';
import { appsEnabled, openaiPluginExtensionsEnabled } from './index.js';

function makeContext(capabilities?: Record<string, unknown>): ServerContext {
  return {
    mcpReq: {
      envelope: capabilities
        ? { [CLIENT_CAPABILITIES_META_KEY]: capabilities }
        : {},
    },
  } as unknown as ServerContext;
}

const APPS_CTX = makeContext({
  extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } },
});

const NO_APPS_CTX = makeContext({});

describe('openaiPluginExtensionsEnabled', () => {
  test('defaults to false', () => {
    expect(openaiPluginExtensionsEnabled(false, false, APPS_CTX)).toBe(false);
  });

  test('stays false when experimentalApps is false', () => {
    expect(appsEnabled(false, APPS_CTX)).toBe(false);
    expect(openaiPluginExtensionsEnabled(false, true, APPS_CTX)).toBe(false);
  });

  test('stays false when openaiPluginExtensions is false', () => {
    expect(appsEnabled(true, APPS_CTX)).toBe(true);
    expect(openaiPluginExtensionsEnabled(true, false, APPS_CTX)).toBe(false);
  });

  test('returns true when both flags are true and client advertises MCP Apps', () => {
    expect(openaiPluginExtensionsEnabled(true, true, APPS_CTX)).toBe(true);
  });

  test('returns false without MCP Apps client capability', () => {
    expect(openaiPluginExtensionsEnabled(true, true, NO_APPS_CTX)).toBe(false);
    expect(openaiPluginExtensionsEnabled(true, true, makeContext())).toBe(
      false
    );
    expect(openaiPluginExtensionsEnabled(true, true, undefined)).toBe(false);
  });
});
