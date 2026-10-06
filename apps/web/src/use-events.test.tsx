// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEvents } from './use-events';

/** Just enough of a browser WebSocket for the event stream; the test plays the relay. */
class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  onclose?: () => void;
  sent: string[] = [];
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
    // The relay answers every ping, so the stale-socket watchdog stays quiet.
    const frame = JSON.parse(data);
    if (frame.type === 'ping') this.frame({ v: 1, type: 'pong', id: frame.id });
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  /** The relay accepts the socket and says it is live. */
  accept() {
    this.readyState = 1;
    this.onopen?.();
    this.frame({ v: 1, type: 'ready' });
  }
  frame(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}
let visibility: DocumentVisibilityState = 'visible';
const setVisibility = (state: DocumentVisibilityState) => {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
};
beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  visibility = 'visible';
  vi.stubGlobal('WebSocket', Object.assign(FakeSocket, { OPEN: 1, CLOSED: 3 }));
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
/** Renders the hook in a console-like tree; `result.current` is its latest value. */
function mount() {
  const result = { current: undefined as unknown as ReturnType<typeof useEvents> };
  function Probe() {
    result.current = useEvents(true);
    return null;
  }
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Probe />
    </QueryClientProvider>,
  );
  return { result };
}

it('lets go of the stream after three hidden minutes and reconnects once shown', () => {
  const { result } = mount();
  act(() => FakeSocket.all[0]!.accept());
  expect(result.current.state).toBe('live');

  act(() => setVisibility('hidden'));
  act(() => vi.advanceTimersByTime(2 * 60_000));
  expect(FakeSocket.all[0]!.readyState).toBe(1);
  act(() => vi.advanceTimersByTime(60_000));
  expect(FakeSocket.all[0]!.readyState).toBe(3);
  expect(result.current.state).toBe('paused');

  // Neither time nor the network brings a hidden, paused tab back.
  act(() => {
    vi.advanceTimersByTime(30 * 60_000);
    window.dispatchEvent(new Event('online'));
  });
  expect(FakeSocket.all).toHaveLength(1);

  act(() => setVisibility('visible'));
  expect(FakeSocket.all).toHaveLength(2);
  act(() => FakeSocket.all[1]!.accept());
  expect(result.current.state).toBe('live');
});

it('a short look away keeps the stream', () => {
  mount();
  act(() => FakeSocket.all[0]!.accept());
  act(() => setVisibility('hidden'));
  act(() => vi.advanceTimersByTime(60_000));
  act(() => setVisibility('visible'));
  act(() => vi.advanceTimersByTime(10 * 60_000));
  expect(FakeSocket.all).toHaveLength(1);
  expect(FakeSocket.all[0]!.readyState).toBe(1);
});

it('builds the live reply from pushed stream frames', () => {
  const { result } = mount();
  const socket = FakeSocket.all[0]!;
  act(() => socket.accept());
  const push = (data: Record<string, unknown>) =>
    act(() =>
      socket.frame({ v: 1, type: 'stream', instanceId: 'i', payload: { sessionId: 's', data } }),
    );
  push({ type: 'start', attemptId: 'a' });
  push({ type: 'chunk', attemptId: 'a', index: 0, chunk: { type: 'text-delta', text: 'Hel' } });
  push({ type: 'chunk', attemptId: 'a', index: 1, chunk: { type: 'text-delta', text: 'lo' } });
  expect(result.current.streams['i:s']).toMatchObject({ text: 'Hello', incomplete: false });
  // Pushed frames are not stored events: nothing to replay, no sequence to advance.
  expect(result.current.events).toEqual([]);
  push({ type: 'end', attemptId: 'a' });
  expect(result.current.streams['i:s']).toBeUndefined();
});
