/** Owns one connector child process and bridges its private JSONL stdio to the DSH adapter. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { CAPABILITIES, DshAdapter, AdapterError, type AdapterPolicy } from './adapter.ts';
import type { DshHostContext } from './host.ts';
import {
  isWriteAction,
  MAX_FRAME_BYTES,
  type RelayCommand,
  type ConnectorResult,
} from '../../protocol/src/index.ts';

export interface ConnectorLaunch {
  relayUrl: string;
  connectorToken: string;
  journalPath: string;
  /** Executable and arguments that start the connector entry. */
  command: readonly [string, ...string[]];
}
export type ConnectorState =
  | 'connecting'
  | 'online'
  | 'offline'
  | 'credential_rejected'
  | 'unreachable'
  | 'stopped'
  | 'failed';
export interface ConnectorReport {
  state: ConnectorState;
  detail?: string;
  instanceId?: string;
  /** While waiting to reconnect: when the next attempt starts. */
  nextRetryAt?: number;
}

/** Ambient secrets and DSH-internal variables never reach the child. */
function childEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      !/KEY|PASSWORD|SECRET|TOKEN/i.test(key) &&
      !key.toUpperCase().startsWith('DSH_')
    )
      env[key] = value;
  // Desktop DSH runs the Host from the Electron binary; this selects its Node mode.
  env.ELECTRON_RUN_AS_NODE = '1';
  // Let Node's fetch/WebSocket honour the same proxy variables DSH itself uses.
  if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY)
    env.NODE_USE_ENV_PROXY = '1';
  return env;
}

export function startConnector(
  ctx: DshHostContext,
  policy: AdapterPolicy,
  launch: ConnectorLaunch,
  report: (value: ConnectorReport) => void,
): { stop(): Promise<void>; retry(): void } {
  const [executable, ...args] = launch.command;
  const child = spawn(executable, args, {
    env: childEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let closing = false,
    online = false,
    connectionEpoch = 0,
    lease: { epoch: number; expiresAt: number; controllerId: string | null } | null = null;
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const write = (value: unknown) => {
    if (!closing && child.stdin.writable) {
      const line = JSON.stringify(value) + '\n';
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES)
        throw new Error('DSH remote frame exceeds configured maximum');
      child.stdin.write(line);
    }
  };
  const adapter = new DshAdapter(ctx, (event) => write({ type: 'event', event }), policy);
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on('line', (line) => {
    try {
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error('Connector frame too large');
      const frame = JSON.parse(line);
      if (frame.type === 'connection') {
        online = frame.online === true;
        connectionEpoch = frame.connectionEpoch;
        lease = null;
        adapter.setAvailable(online);
        report(
          online
            ? { state: 'online', instanceId: frame.instanceId }
            : { state: 'offline', detail: 'Relay connection closed; reconnecting' },
        );
      } else if (frame.type === 'status') {
        if (!online && typeof frame.state === 'string')
          report({
            state: frame.state,
            detail: typeof frame.detail === 'string' ? frame.detail : undefined,
            nextRetryAt: Number.isSafeInteger(frame.nextRetryAt) ? frame.nextRetryAt : undefined,
          });
      } else if (frame.type === 'heartbeat') {
        if (online && frame.connectionEpoch === connectionEpoch && Number.isSafeInteger(frame.nonce))
          write({ type: 'heartbeat.ack', connectionEpoch, nonce: frame.nonce });
      } else if (frame.type === 'lease') {
        if (frame.connectionEpoch === connectionEpoch) {
          lease = {
            epoch: frame.epoch,
            expiresAt: frame.expiresAt,
            controllerId: frame.controllerId,
          };
          write({
            type: 'lease.ack',
            epoch: frame.epoch,
            expiresAt: frame.expiresAt,
            connectionEpoch,
          });
        }
      } else if (frame.type === 'command') {
        const command = frame.command as RelayCommand;
        const guard = () => {
          if (!online || command.connectionEpoch !== connectionEpoch)
            throw new AdapterError('stale_connection', 'Connector generation changed');
          if (command.expiresAt <= Date.now())
            throw new AdapterError('command_expired', 'Command expired before execution');
          if (
            isWriteAction(command.action) &&
            (!lease ||
              command.leaseEpoch !== lease.epoch ||
              lease.expiresAt <= Date.now() ||
              !lease.controllerId)
          )
            throw new AdapterError('stale_lease', 'Writer lease changed before execution');
        };
        const run = async () => {
          let result: ConnectorResult;
          try {
            guard();
            const value = await adapter.execute(command.action, command.args, guard);
            result = {
              v: 1,
              type: 'result',
              id: command.id,
              connectionEpoch: command.connectionEpoch,
              ok: true,
              result: value,
            };
          } catch (error) {
            const e = error as { code?: string; message?: string };
            result = {
              v: 1,
              type: 'result',
              id: command.id,
              connectionEpoch: command.connectionEpoch,
              ok: false,
              error: {
                code: typeof e?.code === 'string' ? e.code : 'host_error',
                message: typeof e?.message === 'string' ? e.message : 'DSH operation failed',
              },
            };
          }
          if (Buffer.byteLength(JSON.stringify(result)) > MAX_FRAME_BYTES - 256)
            result = {
              v: 1,
              type: 'result',
              id: command.id,
              connectionEpoch: command.connectionEpoch,
              ok: false,
              error: {
                code: 'response_too_large',
                message:
                  'DSH response exceeds transport limit; request a smaller session.page window',
              },
            };
          write({ type: 'result', result });
        };
        void run().catch(() => ctx.logger.error('dsh-remote response could not be delivered'));
      }
    } catch (error) {
      ctx.logger.error(
        `dsh-remote protocol: ${error instanceof Error ? error.message : 'Invalid frame'}`,
      );
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) =>
    ctx.logger.warn(String(chunk).replaceAll(launch.connectorToken, '[redacted]').trim()),
  );
  child.on('error', (error) => {
    adapter.setAvailable(false);
    ctx.logger.error(`dsh-remote connector could not start: ${error.message}`);
    report({ state: 'failed', detail: `Connector could not start: ${error.message}` });
    resolveExit();
  });
  child.on('exit', (code) => {
    online = false;
    adapter.setAvailable(false);
    if (!closing) report({ state: 'failed', detail: `Connector exited (code ${code ?? 'unknown'})` });
    resolveExit();
  });
  report({ state: 'connecting' });
  const initialize = () =>
    write({
      type: 'init',
      config: {
        relayUrl: launch.relayUrl,
        connectorToken: launch.connectorToken,
        journalPath: launch.journalPath,
        bootId: adapter.bootId,
        capabilities: CAPABILITIES,
      },
    });
  const ready = ctx.get('appReady') as { onReady(callback: () => void): () => void } | undefined;
  const removeReady = ready?.onReady(initialize);
  if (ready === undefined) initialize();
  return {
    retry() {
      write({ type: 'retry' });
    },
    async stop() {
      removeReady?.();
      adapter.dispose();
      write({ type: 'shutdown' });
      closing = true;
      reader.close();
      child.stdin.end();
      const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.kill('SIGTERM');
      await exited;
      clearTimeout(kill);
      report({ state: 'stopped' });
    },
  };
}
