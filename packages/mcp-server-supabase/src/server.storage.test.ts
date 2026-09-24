import { createProjectFixture } from '../test/mocks.js';
import { createServerHarness } from '../test/server-harness.js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const harness = createServerHarness();
const setup = harness.setup;

beforeEach(() => harness.reset());
afterEach(() => harness.close());

describe('tools', () => {
  test('list storage buckets', async () => {
    const { callTool } = await setup({ features: ['storage'] });

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    project.createStorageBucket('bucket1', true);
    project.createStorageBucket('bucket2', false);

    const result = await callTool({
      name: 'list_storage_buckets',
      arguments: {
        project_id: project.id,
      },
    });

    expect(Array.isArray(result.buckets)).toBe(true);
    expect(result.buckets.length).toBe(2);
    expect(result.buckets[0]).toEqual(
      expect.objectContaining({
        name: 'bucket1',
        public: true,
        created_at: expect.any(String),
        updated_at: expect.any(String),
      })
    );
    expect(result.buckets[1]).toEqual(
      expect.objectContaining({
        name: 'bucket2',
        public: false,
        created_at: expect.any(String),
        updated_at: expect.any(String),
      })
    );
  });

  test('get storage config', async () => {
    const { callTool } = await setup({ features: ['storage'] });

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const result = await callTool({
      name: 'get_storage_config',
      arguments: {
        project_id: project.id,
      },
    });

    expect(result).toEqual({
      fileSizeLimit: expect.any(Number),
      features: {
        imageTransformation: { enabled: expect.any(Boolean) },
        s3Protocol: { enabled: expect.any(Boolean) },
      },
    });
  });

  test('update storage config', async () => {
    const { callTool } = await setup({ features: ['storage'] });

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const config = {
      fileSizeLimit: 50,
      features: {
        imageTransformation: { enabled: true },
        s3Protocol: { enabled: false },
      },
    };

    const result = await callTool({
      name: 'update_storage_config',
      arguments: {
        project_id: project.id,
        config,
      },
    });

    expect(result).toEqual({ success: true });
  });

  test('update storage config in read-only mode throws an error', async () => {
    const { callTool } = await setup({ readOnly: true, features: ['storage'] });

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const config = {
      fileSizeLimit: 50,
      features: {
        imageTransformation: { enabled: true },
        s3Protocol: { enabled: false },
      },
    };

    const result = callTool({
      name: 'update_storage_config',
      arguments: {
        project_id: project.id,
        config,
      },
    });

    await expect(result).rejects.toThrow(
      'Cannot update storage config in read-only mode.'
    );
  });
});
