import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { asRecord, type Instance, type RemoteEvent } from './api';
export type PendingApproval = Record<string, unknown> & {
  instanceId: string;
  sessionId: string;
  approvalId: string;
};
export type LiveStream = {
  attemptId: string;
  text: string;
  lastIndex: number;
  incomplete: boolean;
};
/** A silent socket for this long is treated as half-open and replaced. */
const STALE_MS = 65_000;
const PING_MS = 15_000;
export interface StreamHealth {
  /** Consecutive failed attempts since the last live stream. */
  attempt: number;
  /** When the next automatic attempt starts, while reconnecting. */
  nextRetryAt?: number;
  /** Last measured round trip to the relay, while live. */
  latencyMs?: number;
}
export function useEvents(enabled: boolean) {
  const client = useQueryClient();
  const [state, setState] = useState<'connecting' | 'live' | 'reconnecting' | 'offline'>(
    'connecting',
  );
  const [health, setHealth] = useState<StreamHealth>({ attempt: 0 });
  const retryNow = useRef<() => void>(() => {});
  const [events, setEvents] = useState<RemoteEvent[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [streams, setStreams] = useState<Record<string, LiveStream>>({});
  const last = useRef(0);
  useEffect(() => {
    if (!enabled) {
      last.current = 0;
      setEvents([]);
      setApprovals([]);
      setStreams({});
      setState('offline');
      return;
    }
    let socket: WebSocket | undefined,
      reconnect: ReturnType<typeof setTimeout>,
      refresh: ReturnType<typeof setTimeout> | undefined,
      pendingRemote = false,
      closed = false,
      attempts = 0,
      lastFrameAt = 0,
      pingId = 0;
    const pings = new Map<number, number>();
    const connect = () => {
      if (closed) return;
      clearTimeout(reconnect);
      setState(attempts ? 'reconnecting' : 'connecting');
      setHealth({ attempt: attempts });
      const current = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/events?after=${last.current}`,
      );
      socket = current;
      current.onopen = () => {
        if (closed || socket !== current) return;
        attempts = 0;
        lastFrameAt = Date.now();
        void client.invalidateQueries({ queryKey: ['instances'] });
        void client.invalidateQueries({ queryKey: ['remote'] });
      };
      current.onmessage = ({ data }) => {
        if (closed || socket !== current) return;
        lastFrameAt = Date.now();
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(data);
        } catch {
          return;
        }
        if (frame.type === 'keepalive') return;
        if (frame.type === 'pong') {
          const sentAt = pings.get(Number(frame.id));
          pings.delete(Number(frame.id));
          if (sentAt !== undefined)
            setHealth({ attempt: 0, latencyMs: Math.round(performance.now() - sentAt) });
          return;
        }
        if (frame.type === 'snapshot') {
          setApprovals(
            Array.isArray(frame.pendingApprovals)
              ? (frame.pendingApprovals as PendingApproval[])
              : [],
          );
          if (Array.isArray(frame.instances))
            client.setQueryData(['instances'], { instances: frame.instances as Instance[] });
          return;
        }
        if (frame.type === 'ready') {
          setState('live');
          setHealth({ attempt: 0 });
          ping();
          return;
        }
        if (frame.type === 'reset') {
          last.current = typeof frame.cursor === 'number' ? frame.cursor : 0;
          setEvents([]);
          setStreams({});
          setApprovals([]);
          void client.invalidateQueries({ queryKey: ['remote'] });
          return;
        }
        if (frame.type !== 'event' || typeof frame.seq !== 'number') return;
        const event = frame as unknown as RemoteEvent;
        if (event.seq <= last.current) return;
        last.current = event.seq;
        setEvents((previous) => [...previous, event].slice(-250));
        const envelope = asRecord(event.payload),
          payload = asRecord(envelope.data);
        if (event.kind === 'approval.requested' && typeof payload.approvalId === 'string')
          setApprovals((old) => [
            ...old.filter((a) => a.approvalId !== payload.approvalId),
            { ...payload, instanceId: event.instanceId } as PendingApproval,
          ]);
        if (event.kind === 'approval.settled')
          setApprovals((old) => old.filter((a) => a.approvalId !== payload.approvalId));
        // A new Host boot invalidates earlier approval handles; the relay drops them without a settle event.
        if (event.kind === 'instance.online' && typeof envelope.bootId === 'string')
          setApprovals((old) =>
            old.filter((a) => a.instanceId !== event.instanceId || a.bootId === envelope.bootId),
          );
        if (event.kind === 'instance.offline') setStreams({});
        if (event.kind === 'assistant.stream' && typeof envelope.sessionId === 'string') {
          const key = `${event.instanceId}:${envelope.sessionId}`,
            attemptId = String(payload.attemptId);
          setStreams((old) => {
            if (payload.type === 'end') {
              const next = { ...old };
              delete next[key];
              return next;
            }
            if (payload.type === 'start')
              return { ...old, [key]: { attemptId, text: '', lastIndex: -1, incomplete: false } };
            if (payload.type !== 'chunk' || typeof payload.index !== 'number') return old;
            const previous =
              old[key]?.attemptId === attemptId
                ? old[key]
                : { attemptId, text: '', lastIndex: -1, incomplete: true };
            if (payload.index <= previous.lastIndex) return old;
            const chunk = asRecord(payload.chunk),
              addition =
                chunk.type === 'text-delta' && typeof chunk.text === 'string' ? chunk.text : '';
            const text = previous.text + addition;
            return {
              ...old,
              [key]: {
                attemptId,
                text: text.slice(-1_000_000),
                lastIndex: payload.index,
                incomplete:
                  previous.incomplete ||
                  payload.index !== previous.lastIndex + 1 ||
                  text.length > 1_000_000,
              },
            };
          });
        }
        // What an event invalidates. Command completions never do: a read would refresh itself
        // forever. Lease and status changes are relay state (the instance list); only events
        // from the host's sessions refresh host data, which costs a relayed command per query.
        // Lease renewals arrive every few seconds, so they must not re-read the host.
        if (
          !event.kind.startsWith('command.') &&
          (event.kind !== 'assistant.stream' || payload.type === 'end')
        ) {
          const relayOnly =
            event.kind.startsWith('lease.') ||
            event.kind === 'instance.status' ||
            event.kind === 'instance.paired';
          pendingRemote ||= !relayOnly;
          refresh ??= setTimeout(() => {
            refresh = undefined;
            void client.invalidateQueries({ queryKey: ['instances'] });
            if (pendingRemote) void client.invalidateQueries({ queryKey: ['remote'] });
            pendingRemote = false;
          }, 700);
        }
      };
      current.onerror = () => current.close();
      current.onclose = () => {
        if (closed || socket !== current) return;
        pings.clear();
        setState(navigator.onLine ? 'reconnecting' : 'offline');
        setStreams({});
        // Exponential backoff with jitter, capped at 30 s; network and focus events skip the wait.
        const delay = Math.min(30_000, 1000 * 2 ** attempts++) + Math.random() * 400;
        setHealth({ attempt: attempts, nextRetryAt: Date.now() + delay });
        reconnect = setTimeout(connect, delay);
      };
    };
    const ping = () => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      pings.set(++pingId, performance.now());
      socket.send(JSON.stringify({ v: 1, type: 'ping', id: pingId }));
    };
    /** Skips the backoff wait: used for network recovery, tab focus and the manual retry. */
    const resume = () => {
      if (closed || socket?.readyState === WebSocket.OPEN) return;
      attempts = Math.min(attempts, 1);
      const previous = socket;
      socket = undefined;
      previous?.close();
      connect();
    };
    retryNow.current = resume;
    const watchdog = setInterval(() => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      // A half-open socket never closes by itself; replace it after a silent period.
      if (Date.now() - lastFrameAt > STALE_MS) socket.close();
      else ping();
    }, PING_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') resume();
    };
    connect();
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      closed = true;
      clearTimeout(reconnect);
      clearTimeout(refresh);
      clearInterval(watchdog);
      socket?.close();
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, client]);
  return { state, events, approvals, streams, health, retry: () => retryNow.current() };
}
