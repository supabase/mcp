import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createServerHarness } from '../test/server-harness.js';
import { LIST_PROJECTS_UI_URI, LIST_TABLES_UI_URI } from './apps/index.js';

const harness = createServerHarness();

beforeEach(() => harness.reset());
afterEach(() => harness.close());

describe('MCP Apps', () => {
  test('every UI resource a tool links to is registered as an MCP App', async () => {
    const { client } = await harness.setup();

    const { tools } = await client.listTools();
    const { resources } = await client.listResources();

    const linkedUris = tools.flatMap((tool) => {
      const ui = tool._meta?.ui as { resourceUri?: string } | undefined;
      return ui?.resourceUri ? [ui.resourceUri] : [];
    });

    expect(linkedUris.length).toBeGreaterThan(0);

    for (const uri of linkedUris) {
      const resource = resources.find((r) => r.uri === uri);
      expect(resource, `no resource registered for ${uri}`).toBeDefined();
      expect(resource?.mimeType).toBe(RESOURCE_MIME_TYPE);
    }
  });

  test('UI resources serve self-contained HTML', async () => {
    const { client } = await harness.setup();

    const { resources } = await client.listResources();
    const uiResources = resources.filter((r) => r.uri.startsWith('ui://'));
    expect(uiResources.map((r) => r.uri).sort()).toEqual(
      [LIST_PROJECTS_UI_URI, LIST_TABLES_UI_URI].sort()
    );

    for (const { uri } of uiResources) {
      const { contents } = await client.readResource({ uri });
      const [content] = contents;

      expect(content?.mimeType).toBe(RESOURCE_MIME_TYPE);
      const html = content && 'text' in content ? content.text : '';
      expect(html, uri).toMatch(/^<!doctype html>/i);
      // Built by vite-plugin-singlefile: scripts are inlined, not loaded.
      expect(html, uri).toContain('<script type="module"');
      expect(html, uri).not.toMatch(/<script[^>]*\ssrc=/);
    }
  });

  test('server declares the MCP Apps extension', async () => {
    const { client } = await harness.setup();

    expect(client.getServerCapabilities()?.extensions).toEqual({
      [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] },
    });
  });

  test('UI resources set CSP and border metadata in the listing and content', async () => {
    const { client } = await harness.setup();

    const expectedMeta = {
      ui: {
        csp: { connectDomains: [], resourceDomains: [] },
        prefersBorder: false,
      },
    };

    const { resources } = await client.listResources();
    const uiResources = resources.filter((r) => r.uri.startsWith('ui://'));
    expect(uiResources.length).toBeGreaterThan(0);

    for (const resource of uiResources) {
      expect(resource._meta, resource.uri).toEqual(expectedMeta);
      expect(resource.description, resource.uri).toBeTruthy();

      const { contents } = await client.readResource({ uri: resource.uri });
      expect(contents[0]?._meta, resource.uri).toEqual(expectedMeta);
    }
  });
});
