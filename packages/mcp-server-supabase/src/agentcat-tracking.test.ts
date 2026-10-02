import { describe, expect, test } from 'vitest';

import { redactAgentCatEvent } from './agentcat-tracking.js';

describe('redactAgentCatEvent', () => {
  test('removes payloads and identifying metadata', () => {
    const event = redactAgentCatEvent({
      id: 'evt_test',
      sessionId: 'ses_test',
      eventType: 'tool_call',
      timestamp: new Date(0),
      resourceName: 'execute_sql',
      userIntent: 'Inspect database performance',
      parameters: { query: 'select secret from private_table' },
      response: { secret: 'sensitive' },
      error: { message: 'sensitive error' },
      ipAddress: '192.0.2.1',
      identifyActorGivenId: 'hashed-actor',
      identifyActorName: 'Sensitive Name',
      identifyActorData: { email: 'person@example.com' },
      identifyData: { private: true },
    });

    expect(event).toMatchObject({
      resourceName: 'execute_sql',
      userIntent: 'Inspect database performance',
      identifyActorGivenId: 'hashed-actor',
    });
    expect(event.parameters).toBeUndefined();
    expect(event.response).toBeUndefined();
    expect(event.error).toBeUndefined();
    expect(event.ipAddress).toBeUndefined();
    expect(event.identifyActorName).toBeUndefined();
    expect(event.identifyActorData).toBeUndefined();
    expect(event.identifyData).toBeUndefined();
  });
});
