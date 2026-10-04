import { asList, asRecord, type RemoteEvent } from './api';
export type SessionSummary = {
  sessionId: string;
  updatedAt?: number;
  running?: boolean;
  blank?: boolean;
  agentAvailable?: boolean;
  cwd?: string;
  projections?: unknown;
};
export type WireEvent = {
  type: string;
  seq: number;
  time?: number;
  data: unknown;
  surfaceOp?: string;
};
export function sessionsFrom(value: unknown): SessionSummary[] {
  return asList(value, 'items').filter(
    (v) => typeof asRecord(v).sessionId === 'string',
  ) as SessionSummary[];
}
export function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value
      .map((block) => {
        const b = asRecord(block);
        if (b.type === 'text') return String(b.text ?? '');
        if (b.type === 'image') return `[图片${b.name ? `：${b.name}` : ''}]`;
        if (b.type === 'file') return `[附件${b.name ? `：${b.name}` : ''}]`;
        if (b.type === 'tool-call' || b.type === 'tool_use')
          return `[工具：${b.toolName ?? b.name ?? '调用'}]`;
        if (b.type === 'reasoning') return String(b.text ?? '');
        return '';
      })
      .filter(Boolean)
      .join('\n');
  return '';
}
export function historyEvents(value: unknown): WireEvent[] {
  return asList(value, 'events').filter((v) => typeof asRecord(v).type === 'string') as WireEvent[];
}
export function mergeEvents(
  history: WireEvent[],
  live: RemoteEvent[],
  sessionId: string,
): WireEvent[] {
  const map = new Map(history.map((event) => [event.seq, event]));
  for (const outer of live) {
    const payload = asRecord(outer.payload);
    if (payload.sessionId !== sessionId) continue;
    const candidate = asRecord(payload.data);
    if (typeof candidate.seq === 'number' && typeof candidate.type === 'string')
      map.set(candidate.seq, candidate as unknown as WireEvent);
  }
  return [...map.values()].sort((a, b) => a.seq - b.seq);
}
export function eventMessage(event: WireEvent): { role: string; text: string } | null {
  const data = asRecord(event.data);
  if (event.type === 'user/message') {
    const source = asRecord(data.source).kind;
    return {
      role: source && source !== 'user' ? '运行时上下文' : '你',
      text: contentText(data.content),
    };
  }
  if (event.type === 'assistant/message')
    return { role: 'DSH', text: contentText(asRecord(data.message).content) };
  if (event.type === 'tool/result')
    return { role: '工具结果', text: contentText(data.content) || JSON.stringify(data, null, 2) };
  return null;
}
export function sessionLabel(session: SessionSummary): string {
  const values = asRecord(asRecord(session.projections).values),
    title = values.title ?? values.sessionTitle;
  return (
    (typeof title === 'string'
      ? title
      : typeof asRecord(title).title === 'string'
        ? String(asRecord(title).title)
        : null) ??
    session.cwd?.split(/[\\/]/).filter(Boolean).at(-1) ??
    session.sessionId.slice(0, 16)
  );
}
/** A call ID only has meaning within the already-selected session's durable events. */
export function toolCallForApproval(
  approval: unknown,
  events: WireEvent[],
): { callId: string; name: string; arguments: string } | null {
  const request = asRecord(approval);
  if (typeof request.callId !== 'string' || !request.callId) return null;
  const match = events.find(
    (event) =>
      event.type === 'tool/call' &&
      asRecord(event.data).callId === request.callId &&
      asRecord(event.data).name === request.toolName,
  );
  const call = asRecord(match?.data);
  return typeof call.arguments === 'string'
    ? { callId: request.callId, name: String(call.name), arguments: call.arguments }
    : null;
}
