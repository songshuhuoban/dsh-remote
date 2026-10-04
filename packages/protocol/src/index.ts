/** Versioned relay protocol. The server derives tenant identity from credentials. */
export const PROTOCOL_VERSION = 1 as const;
export const READ_ACTIONS = [
  'session.list',
  'session.read',
  'session.page',
  'session.projections',
  'settings.describe',
  'attachment.read',
  'capabilities',
] as const;
export const WRITE_ACTIONS = [
  'session.create',
  'session.prompt',
  'session.cancel',
  'session.resume',
  'session.queue.update',
  'model.select',
  'attachment.upload',
  'approval.respond',
  'settings.update',
] as const;
export const ACTIONS = [...READ_ACTIONS, ...WRITE_ACTIONS] as const;
export type Action = (typeof ACTIONS)[number];
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type CommandStatus = 'queued' | 'dispatched' | 'succeeded' | 'failed' | 'indeterminate';
export interface Controller {
  active?: boolean;
  id: string;
  name: string;
  createdAt: number;
}
export interface Lease {
  pending?: boolean;
  controllerId: string;
  epoch: number;
  expiresAt: number;
}
export interface Instance {
  id: string;
  name: string;
  online: boolean;
  bootId: string | null;
  connectionEpoch: number;
  lease: Lease | null;
  createdAt: number;
  capabilities: string[];
}
export interface CommandInput {
  id: string;
  controllerId: string;
  leaseEpoch?: number;
  action: Action;
  args: Record<string, Json>;
}
export interface Command {
  id: string;
  instanceId: string;
  controllerId: string;
  action: Action;
  status: CommandStatus;
  result: Json | null;
  error: { code: string; message: string } | null;
  createdAt: number;
  updatedAt: number;
}
export interface RelayCommand {
  v: 1;
  type: 'command';
  id: string;
  instanceId: string;
  connectionEpoch: number;
  leaseEpoch: number | null;
  action: Action;
  args: Record<string, Json>;
  expiresAt: number;
}
export interface ConnectorHello {
  v: 1;
  type: 'hello';
  bootId: string;
  capabilities: string[];
}
export interface ConnectorResult {
  v: 1;
  type: 'result';
  id: string;
  connectionEpoch: number;
  ok: boolean;
  result?: Json;
  error?: { code: string; message: string };
}
export interface ConnectorEvent {
  v: 1;
  type: 'event';
  id: string;
  sessionId?: string;
  kind: string;
  payload: Json;
}
export interface RelayEvent {
  v: 1;
  type: 'event';
  seq: number;
  instanceId: string;
  kind: string;
  payload: Json;
  createdAt: number;
}
export const isAction = (value: unknown): value is Action =>
  typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
export const isWriteAction = (value: Action): boolean =>
  (WRITE_ACTIONS as readonly string[]).includes(value);
/** Event names a DSH connector may emit. Gateway lifecycle/status names are reserved. */
export const CONNECTOR_EVENT_KINDS = [
  'session.event',
  'session.status',
  'assistant.stream',
  'session.added',
  'session.removed',
  'approval.requested',
  'approval.settled',
] as const;
