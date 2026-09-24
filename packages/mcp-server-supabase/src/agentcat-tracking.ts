import { track, type AgentCatOptions } from 'agentcat';

const contextDescription =
  'Describe the goal of this tool call in one sentence without including SQL, project references, user data, tokens, error messages, or tool output.';

type AgentCatEvent = Parameters<NonNullable<AgentCatOptions['redactEvent']>>[0];

export function redactAgentCatEvent(event: AgentCatEvent): AgentCatEvent {
  return {
    id: event.id,
    sessionId: event.sessionId,
    projectId: event.projectId,
    eventType: event.eventType,
    timestamp: event.timestamp,
    duration: event.duration,
    sdkLanguage: event.sdkLanguage,
    agentcatVersion: event.agentcatVersion,
    serverName: event.serverName,
    serverVersion: event.serverVersion,
    clientName: event.clientName,
    clientVersion: event.clientVersion,
    identifyActorGivenId: event.identifyActorGivenId,
    resourceName: event.resourceName,
    userIntent: event.userIntent,
    isError: event.isError,
  };
}

export function trackWithAgentCat<T>(
  server: T,
  otlpEndpoint: string,
  actorId: string,
  sessionId: string
): T {
  return track(server, null, {
    customContextDescription: contextDescription,
    disableDiagnostics: true,
    enableReportMissing: false,
    exporters: {
      otlp: {
        type: 'otlp',
        endpoint: otlpEndpoint,
      },
    },
    identify: async () => ({ userId: actorId }),
    resolveSessionId: async () => sessionId,
    redactEvent: redactAgentCatEvent,
  }) as T;
}
