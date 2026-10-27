import type { Implementation } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import { ToolCallerError } from '../errors.js';
import type { FeedbackOperations } from '../platform/types.js';
import { injectableTool, type ToolDefs } from './util.js';

type FeedbackToolsOptions = {
  feedback: FeedbackOperations;
  projectId?: string;
  clientInfo?: Implementation;
  readOnly?: boolean;
};

const submitFeedbackInputSchema = z.object({
  feedback: z.string().min(1).max(1000),
  project_id: z.string().optional(),
});

const submitFeedbackOutputSchema = z.object({
  delete_token: z.string(),
});

const deleteFeedbackInputSchema = z.object({
  delete_token: z.uuid(),
  project_id: z.string().optional(),
});

const deleteFeedbackOutputSchema = z.object({
  deleted: z.boolean(),
});

export const feedbackToolDefs = {
  submit_feedback: {
    description:
      "Sends feedback about Supabase tools to the Supabase team. Use it when the user asks, or when you hit a bug or missing capability. Ask the user before sending feedback they didn't request. Never include secrets, personal data, or database contents. Show the user the returned delete token.",
    parameters: submitFeedbackInputSchema,
    outputSchema: submitFeedbackOutputSchema,
    annotations: {
      title: 'Submit feedback',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  delete_feedback: {
    description:
      'Deletes feedback sent with submit_feedback. Pass the same project_id used to submit it.',
    parameters: deleteFeedbackInputSchema,
    outputSchema: deleteFeedbackOutputSchema,
    annotations: {
      title: 'Delete feedback',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
} as const satisfies ToolDefs;

export function getFeedbackTools({
  feedback,
  projectId,
  clientInfo,
  readOnly,
}: FeedbackToolsOptions) {
  const project_id = projectId;

  return {
    submit_feedback: injectableTool({
      ...feedbackToolDefs.submit_feedback,
      inject: { project_id },
      execute: async ({ feedback: message, project_id }) => {
        if (readOnly) {
          throw new ToolCallerError(
            'Cannot submit feedback in read-only mode.'
          );
        }

        const { deleteToken } = await feedback.submit({
          feedback: message,
          projectId: project_id,
          clientInfo,
        });
        return { delete_token: deleteToken };
      },
    }),
    delete_feedback: injectableTool({
      ...feedbackToolDefs.delete_feedback,
      inject: { project_id },
      execute: async ({ delete_token, project_id }) => {
        if (readOnly) {
          throw new ToolCallerError(
            'Cannot delete feedback in read-only mode.'
          );
        }

        return feedback.delete({
          deleteToken: delete_token,
          projectId: project_id,
        });
      },
    }),
  };
}
