/// <reference types="../extensions.d.ts" />

import { generateText, stepCountIs } from 'ai';
import { describe, expect, test } from 'vitest';
import { createOrganization, createProject } from '../mocks.js';
import { getTestModel, setup } from './utils.js';

describe('project management e2e tests', () => {
  test('identifies correct project before listing tables', async () => {
    const { client, toolSchemas } = await setup();
    const model = getTestModel();

    const org = await createOrganization({
      name: 'My Org',
      plan: 'free',
      allowed_release_channels: ['ga'],
    });

    const todosProject = await createProject({
      name: 'todos-app',
      region: 'us-east-1',
      organization_id: org.id,
    });

    const inventoryProject = await createProject({
      name: 'inventory-app',
      region: 'us-east-1',
      organization_id: org.id,
    });

    await todosProject.db.sql`create table todos (id serial, name text)`;
    await inventoryProject.db
      .sql`create table inventory (id serial, name text)`;

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
          content: 'What tables do I have in this project?',
        },
      ],
      stopWhen: stepCountIs(3),
    });

    const toolCalls = steps.flatMap((step) => step.staticToolCalls);
    const text = steps.at(-1)?.text ?? '';

    expect(toolCalls.length).toBeGreaterThanOrEqual(2);
    expect(toolCalls.at(0)?.toolName).toBe('list_projects');
    expect(toolCalls.at(1)?.toolName).toBe('list_tables');

    const listTablesCalls = toolCalls.filter(
      (call) => call.toolName === 'list_tables'
    );
    for (const call of listTablesCalls) {
      expect(call.input.project_id).toBe(todosProject.id);
    }

    await expect(text).toMatchCriteria(
      'Describes a single table in the "todos-app" project called "todos"'
    );
  });

  test('project scoped server uses less tool calls', async () => {
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

    await project.db.sql`create table todos (id serial, name text)`;

    const { client, toolSchemas } = await setup({ projectId: project.id });
    const model = getTestModel();

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
          content: `What tables do I have?`,
        },
      ],
      stopWhen: stepCountIs(2),
    });

    const toolCalls = steps.flatMap((step) => step.staticToolCalls);
    const text = steps.at(-1)?.text ?? '';

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls.at(0)?.toolName).toBe('list_tables');

    await expect(text).toMatchCriteria(
      `Describes the single todos table available in the project.`
    );
  });
});
