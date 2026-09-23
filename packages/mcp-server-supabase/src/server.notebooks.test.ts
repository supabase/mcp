import { createOrganization, createProject } from '../test/mocks.js';
import { createServerHarness } from '../test/server-harness.js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const harness = createServerHarness();
const setup = harness.setup;

beforeEach(() => harness.reset());
afterEach(() => harness.close());

describe('tools', () => {
  test('list notebooks', async () => {
    const { callTool } = await setup({ features: ['notebooks'] });

    const org = await createOrganization({
      name: 'My Org',
      plan: 'free',
      allowed_release_channels: ['ga'],
    });

    const project = await createProject({
      name: 'Project 1',
      region: 'us-east-1',
      organization_id: org.id,
    });
    project.status = 'ACTIVE_HEALTHY';

    project.createNotebook({ name: 'Notebook 1', favorite: true });
    project.createNotebook({
      name: 'Notebook 2',
      description: 'Second notebook',
    });

    const result = await callTool({
      name: 'list_notebooks',
      arguments: {
        project_id: project.id,
      },
    });

    expect(Array.isArray(result.notebooks)).toBe(true);
    expect(result.notebooks.length).toBe(2);
    expect(result.notebooks[0]).toEqual(
      expect.objectContaining({
        name: 'Notebook 1',
        description: null,
        favorite: true,
        inserted_at: expect.any(String),
        updated_at: expect.any(String),
      })
    );
    expect(result.notebooks[1]).toEqual(
      expect.objectContaining({
        name: 'Notebook 2',
        description: 'Second notebook',
        favorite: false,
      })
    );
    // list_notebooks omits cell content
    expect(result.notebooks[0].content).toBeUndefined();
  });

  test('get notebook', async () => {
    const { callTool } = await setup({ features: ['notebooks'] });

    const org = await createOrganization({
      name: 'My Org',
      plan: 'free',
      allowed_release_channels: ['ga'],
    });

    const project = await createProject({
      name: 'Project 1',
      region: 'us-east-1',
      organization_id: org.id,
    });
    project.status = 'ACTIVE_HEALTHY';

    const notebook = project.createNotebook({
      name: 'Notebook 1',
      content: {
        schema_version: 1,
        cells: [{ id: 'cell-1', type: 'markdown', text: 'Hello world' }],
      },
    });

    const result = await callTool({
      name: 'get_notebook',
      arguments: {
        project_id: project.id,
        notebook_id: notebook.id,
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        id: notebook.id,
        name: 'Notebook 1',
        content: {
          schema_version: 1,
          cells: expect.any(String),
        },
      })
    );
    expect(result.content.cells).toContain('untrusted user data');
    expect(result.content.cells).toMatch(
      /<untrusted-data-\w{8}-\w{4}-\w{4}-\w{4}-\w{12}>/
    );
    expect(result.content.cells).toContain(
      JSON.stringify([{ id: 'cell-1', type: 'markdown', text: 'Hello world' }])
    );
  });

  test('get notebook that does not exist throws an error', async () => {
    const { callTool } = await setup({ features: ['notebooks'] });

    const org = await createOrganization({
      name: 'My Org',
      plan: 'free',
      allowed_release_channels: ['ga'],
    });

    const project = await createProject({
      name: 'Project 1',
      region: 'us-east-1',
      organization_id: org.id,
    });
    project.status = 'ACTIVE_HEALTHY';

    const result = callTool({
      name: 'get_notebook',
      arguments: {
        project_id: project.id,
        notebook_id: 'does-not-exist',
      },
    });

    await expect(result).rejects.toThrow('Notebook not found');
  });
});
