/** Installed Cordis plugin: DSH remains on Node; owned outbound transport runs Bun. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isAbsolute, dirname } from 'node:path';
import { openSync, closeSync, fstatSync, statSync, readFileSync, constants } from 'node:fs';
import { CAPABILITIES, DshAdapter, AdapterError, json } from './adapter.ts';
import type { DshHostContext } from './host.ts';
import {
  isWriteAction,
  MAX_FRAME_BYTES,
  type RelayCommand,
  type ConnectorResult,
} from '../../protocol/src/index.ts';
export const name = 'dsh-remote';
export const inject = ['sessionController', 'agents', 'fileUploads'];
export interface PluginConfig {
  relayUrl: string;
  connectorTokenFile: string;
  connectorPath: string;
  journalPath: string;
  bunPath?: string;
  allowedWorkspaceRoots: string[];
  allowedPermissionPresets?: string[];
  allowedAgentPresets?: string[];
  approvalTimeoutMs?: number;
}
function validate(
  input: unknown,
): { value: PluginConfig } | { issues: Array<{ message: string }> } {
  if (!input || typeof input !== 'object')
    return { issues: [{ message: 'dsh-remote configuration is required' }] };
  const config = input as Record<string, unknown>;
  for (const key of ['relayUrl', 'connectorTokenFile', 'connectorPath', 'journalPath'])
    if (typeof config[key] !== 'string' || !(config[key] as string).trim())
      return { issues: [{ message: `${key} is required` }] };
  if (!isAbsolute(config.connectorTokenFile as string))
    return {
      issues: [{ message: 'connectorTokenFile must be an absolute private credential file' }],
    };
  if ('connectorToken' in config)
    return { issues: [{ message: 'Inline connectorToken is forbidden; use connectorTokenFile' }] };
  if (!isAbsolute(config.connectorPath as string) || !isAbsolute(config.journalPath as string))
    return { issues: [{ message: 'connectorPath and journalPath must be absolute' }] };
  if (
    !Array.isArray(config.allowedWorkspaceRoots) ||
    !config.allowedWorkspaceRoots.length ||
    config.allowedWorkspaceRoots.some((root) => typeof root !== 'string' || !isAbsolute(root))
  )
    return {
      issues: [
        { message: 'allowedWorkspaceRoots must contain explicit absolute workspace directories' },
      ],
    };
  return { value: config as unknown as PluginConfig };
}
/** Read credentials outside the inspectable Cordis configuration object. */
export function readConnectorToken(path: string): string {
  if (process.platform === 'win32')
    throw new Error(
      'Windows controlled instances require a Windows Credential Manager or verified ACL adapter; this build supports private credential files only on POSIX hosts',
    );
  let fd: number | undefined;
  try {
    const parent = statSync(dirname(path));
    if ((parent.mode & 0o077) !== 0 || (process.getuid && parent.uid !== process.getuid()))
      throw new Error('private');
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const file = fstatSync(fd);
    if (!file.isFile() || file.size < 32 || file.size > 4096) throw new Error('invalid');
    if ((file.mode & 0o077) !== 0 || (process.getuid && file.uid !== process.getuid()))
      throw new Error('private');
    const token = readFileSync(fd, 'utf8');
    if (!/^[A-Za-z0-9_-]{32,4096}$/.test(token)) throw new Error('invalid');
    return token;
  } catch {
    throw new Error(
      'Connector credential must be a valid owner-only file inside a private directory (0600 / 0700 on POSIX)',
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export const Config = { '~standard': { version: 1 as const, vendor: 'dsh-remote', validate } };
export function apply(ctx: DshHostContext, raw: PluginConfig): void {
  const checked = validate(raw);
  if ('issues' in checked) throw new Error(checked.issues.map((issue) => issue.message).join('; '));
  const config = checked.value;
  const connectorToken = readConnectorToken(config.connectorTokenFile);
  ctx.effect(() => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (
        value !== undefined &&
        !/KEY|PASSWORD|SECRET|TOKEN/i.test(key) &&
        !key.toUpperCase().startsWith('DSH_')
      )
        env[key] = value;
    const child = spawn(config.bunPath ?? 'bun', ['run', config.connectorPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
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
    const adapter = new DshAdapter(ctx, (event) => write({ type: 'event', event }), config);
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
      ctx.logger.warn(String(chunk).replaceAll(connectorToken, '[redacted]').trim()),
    );
    child.on('error', (error) => {
      adapter.setAvailable(false);
      ctx.logger.error(`dsh-remote Bun child could not start: ${error.message}`);
      resolveExit();
    });
    child.on('exit', () => {
      online = false;
      adapter.setAvailable(false);
      resolveExit();
    });
    const initialize = () =>
      write({
        type: 'init',
        config: {
          relayUrl: config.relayUrl,
          connectorToken,
          journalPath: config.journalPath,
          bootId: adapter.bootId,
          capabilities: CAPABILITIES,
        },
      });
    const ready = ctx.get('appReady') as { onReady(callback: () => void): () => void } | undefined;
    const removeReady = ready?.onReady(initialize);
    if (ready === undefined) initialize();
    return async () => {
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
    };
  }, 'dsh-remote: Bun connector lifecycle');
}
