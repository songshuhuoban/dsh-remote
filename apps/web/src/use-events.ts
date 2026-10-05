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
export function useEvents(enabled: boolean) {
  const client = useQueryClient();
  const [state, setState] = useState<'connecting' | 'live' | 'reconnecting' | 'offline'>(
    'connecting',
  );
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
      closed = false,
      attempts = 0;
    const connect = () => {
      if (closed) return;
      setState(attempts ? 'reconnecting' : 'connecting');
      const current = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/events?after=${last.current}`,
      );
      socket = current;
      current.onopen = () => {
        if (closed || socket !== current) return;
        attempts = 0;
        void client.invalidateQueries({ queryKey: ['instances'] });
        void client.invalidateQueries({ queryKey: ['remote'] });
      };
      current.onmessage = ({ data }) => {
        if (closed || socket !== current) return;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(data);
        } catch {
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
        // Read-command completion must not invalidate itself and form a request loop.
        if (
          !event.kind.startsWith('command.') &&
          (event.kind !== 'assistant.stream' || payload.type === 'end') &&
          !refresh
        )
          refresh = setTimeout(() => {
            refresh = undefined;
            void client.invalidateQueries({ queryKey: ['instances'] });
            void client.invalidateQueries({ queryKey: ['remote'] });
          }, 700);
      };
      current.onerror = () => current.close();
      current.onclose = () => {
        if (closed || socket !== current) return;
        setState(navigator.onLine ? 'reconnecting' : 'offline');
        setStreams({});
        reconnect = setTimeout(
          connect,
          Math.min(30_000, 1000 * 2 ** attempts++) + Math.random() * 400,
        );
      };
    };
    connect();
    const onOnline = () => {
      if (socket?.readyState !== WebSocket.OPEN) {
        clearTimeout(reconnect);
        socket?.close();
        connect();
      }
    };
    window.addEventListener('online', onOnline);
    return () => {
      closed = true;
      clearTimeout(reconnect);
      clearTimeout(refresh);
      socket?.close();
      window.removeEventListener('online', onOnline);
    };
  }, [enabled, client]);
  return { state, events, approvals, streams };
}
