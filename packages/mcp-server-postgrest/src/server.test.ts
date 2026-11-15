import { Client } from '@modelcontextprotocol/client';
import { AuthClient } from '@supabase/auth-js';
import { StreamTransport } from '@supabase/mcp-utils';
import { describe, expect, test } from 'vitest';

import { createPostgrestMcpServer } from './server.js';

// Requires local Supabase stack running
const API_URL = 'http://127.0.0.1:54321';
const REST_API_URL = `${API_URL}/rest/v1`;
const AUTH_API_URL = `${API_URL}/auth/v1`;

/**
 * Sets up a client and server for testing.
 */
async function setup() {
  const clientTransport = new StreamTransport();
  const serverTransport = new StreamTransport();

  clientTransport.readable.pipeTo(serverTransport.writable);
  serverTransport.readable.pipeTo(clientTransport.writable);

  const client = new Client(
    {
      name: 'TestClient',
      version: '0.1.0',
    },
    {
      capabilities: {},
    }
  );

  const authClient = new AuthClient({
    url: AUTH_API_URL,
  });

  await authClient.signUp({
    email: 'john@example.com',
    password: 'password',
  });

  const authResponse = await authClient.signInWithPassword({
    email: 'john@example.com',
    password: 'password',
  });

  if (authResponse.error) {
    throw new Error(authResponse.error.message);
  }

  const server = createPostgrestMcpServer({
    apiUrl: REST_API_URL,
    schema: 'public',
    apiKey: authResponse.data.session.access_token,
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  // Clear existing todos
  const deleteOutput = await client.callTool({
    name: 'postgrestRequest',
    arguments: {
      method: 'DELETE',
      path: '/todos?id=gt.0',
    },
  });

  if (deleteOutput.isError) {
    throw new Error(JSON.stringify(deleteOutput.content));
  }

  const todoSeeds = [
    {
      title: 'Buy groceries',
      description: 'Purchase milk, eggs, and bread from the store',
      due_date: '2023-10-15',
      is_completed: false,
    },
    {
      title: 'Complete project report',
      description:
        'Finalize and submit the project report by the end of the week',
      due_date: '2023-10-20',
      is_completed: false,
    },
    {
      title: 'Doctor appointment',
      description: 'Annual check-up with Dr. Smith at 10 AM',
      due_date: '2023-10-18',
      is_completed: false,
    },
    {
      title: 'Call plumber',
      description: 'Fix the leaking sink in the kitchen',
      due_date: '2023-10-16',
      is_completed: false,
    },
    {
      title: 'Read book',
      description: 'Finish reading "The Great Gatsby"',
      due_date: '2023-10-22',
      is_completed: false,
    },
  ];

  // Seed todos
  const output = await client.callTool({
    name: 'postgrestRequest',
    arguments: {
      method: 'POST',
      path: '/todos',
      body: todoSeeds,
    },
  });

  if (output.isError) {
    throw new Error(JSON.stringify(output.content));
  }

  return { client, clientTransport, server, serverTransport };
}

describe('resources', () => {
  test('list', async () => {
    const { client } = await setup();
    const { resources } = await client.listResources();

    expect(resources).toHaveLength(1);

    const [firstResource] = resources;

    if (!firstResource) {
      throw new Error('no resources');
    }

    expect(firstResource).toMatchInlineSnapshot(`
      {
        "description": "OpenAPI spec for the PostgREST API",
        "mimeType": "application/json",
        "name": "OpenAPI spec",
        "uri": "postgrest:///spec",
      }
    `);
  });

  test('read', async () => {
    const { client } = await setup();
    const { contents } = await client.readResource({
      uri: 'postgrest:///spec',
    });

    const [firstContent] = contents;

    expect(firstContent).toMatchInlineSnapshot(`
      {
        "mimeType": "application/json",
        "text": "{"swagger":"2.0","info":{"description":"","title":"standard public schema","version":"12.2.0 (ec89f6b)"},"host":"0.0.0.0:3000","basePath":"/","schemes":["http"],"consumes":["application/json","application/vnd.pgrst.object+json;nulls=stripped","application/vnd.pgrst.object+json","text/csv"],"produces":["application/json","application/vnd.pgrst.object+json;nulls=stripped","application/vnd.pgrst.object+json","text/csv"],"paths":{"/":{"get":{"produces":["application/openapi+json","application/json"],"responses":{"200":{"description":"OK"}},"summary":"OpenAPI description (this document)","tags":["Introspection"]}},"/todos":{"get":{"parameters":[{"$ref":"#/parameters/rowFilter.todos.id"},{"$ref":"#/parameters/rowFilter.todos.title"},{"$ref":"#/parameters/rowFilter.todos.description"},{"$ref":"#/parameters/rowFilter.todos.due_date"},{"$ref":"#/parameters/rowFilter.todos.is_completed"},{"$ref":"#/parameters/rowFilter.todos.user_id"},{"$ref":"#/parameters/select"},{"$ref":"#/parameters/order"},{"$ref":"#/parameters/range"},{"$ref":"#/parameters/rangeUnit"},{"$ref":"#/parameters/offset"},{"$ref":"#/parameters/limit"},{"$ref":"#/parameters/preferCount"}],"responses":{"200":{"description":"OK","schema":{"items":{"$ref":"#/definitions/todos"},"type":"array"}},"206":{"description":"Partial Content"}},"summary":"Table to manage todo items with details such as title, description, due date, and completion status.","tags":["todos"]},"post":{"parameters":[{"$ref":"#/parameters/body.todos"},{"$ref":"#/parameters/select"},{"$ref":"#/parameters/preferPost"}],"responses":{"201":{"description":"Created"}},"summary":"Table to manage todo items with details such as title, description, due date, and completion status.","tags":["todos"]},"delete":{"parameters":[{"$ref":"#/parameters/rowFilter.todos.id"},{"$ref":"#/parameters/rowFilter.todos.title"},{"$ref":"#/parameters/rowFilter.todos.description"},{"$ref":"#/parameters/rowFilter.todos.due_date"},{"$ref":"#/parameters/rowFilter.todos.is_completed"},{"$ref":"#/parameters/rowFilter.todos.user_id"},{"$ref":"#/parameters/preferReturn"}],"responses":{"204":{"description":"No Content"}},"summary":"Table to manage todo items with details such as title, description, due date, and completion status.","tags":["todos"]},"patch":{"parameters":[{"$ref":"#/parameters/rowFilter.todos.id"},{"$ref":"#/parameters/rowFilter.todos.title"},{"$ref":"#/parameters/rowFilter.todos.description"},{"$ref":"#/parameters/rowFilter.todos.due_date"},{"$ref":"#/parameters/rowFilter.todos.is_completed"},{"$ref":"#/parameters/rowFilter.todos.user_id"},{"$ref":"#/parameters/body.todos"},{"$ref":"#/parameters/preferReturn"}],"responses":{"204":{"description":"No Content"}},"summary":"Table to manage todo items with details such as title, description, due date, and completion status.","tags":["todos"]}}},"definitions":{"todos":{"description":"Table to manage todo items with details such as title, description, due date, and completion status.","required":["id","title","user_id"],"properties":{"id":{"description":"Note:\\nThis is a Primary Key.<pk/>","format":"bigint","type":"integer"},"title":{"format":"text","type":"string"},"description":{"format":"text","type":"string"},"due_date":{"format":"date","type":"string"},"is_completed":{"default":false,"format":"boolean","type":"boolean"},"user_id":{"default":"auth.uid()","format":"uuid","type":"string"}},"type":"object"}},"parameters":{"preferParams":{"name":"Prefer","description":"Preference","required":false,"enum":["params=single-object"],"in":"header","type":"string"},"preferReturn":{"name":"Prefer","description":"Preference","required":false,"enum":["return=representation","return=minimal","return=none"],"in":"header","type":"string"},"preferCount":{"name":"Prefer","description":"Preference","required":false,"enum":["count=none"],"in":"header","type":"string"},"preferPost":{"name":"Prefer","description":"Preference","required":false,"enum":["return=representation","return=minimal","return=none","resolution=ignore-duplicates","resolution=merge-duplicates"],"in":"header","type":"string"},"select":{"name":"select","description":"Filtering Columns","required":false,"in":"query","type":"string"},"on_conflict":{"name":"on_conflict","description":"On Conflict","required":false,"in":"query","type":"string"},"order":{"name":"order","description":"Ordering","required":false,"in":"query","type":"string"},"range":{"name":"Range","description":"Limiting and Pagination","required":false,"in":"header","type":"string"},"rangeUnit":{"name":"Range-Unit","description":"Limiting and Pagination","required":false,"default":"items","in":"header","type":"string"},"offset":{"name":"offset","description":"Limiting and Pagination","required":false,"in":"query","type":"string"},"limit":{"name":"limit","description":"Limiting and Pagination","required":false,"in":"query","type":"string"},"body.todos":{"name":"todos","description":"todos","required":false,"in":"body","schema":{"$ref":"#/definitions/todos"}},"rowFilter.todos.id":{"name":"id","required":false,"format":"bigint","in":"query","type":"string"},"rowFilter.todos.title":{"name":"title","required":false,"format":"text","in":"query","type":"string"},"rowFilter.todos.description":{"name":"description","required":false,"format":"text","in":"query","type":"string"},"rowFilter.todos.due_date":{"name":"due_date","required":false,"format":"date","in":"query","type":"string"},"rowFilter.todos.is_completed":{"name":"is_completed","required":false,"format":"boolean","in":"query","type":"string"},"rowFilter.todos.user_id":{"name":"user_id","required":false,"format":"uuid","in":"query","type":"string"}},"externalDocs":{"description":"PostgREST Documentation","url":"https://postgrest.org/en/v12.2/api.html"}}",
        "uri": "postgrest:///spec",
      }
    `);
  });
});

describe('tools', () => {
  test('list', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(2);

    const [firstTool, secondTool] = tools;

    if (!firstTool) {
      throw new Error('no tools');
    }

    expect(firstTool).toMatchInlineSnapshot(`
      {
        "description": "Performs an HTTP request against the PostgREST API",
        "inputSchema": {
          "$schema": "http://json-schema.org/draft-07/schema#",
          "additionalProperties": false,
          "properties": {
            "body": {
              "anyOf": [
                {
                  "additionalProperties": {},
                  "type": "object",
                },
                {
                  "items": {
                    "additionalProperties": {},
                    "type": "object",
                  },
                  "type": "array",
                },
              ],
            },
            "method": {
              "enum": [
                "GET",
                "POST",
                "PUT",
                "PATCH",
                "DELETE",
              ],
              "type": "string",
            },
            "path": {
              "type": "string",
            },
          },
          "required": [
            "method",
            "path",
          ],
          "type": "object",
        },
        "name": "postgrestRequest",
      }
    `);

    if (!secondTool) {
      throw new Error('missing second tool');
    }

    expect(secondTool).toMatchInlineSnapshot(`
      {
        "description": "Converts SQL query to a PostgREST API request (method, path)",
        "inputSchema": {
          "$schema": "http://json-schema.org/draft-07/schema#",
          "additionalProperties": false,
          "properties": {
            "sql": {
              "type": "string",
            },
          },
          "required": [
            "sql",
          ],
          "type": "object",
        },
        "name": "sqlToRest",
      }
    `);
  });

  test('execute', async () => {
    const { client } = await setup();
    const output = await client.callTool({
      name: 'postgrestRequest',
      arguments: {
        method: 'GET',
        path: '/todos?select=title,description,due_date,is_completed&order=id.asc',
      },
    });

    const [firstContent] = output.content as any[];

    if (!firstContent) {
      throw new Error('no content');
    }

    const { result } = JSON.parse(firstContent.text);

    expect(result).toMatchInlineSnapshot([
      {
        description: 'Purchase milk, eggs, and bread from the store',
        due_date: '2023-10-15',
        is_completed: false,
        title: 'Buy groceries',
      },
      {
        description:
          'Finalize and submit the project report by the end of the week',
        due_date: '2023-10-20',
        is_completed: false,
        title: 'Complete project report',
      },
      {
        description: 'Annual check-up with Dr. Smith at 10 AM',
        due_date: '2023-10-18',
        is_completed: false,
        title: 'Doctor appointment',
      },
      {
        description: 'Fix the leaking sink in the kitchen',
        due_date: '2023-10-16',
        is_completed: false,
        title: 'Call plumber',
      },
      {
        description: 'Finish reading "The Great Gatsby"',
        due_date: '2023-10-22',
        is_completed: false,
        title: 'Read book',
      },
    ]);
  });

  test('execute with body', async () => {
    const { client } = await setup();
    const output = await client.callTool({
      name: 'postgrestRequest',
      arguments: {
        method: 'POST',
        path: '/todos',
        body: {
          title: 'Test',
          description: 'Test',
          due_date: '2023-10-15',
          is_completed: false,
        },
      },
    });

    const [firstContent] = output.content as any[];

    if (!firstContent) {
      throw new Error('no content');
    }

    const [result] = JSON.parse(firstContent.text).result;

    expect(result).toMatchObject({
      title: 'Test',
      description: 'Test',
      due_date: '2023-10-15',
      is_completed: false,
    });

    // Clean up
    await client.callTool({
      name: 'postgrestRequest',
      arguments: {
        method: 'DELETE',
        path: `/todos?id=eq.${result.id}`,
      },
    });
  });

  test('path traversal is normalized', async () => {
    const { client } = await setup();
    const output = await client.callTool({
      name: 'postgrestRequest',
      arguments: {
        method: 'GET',
        path: '/foo/../todos?select=title&order=id.asc',
      },
    });

    const [firstContent] = output.content as any[];

    if (!firstContent) {
      throw new Error('no content');
    }

    const { result } = JSON.parse(firstContent.text);

    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toMatchObject({ title: 'Buy groceries' });
  });

  test('error response from PostgREST is reported as a tool error', async () => {
    const { client } = await setup();
    const output = await client.callTool({
      name: 'postgrestRequest',
      arguments: {
        method: 'GET',
        path: '/no_such_table?select=*',
      },
    });

    expect(output.isError).toBe(true);

    const [firstContent] = output.content as any[];

    if (!firstContent) {
      throw new Error('no content');
    }

    expect(firstContent.text).toContain('PostgREST request failed');
    expect(firstContent.text).toContain('PGRST205');
  });

  test('sql-to-rest', async () => {
    const { client } = await setup();
    const output = await client.callTool({
      name: 'sqlToRest',
      arguments: {
        sql: 'SELECT * FROM todos ORDER BY id ASC',
      },
    });

    const [firstContent] = output.content as any[];

    if (!firstContent) {
      throw new Error('no content');
    }

    const result = JSON.parse(firstContent.text);

    expect(result).toMatchInlineSnapshot(`
      {
        "method": "GET",
        "path": "/todos?order=id.asc",
      }
    `);
  });
});
