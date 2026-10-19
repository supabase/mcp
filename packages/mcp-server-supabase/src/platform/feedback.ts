import packageJson from '../../package.json' with { type: 'json' };
import type { FeedbackOperations } from './types.js';

// Publishable keys copied from the CLI client:
// https://github.com/supabase/cli/blob/104f1fb14d2e856828292b54c95eda8b8125c07a/apps/cli/src/shared/feedback/feedback-client.layer.ts#L22-L30
const FEEDBACK_ENVIRONMENTS = {
  production: {
    url: 'https://xguihxuzqibwxjnimxev.supabase.co',
    key: 'sb_publishable__4DBgvrDe7ec234wnvCAog_LPzBtkQe',
  },
  staging: {
    url: 'https://actixlblmrqglneypada.supabase.co',
    key: 'sb_publishable_wLdx7w89KWFq-39s4emmnA__9XR9r-_',
  },
};

const REQUEST_TIMEOUT_MS = 10_000;

export type FeedbackOperationsOptions = {
  environment?: keyof typeof FEEDBACK_ENVIRONMENTS;
  fetch?: typeof globalThis.fetch;
  /** Failures send feedback without a user. */
  getUserId?: () => Promise<string | undefined>;
};

export function createFeedbackOperations({
  environment = 'production',
  fetch = globalThis.fetch,
  getUserId,
}: FeedbackOperationsOptions = {}): FeedbackOperations {
  const { url, key } = FEEDBACK_ENVIRONMENTS[environment];

  async function resolveUserId() {
    try {
      return await getUserId?.();
    } catch {
      return undefined;
    }
  }

  async function request(path: string, init: RequestInit, action: string) {
    const response = await fetch(`${url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: key,
        'Content-Type': 'application/json',
        ...init.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `Failed to ${action}: ${response.status} ${await response.text()}`
      );
    }
    return response;
  }

  return {
    async submit({ feedback, projectId, clientInfo }) {
      const userId = await resolveUserId();
      const response = await request(
        'rpc/submit_interfaces_feedback',
        {
          method: 'POST',
          body: JSON.stringify({
            feedback,
            user_agent: `supabase-mcp/${packageJson.version}`,
            user_id: userId,
            project_ref: projectId,
            metadata: {
              source: 'mcp',
              ...(clientInfo && {
                client_name: clientInfo.name,
                client_version: clientInfo.version,
              }),
            },
          }),
        },
        'submit feedback'
      );
      const deleteToken: unknown = await response.json();
      if (typeof deleteToken !== 'string' || deleteToken.length === 0) {
        throw new Error('Failed to submit feedback: no delete token returned');
      }
      return { deleteToken };
    },
    async delete({ deleteToken, projectId }) {
      const userId = await resolveUserId();
      const response = await request(
        `interfaces_feedback?delete_token=eq.${encodeURIComponent(deleteToken)}`,
        {
          method: 'DELETE',
          headers: {
            Prefer: 'count=exact',
            'x-feedback-token': deleteToken,
            ...(projectId && { 'x-feedback-project-ref': projectId }),
            ...(userId && { 'x-feedback-user-id': userId }),
          },
        },
        'delete feedback'
      );
      // Content-Range is `*/<deleted row count>`
      const deletedCount = response.headers.get('Content-Range')?.split('/')[1];
      return { deleted: deletedCount === '1' };
    },
  };
}
