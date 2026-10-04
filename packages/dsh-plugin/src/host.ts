/** Narrow structural views of the pinned DSH 0.2.1-alpha.1 public services.
 * These preserve the real Host method names and avoid bundling a second Cordis.
 * Source references and behavior limits are in docs/upstream-capabilities.md.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface SessionEvent {
  type: string;
  seq: number;
  time: number;
  data: Json;
  [key: string]: unknown;
}
export interface Session {
  id: string;
  header: Record<string, unknown>;
  snapshotEvents(): SessionEvent[];
}
export interface Agent {
  id: string;
  session: Session;
  status: 'idle' | 'running';
}
export interface ApprovalRequest {
  agent: Agent;
  toolName: string;
  callId?: string;
  reason?: string;
  signal?: AbortSignal;
}
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
export interface DshHostContext {
  sessionController: {
    list(request: Record<string, never>, signal: AbortSignal): Promise<unknown>;
    create(request: Record<string, unknown>): Promise<unknown>;
    inspect(
      id: string,
      signal?: AbortSignal,
    ): Promise<{
      meta: Record<string, unknown>;
      events: SessionEvent[];
      inheritedEventCount: number;
    }>;
    projections(request: { sessionId: string }, signal: AbortSignal): Promise<unknown>;
    page(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
    prompt(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
    cancel(request: { sessionId: string }): unknown;
    updateQueue(request: Record<string, unknown>): Promise<unknown>;
    selectModel(request: Record<string, unknown>): Promise<unknown>;
    attachment(request: { sessionId: string; attachmentId: string }): Promise<unknown>;
    modelCatalog(): Promise<unknown>;
    resolveAgent(
      id: string,
    ): Promise<{ agent: Agent; error?: never } | { error: Error; agent?: never }>;
  };
  agents: { get(id: string): Agent | undefined };
  fileUploads: {
    upload(
      agent: Agent,
      request: { data: string; name?: string },
      signal: AbortSignal,
    ): Promise<unknown>;
  };
  commands?: {
    execute(
      agent: Agent,
      line: string,
      attachments: readonly never[],
      signal: AbortSignal,
    ): Promise<unknown>;
  };
  permissionPresets?: { catalog(): unknown };
  agentPresets?: { list(): unknown; select(agent: Agent, preset: string): Promise<string> };
  settingsController?: { describe(): unknown };
  get(name: string): unknown;
  on(
    event: string,
    listener: (...args: any[]) => unknown,
    options?: { global?: boolean; prepend?: boolean },
  ): () => void;
  effect(effect: () => () => void | Promise<void>, label?: string): unknown;
  logger: { warn(message: string): void; error(message: string): void };
}
