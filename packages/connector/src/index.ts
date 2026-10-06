/** Transport subprocess (Node or Bun). Private JSONL stdio to the trusted DSH Host shim. */
import { createInterface } from 'node:readline';
import { Journal } from './journal.ts';
import {
  isAction,
  isWriteAction,
  MAX_FRAME_BYTES,
  type ConnectorEvent,
  type ConnectorResult,
  type RelayCommand,
} from '../../protocol/src/index.ts';
interface Config {
  relayUrl: string;
  connectorToken: string;
  journalPath: string;
  bootId: string;
  capabilities: string[];
}
let config: Config | undefined, journal: Journal | undefined, socket: WebSocket | undefined;
let stopped = false,
  welcomed = false,
  retry: ReturnType<typeof setTimeout> | undefined,
  attempt = 0,
  connectionEpoch = 0,
  instanceId = '',
  lastRelayFrameAt = 0;
/** No relay frame for this long while welcomed means a half-open socket (sleep, NAT, proxy). */
const SILENT_MS = 45_000;
const CONNECT_TIMEOUT_MS = 15_000;
let lease: { epoch: number; expiresAt: number; controllerId: string | null } | null = null;
const pending = new Set<string>();
let heartbeatNonce = 0;
const heartbeatTimer = setInterval(() => {
  if (!welcomed || stopped) return;
  if (Date.now() - lastRelayFrameAt > SILENT_MS) {
    diagnostic('relay went silent; reconnecting');
    socket?.close(4000, 'relay silent');
    return;
  }
  output({ type: 'heartbeat', connectionEpoch, nonce: ++heartbeatNonce });
}, 10_000);
heartbeatTimer.unref();
function output(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}
function diagnostic(message: string): void {
  process.stderr.write(`dsh-remote connector: ${message}\n`);
}
function send(value: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}
function failure(command: RelayCommand, code: string, message: string): ConnectorResult {
  return {
    v: 1,
    type: 'result',
    id: command.id,
    connectionEpoch: command.connectionEpoch,
    ok: false,
    error: { code, message },
  };
}
function checkUrl(raw: string): void {
  const url = new URL(raw);
  if (
    !['ws:', 'wss:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('relayUrl must be a clean WebSocket endpoint');
  if (url.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('Non-loopback relay requires wss://');
}
/** After a failed attempt, tell the Host why: a rejected credential is not worth fast retries. */
async function diagnose(): Promise<{ state: string; detail: string; delay?: number }> {
  const url = new URL(config!.relayUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/api/connector/me';
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${config!.connectorToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401)
      return {
        state: 'credential_rejected',
        detail: 'The relay rejected this credential; pair again from the relay console',
        delay: 60_000,
      };
    return { state: 'offline', detail: `Relay answered HTTP ${response.status}; reconnecting` };
  } catch {
    return { state: 'unreachable', detail: `Cannot reach ${url.host}; reconnecting` };
  }
}
function connect(): void {
  if (stopped || !config) return;
  output({ type: 'status', state: 'connecting' });
  // Node (undici) and Bun both accept request headers in the WebSocket options.
  const HeaderWebSocket = globalThis.WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => WebSocket;
  const current = new HeaderWebSocket(config.relayUrl, {
    headers: { Authorization: `Bearer ${config.connectorToken}` },
  });
  socket = current;
  // A handshake that never completes (unreachable host, captive network) must not stall retries.
  const handshake = setTimeout(() => {
    if (current === socket && current.readyState !== WebSocket.OPEN) current.close();
  }, CONNECT_TIMEOUT_MS);
  current.addEventListener('open', () => {
    clearTimeout(handshake);
    if (current !== socket) return;
    lastRelayFrameAt = Date.now();
    send({ v: 1, type: 'hello', bootId: config!.bootId, capabilities: config!.capabilities });
  });
  current.addEventListener('message', (event) => {
    if (current !== socket) return;
    lastRelayFrameAt = Date.now();
    try {
      const raw = typeof event.data === 'string' ? event.data : '';
      if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) throw new Error('Relay frame too large');
      const frame = JSON.parse(raw);
      if (frame.v !== 1) throw new Error('Unsupported protocol version');
      if (frame.type === 'welcome') {
        if (typeof frame.instanceId !== 'string' || !Number.isSafeInteger(frame.connectionEpoch))
          throw new Error('Invalid relay welcome');
        journal!.bindInstance(frame.instanceId);
        instanceId = frame.instanceId;
        connectionEpoch = frame.connectionEpoch;
        welcomed = true;
        attempt = 0;
        lease = null;
        output({ type: 'connection', online: true, connectionEpoch, instanceId });
        output({ type: 'heartbeat', connectionEpoch, nonce: ++heartbeatNonce });
        for (const event of journal!.events()) send(event);
        for (const result of journal!.results()) send({ ...result, connectionEpoch });
      } else if (frame.type === 'result.ack') {
        journal!.acknowledgeResult(frame.id);
      } else if (frame.type === 'event.ack') {
        journal!.acknowledgeEvent(frame.id);
      } else if (frame.type === 'lease') {
        if (!Number.isSafeInteger(frame.epoch) || typeof frame.expiresAt !== 'number')
          throw new Error('Invalid relay lease');
        if (lease && frame.epoch < lease.epoch) return;
        lease = {
          epoch: frame.epoch,
          expiresAt: frame.expiresAt,
          controllerId: frame.controllerId ?? null,
        };
        output({ type: 'lease', ...lease, connectionEpoch });
      } else if (frame.type === 'command') {
        const command = frame as RelayCommand;
        if (
          !welcomed ||
          command.instanceId !== instanceId ||
          command.connectionEpoch !== connectionEpoch
        ) {
          send(failure(command, 'stale_connection', 'Command belongs to a stale relay connection'));
          return;
        }
        if (
          typeof command.id !== 'string' ||
          !isAction(command.action) ||
          !command.args ||
          Array.isArray(command.args) ||
          typeof command.expiresAt !== 'number'
        ) {
          send(failure(command, 'invalid_command', 'Invalid command envelope'));
          return;
        }
        if (command.expiresAt <= Date.now()) {
          send(failure(command, 'command_expired', 'Command expired before dispatch'));
          return;
        }
        if (
          isWriteAction(command.action) &&
          (!lease ||
            lease.expiresAt <= Date.now() ||
            command.leaseEpoch !== lease.epoch ||
            lease.controllerId === null)
        ) {
          send(failure(command, 'stale_lease', 'Current writer lease is required'));
          return;
        }
        if (pending.has(command.id)) return;
        const found = journal!.reserve(command);
        if (found.kind === 'result') {
          send({ ...found.result, connectionEpoch });
          return;
        }
        if (found.kind === 'indeterminate') {
          send(
            failure(
              command,
              'indeterminate',
              'A previous delivery may have executed; inspect the DSH session before retrying with a new command',
            ),
          );
          return;
        }
        if (found.kind === 'conflict') {
          send(
            failure(
              command,
              'idempotency_conflict',
              'Command id was already used with different arguments',
            ),
          );
          return;
        }
        pending.add(command.id);
        output({ type: 'command', command });
      }
    } catch (error) {
      diagnostic(error instanceof Error ? error.message : 'Invalid relay frame');
      current.close(1008, 'protocol error');
    }
  });
  current.addEventListener('error', () => {});
  current.addEventListener('close', () => {
    clearTimeout(handshake);
    if (current !== socket) return;
    const wasWelcomed = welcomed;
    welcomed = false;
    lease = null;
    output({ type: 'connection', online: false, connectionEpoch });
    if (stopped) return;
    // Exponential backoff with jitter, capped at 15 s; the Host can skip the wait with "retry".
    const backoff = Math.min(15000, 250 * 2 ** Math.min(attempt++, 6));
    const schedule = (state: string, detail: string, base: number) => {
      const delay = base + Math.floor(Math.random() * 250);
      output({ type: 'status', state, detail, nextRetryAt: Date.now() + delay, attempt });
      retry = setTimeout(connect, delay);
    };
    if (wasWelcomed) {
      schedule('offline', 'Relay connection closed; reconnecting', backoff);
      return;
    }
    void diagnose().then((found) => {
      if (stopped || current !== socket) return;
      schedule(found.state, found.detail, found.delay ?? backoff);
    });
  });
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  try {
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error('Host frame too large');
    const frame = JSON.parse(line);
    if (frame.type === 'init') {
      if (config) throw new Error('Duplicate connector initialization');
      config = frame.config as Config;
      checkUrl(config.relayUrl);
      if (!config.connectorToken || !config.journalPath)
        throw new Error('Missing connector configuration');
      journal = new Journal(config.journalPath);
      connect();
    } else if (frame.type === 'heartbeat.ack') {
      if (welcomed && frame.connectionEpoch === connectionEpoch && frame.nonce === heartbeatNonce)
        send({ v: 1, type: 'ping', connectionEpoch });
    } else if (frame.type === 'lease.ack') {
      if (
        welcomed &&
        frame.connectionEpoch === connectionEpoch &&
        lease &&
        frame.epoch === lease.epoch &&
        frame.expiresAt === lease.expiresAt
      )
        send({ v: 1, ...frame });
    } else if (frame.type === 'result') {
      const result = frame.result as ConnectorResult;
      if (!pending.delete(result.id)) return;
      journal!.complete(result);
      if (welcomed) send({ ...result, connectionEpoch });
    } else if (frame.type === 'event') {
      const event = { v: 1, type: 'event', ...frame.event } as ConnectorEvent;
      journal?.event(event);
      if (welcomed) send(event);
    } else if (frame.type === 'retry') {
      // Skip the backoff wait, e.g. when the user asks to reconnect now.
      if (stopped || welcomed || !config) return;
      if (retry) clearTimeout(retry);
      attempt = 0;
      const previous = socket;
      socket = undefined;
      previous?.close();
      connect();
    } else if (frame.type === 'shutdown') {
      shutdown();
    }
  } catch (error) {
    diagnostic(error instanceof Error ? error.message : 'Invalid host frame');
    shutdown(1);
  }
});
function shutdown(code = 0): void {
  if (stopped) return;
  stopped = true;
  clearInterval(heartbeatTimer);
  if (retry) clearTimeout(retry);
  socket?.close();
  input.close();
  journal?.close();
  process.exitCode = code;
  setTimeout(() => process.exit(code), 50).unref();
}
input.on('close', () => shutdown());
process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
