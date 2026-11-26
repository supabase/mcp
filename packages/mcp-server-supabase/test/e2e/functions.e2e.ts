/// <reference types="../extensions.d.ts" />

import { generateText, stepCountIs } from 'ai';
import { codeBlock } from 'common-tags';
import { describe, expect, test } from 'vitest';
import { createOrganization, createProject } from '../mocks.js';
import { join } from 'node:path/posix';
import { getTestModel, setup } from './utils.js';

describe('edge function e2e tests', () => {
  test('deploys an edge function', async () => {
    const { client, toolSchemas } = await setup();
    const model = getTestModel();

    const org = await createOrganization({
      name: 'My Org',
      plan: 'free',
      allowed_release_channels: ['ga'],
    });

    const project = await createProject({
      name: 'todos-app',
      region: 'us-east-1',
      organization_id: org.id,
    });

    const tools = await client.tools({ schemas: toolSchemas });

    const { steps } = await generateText({
      model,
      tools,
      messages: [
        {
          role: 'system',
          content:
            'You are a coding assistant. The current working directory is /home/user/projects/todos-app.',
        },
        {
          role: 'user',
          content: `Deploy an edge function to project with ref ${project.id} that returns the current time in UTC.`,
        },
      ],
      stopWhen: stepCountIs(3),
    });

    const toolCalls = steps.flatMap((step) => step.staticToolCalls);
    const text = steps.at(-1)?.text ?? '';

    expect(toolCalls.some((c) => c.toolName === 'deploy_edge_function')).toBe(
      true
    );

    await expect(text).toMatchCriteria(
      'Confirms the successful deployment of an edge function that will return the current time in UTC.'
    );
  });

  test('modifies an edge function', async () => {
    const { client, toolSchemas } = await setup();
    const model = getTestModel();

    const org = await createOrganization({
      name: 'My Org',
      plan: 'free',
      allowed_release_channels: ['ga'],
    });

    const project = await createProject({
      name: 'todos-app',
      region: 'us-east-1',
      organization_id: org.id,
    });

    const code = codeBlock`
      Deno.serve(async (req: Request) => {
        return new Response('Hello world!', { headers: { 'Content-Type': 'text/plain' } })
      })
    `;

    const edgeFunction = await project.deployEdgeFunction(
      {
        name: 'hello-world',
        entrypoint_path: 'index.ts',
      },
      [
        new File([code], 'index.ts', {
          type: 'application/typescript',
        }),
      ]
    );

    const tools = await client.tools({ schemas: toolSchemas });

    const { steps } = await generateText({
      model,
      tools,
      messages: [
        {
          role: 'system',
          content:
            'You are a coding assistant. The current working directory is /home/user/projects/todos-app.',
        },
        {
          role: 'user',
          content: `Change my edge function (project id ${project.id}) to replace "world" with "Earth".`,
        },
      ],
      stopWhen: stepCountIs(4),
    });

    const toolCalls = steps.flatMap((step) => step.staticToolCalls);
    const text = steps.at(-1)?.text ?? '';

    expect(toolCalls).toHaveLength(3);
    expect(toolCalls.at(0)?.toolName).toBe('list_edge_functions');
    expect(toolCalls.at(1)?.toolName).toBe('get_edge_function');
    expect(toolCalls.at(2)?.toolName).toBe('deploy_edge_function');

    await expect(text).toMatchCriteria(
      'Confirms the successful modification of an Edge Function.'
    );

    expect(edgeFunction.files).toHaveLength(1);
    expect(edgeFunction.files.at(0)?.name).toBe(
      join(edgeFunction.pathPrefix, 'index.ts')
    );
    await expect(edgeFunction.files.at(0)?.text()).resolves.toEqual(codeBlock`
      Deno.serve(async (req: Request) => {
        return new Response('Hello Earth!', { headers: { 'Content-Type': 'text/plain' } })
      })
    `);
  });
});
