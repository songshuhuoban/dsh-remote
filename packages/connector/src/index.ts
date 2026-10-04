/** Bun transport subprocess. Private JSONL stdio to the trusted DSH Host shim. */
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
  instanceId = '';
let lease: { epoch: number; expiresAt: number; controllerId: string | null } | null = null;
const pending = new Set<string>();
let heartbeatNonce = 0;
const heartbeatTimer = setInterval(() => {
  if (welcomed && !stopped)
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
function connect(): void {
  if (stopped || !config) return;
  const BunClientWebSocket = globalThis.WebSocket as typeof WebSocket & {
    new (url: string, options: Bun.WebSocketOptions): WebSocket;
  };
  const current = new BunClientWebSocket(config.relayUrl, {
    headers: { Authorization: `Bearer ${config.connectorToken}` },
  });
  socket = current;
  current.addEventListener('open', () => {
    if (current !== socket) return;
    send({ v: 1, type: 'hello', bootId: config!.bootId, capabilities: config!.capabilities });
  });
  current.addEventListener('message', (event) => {
    if (current !== socket) return;
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
    if (current !== socket) return;
    welcomed = false;
    lease = null;
    output({ type: 'connection', online: false, connectionEpoch });
    if (!stopped) {
      const delay = Math.min(15000, 250 * 2 ** Math.min(attempt++, 6));
      retry = setTimeout(connect, delay + Math.floor(Math.random() * 250));
    }
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
