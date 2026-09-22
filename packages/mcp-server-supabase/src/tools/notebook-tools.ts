import { z } from 'zod/v4';
import type { NotebookOperations } from '../platform/types.js';
import {
  notebookSchema,
  notebookWithContentSchema,
} from '../platform/types.js';
import { injectableTool, type ToolDefs } from './util.js';

type NotebookToolsOptions = {
  notebooks: NotebookOperations;
  projectId?: string;
};

const listNotebooksInputSchema = z.object({
  project_id: z.string(),
});

const listNotebooksOutputSchema = z.object({
  notebooks: z.array(notebookSchema),
});

const getNotebookInputSchema = z.object({
  project_id: z.string(),
  notebook_id: z.string().describe('The id of the notebook to retrieve'),
});

const getNotebookOutputSchema = notebookWithContentSchema;

export const notebookToolDefs = {
  list_notebooks: {
    description:
      'Lists the notebooks in a Supabase project. Notebook bodies are omitted — use get_notebook to read a specific notebook.',
    parameters: listNotebooksInputSchema,
    outputSchema: listNotebooksOutputSchema,
    annotations: {
      title: 'List notebooks',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_notebook: {
    description:
      'Gets a notebook from a Supabase project, including its cells.',
    parameters: getNotebookInputSchema,
    outputSchema: getNotebookOutputSchema,
    annotations: {
      title: 'Get notebook',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
} as const satisfies ToolDefs;

export function getNotebookTools({
  notebooks,
  projectId,
}: NotebookToolsOptions) {
  const project_id = projectId;

  return {
    list_notebooks: injectableTool({
      ...notebookToolDefs.list_notebooks,
      inject: { project_id },
      execute: async ({ project_id }) => {
        return { notebooks: await notebooks.listNotebooks(project_id) };
      },
    }),
    get_notebook: injectableTool({
      ...notebookToolDefs.get_notebook,
      inject: { project_id },
      execute: async ({ project_id, notebook_id }) => {
        return await notebooks.getNotebook(project_id, notebook_id);
      },
    }),
  };
}
