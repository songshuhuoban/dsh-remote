/**
 * Installed Cordis plugin. DSH remains on its own Node runtime; the relay transport runs as a
 * private child process. Pairing and status are managed from DSH's Plugins page.
 */
import { isAbsolute, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openSync, closeSync, fstatSync, statSync, readFileSync, existsSync, constants } from 'node:fs';
import z from '@deepseek-ai/schemastery';
import type { AdapterPolicy } from './adapter.ts';
import type { DshHostContext } from './host.ts';
import { startConnector, type ConnectorLaunch, type ConnectorReport } from './connector-process.ts';
import { exchangePairing, PairingError } from './pairing.ts';
import {
  loadSettings,
  saveSettings,
  validateSettings,
  SETTINGS_FIELDS,
  type RemoteSettings,
} from './settings-store.ts';

export const name = 'dsh-remote';
export const inject = ['sessionController', 'agents', 'fileUploads'];

export interface PluginConfig {
  /**
   * Optional profile-level policy for headless setups. When set, it overrides (and locks) the
   * values edited on the Plugins page, which live in the plugin's settings file.
   */
  allowedWorkspaceRoots?: string[];
  allowedPermissionPresets?: string[];
  allowedAgentPresets?: string[];
  approvalTimeoutMs?: number;
  /** Manual mode (profile YAML/env): set together with connectorTokenFile instead of pairing. */
  relayUrl?: string;
  connectorTokenFile?: string;
  journalPath?: string;
  /** Development only: run the connector source with Bun instead of the bundled build. */
  connectorPath?: string;
  bunPath?: string;
}
export const Config = z.object({
  allowedWorkspaceRoots: z.array(z.string()),
  allowedPermissionPresets: z.array(z.string()),
  allowedAgentPresets: z.array(z.string()),
  approvalTimeoutMs: z.natural().default(600_000),
  relayUrl: z.string(),
  connectorTokenFile: z.string(),
  journalPath: z.string(),
  connectorPath: z.string(),
  bunPath: z.string(),
});

/** Manual-mode rules the schema cannot express. Pairing mode needs none of these fields. */
export function manualConfigIssues(input: Record<string, unknown>): string[] {
  const issues: string[] = [];
  if ('connectorToken' in input)
    issues.push('Inline connectorToken is forbidden; pair from the Plugins page or use connectorTokenFile');
  if (input.relayUrl !== undefined || input.connectorTokenFile !== undefined) {
    if (typeof input.relayUrl !== 'string' || !input.relayUrl.trim())
      issues.push('relayUrl is required with connectorTokenFile');
    if (typeof input.connectorTokenFile !== 'string' || !isAbsolute(input.connectorTokenFile))
      issues.push('connectorTokenFile must be an absolute private credential file');
  }
  for (const key of ['journalPath', 'connectorPath'] as const)
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !isAbsolute(input[key] as string)))
      issues.push(`${key} must be absolute`);
  return issues;
}

/** Read a manual-mode credential outside the inspectable Cordis configuration object. */
export function readConnectorToken(path: string): string {
  if (process.platform === 'win32')
    throw new Error(
      'Token files are POSIX-only; on Windows pair from the DSH Plugins page, which stores the credential in DSH credentials',
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

/** Pairing record in DSH credentials: never in profile YAML, never sent to the browser. */
const PAIRING_KEY = 'dsh-remote/connector';
interface PairingPayload {
  relayUrl: string;
  connectorToken: string;
  instance: { id: string; name: string };
  pairedAt: number;
}
interface CredentialsService {
  readRecord(key: string): Promise<{ kind: string; payload?: unknown } | undefined>;
  modifyRecord(
    key: string,
    mutate: (current: unknown) => Promise<{ kind: 'grant'; payload: unknown } | undefined>,
  ): Promise<unknown>;
  deleteRecord(key: string): Promise<void>;
}
interface ConnectionService {
  fetch: {
    register(route: {
      path: string;
      methods: readonly ('GET' | 'POST')[];
      requestBody: 'buffered';
      fetch: (request: Request) => Promise<Response>;
    }): () => Promise<void>;
  };
}
interface PluginContext extends DshHostContext {
  inject(names: string[], callback: (child: PluginContext) => void): unknown;
  connection?: ConnectionService;
  dshHomePath?: (...segments: string[]) => string;
}
function pairingPayload(value: unknown): PairingPayload | undefined {
  const record = value as { kind?: unknown; payload?: Partial<PairingPayload> } | undefined;
  const payload = record?.kind === 'grant' ? record.payload : undefined;
  return payload &&
    typeof payload.relayUrl === 'string' &&
    typeof payload.connectorToken === 'string' &&
    typeof payload.instance?.id === 'string' &&
    typeof payload.instance.name === 'string'
    ? (payload as PairingPayload)
    : undefined;
}

export type RemoteState =
  | 'unpaired'
  | 'starting'
  | ConnectorReport['state'];
export interface RemoteStatus {
  mode: 'paired' | 'manual' | 'unpaired';
  state: RemoteState;
  relayUrl?: string;
  instance?: { id: string; name: string };
  detail?: string;
  since: number;
  onlineSince?: number;
  /** While reconnecting: when the connector tries again. */
  nextRetryAt?: number;
  workspaceRoots: Array<{ path: string; available: boolean }>;
  settings: RemoteSettings;
  /** Fields set in the profile YAML; the Plugins page shows them read-only. */
  lockedByProfile: Array<keyof RemoteSettings>;
  /** Pairing and policy changes are accepted only from a browser on this machine. */
  localControl: boolean;
}

const LOOPBACK = /^(localhost|\[::1\]|127(\.\d{1,3}){3})$/;
const requestIsLocal = (request: Request) => {
  try {
    return LOOPBACK.test(new URL(`http://${request.headers.get('host') ?? ''}`).hostname);
  } catch {
    return false;
  }
};
export function apply(ctx: PluginContext, config: PluginConfig): void {
  const issues = manualConfigIssues(config as unknown as Record<string, unknown>);
  if (issues.length) throw new Error(issues.join('; '));
  const manual = typeof config.relayUrl === 'string' && !!config.relayUrl;
  const dataDir =
    ctx.dshHomePath?.('dsh-remote') ??
    join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-remote');
  const settingsPath = join(dataDir, 'settings.json');
  let settings = loadSettings(settingsPath, (message) => ctx.logger.warn(message));
  // The schema resolves unset lists to []; only a non-empty profile list overrides the page.
  const lockedByProfile = SETTINGS_FIELDS.filter((field) => !!config[field]?.length);
  const pick = (field: keyof RemoteSettings) =>
    lockedByProfile.includes(field) ? config[field]! : settings[field];
  const effective = (): RemoteSettings => ({
    allowedWorkspaceRoots: pick('allowedWorkspaceRoots'),
    allowedPermissionPresets: pick('allowedPermissionPresets'),
    allowedAgentPresets: pick('allowedAgentPresets'),
  });
  // Getters: every permission check sees the latest saved policy without a reconnect.
  const policy: AdapterPolicy = {
    get allowedWorkspaceRoots() {
      return effective().allowedWorkspaceRoots;
    },
    get allowedPermissionPresets() {
      return effective().allowedPermissionPresets;
    },
    get allowedAgentPresets() {
      return effective().allowedAgentPresets;
    },
    approvalTimeoutMs: config.approvalTimeoutMs,
  };
  const bundled = fileURLToPath(new URL('./connector.js', import.meta.url));
  const command = (): ConnectorLaunch['command'] =>
    config.connectorPath
      ? [config.bunPath ?? 'bun', 'run', config.connectorPath]
      : [process.execPath, bundled];
  const credentials = () => ctx.get('credentials') as CredentialsService | undefined;

  let status: Omit<RemoteStatus, 'workspaceRoots' | 'settings' | 'lockedByProfile' | 'localControl'> = {
    mode: manual ? 'manual' : 'unpaired',
    state: manual ? 'starting' : 'unpaired',
    since: Date.now(),
  };
  const update = (next: Partial<typeof status>) => {
    const changed = next.state !== undefined && next.state !== status.state;
    status = { ...status, ...next, ...(changed ? { since: Date.now() } : {}) };
    if (next.state === 'online' && changed) status.onlineSince = Date.now();
    if (next.state && next.state !== 'online') delete status.onlineSince;
    if (next.state && !('nextRetryAt' in next)) delete status.nextRetryAt;
  };
  const view = (request: Request): RemoteStatus => {
    const current = effective();
    return {
      ...status,
      workspaceRoots: current.allowedWorkspaceRoots.map((path) => ({
        path,
        available: isAbsolute(path) && existsSync(path),
      })),
      settings: current,
      lockedByProfile,
      localControl: requestIsLocal(request),
    };
  };

  let running: { stop(): Promise<void>; retry(): void } | undefined;
  let generation = 0;
  let queue: Promise<unknown> = Promise.resolve();
  /** Serialized: stop any running connector, then start from the current configuration. */
  const restart = () => {
    const task = queue.then(async () => {
      const mine = ++generation;
      await running?.stop();
      running = undefined;
      let launch: ConnectorLaunch | undefined;
      if (manual) {
        try {
          launch = {
            relayUrl: config.relayUrl!,
            connectorToken: readConnectorToken(config.connectorTokenFile!),
            journalPath: config.journalPath ?? join(dataDir, 'journal-manual.sqlite'),
            command: command(),
          };
          update({ mode: 'manual', relayUrl: config.relayUrl });
        } catch (error) {
          update({ state: 'failed', detail: (error as Error).message });
          return;
        }
      } else {
        const store = credentials();
        const pairing = store ? pairingPayload(await store.readRecord(PAIRING_KEY)) : undefined;
        if (!pairing) {
          update({ mode: 'unpaired', state: 'unpaired', relayUrl: undefined, instance: undefined, detail: undefined });
          return;
        }
        update({ mode: 'paired', relayUrl: pairing.relayUrl, instance: pairing.instance });
        launch = {
          relayUrl: pairing.relayUrl,
          connectorToken: pairing.connectorToken,
          journalPath: join(dataDir, `journal-${pairing.instance.id}.sqlite`),
          command: command(),
        };
      }
      running = startConnector(ctx, policy, launch, (report) => {
        if (mine !== generation) return;
        update({ state: report.state, detail: report.detail, nextRetryAt: report.nextRetryAt });
      });
    });
    queue = task.catch((error) => {
      ctx.logger.error(`dsh-remote: ${error instanceof Error ? error.message : String(error)}`);
      update({ state: 'failed', detail: 'Connector restart failed; see DSH logs' });
    });
    return queue;
  };

  ctx.effect(() => {
    void restart();
    return async () => {
      generation++;
      await queue;
      await running?.stop();
      running = undefined;
    };
  }, 'dsh-remote: connector lifecycle');

  const error = (status: number, code: string, message: string) =>
    Response.json({ error: { code, message } }, { status, headers: { 'cache-control': 'no-store' } });
  const ok = (request: Request) =>
    Response.json(view(request), { headers: { 'cache-control': 'no-store' } });
  ctx.inject(['connection'], (child) => {
    const routes: Array<[string, 'GET' | 'POST', (request: Request) => Promise<Response>]> = [
      ['/api/dsh-remote/status', 'GET', async (request) => ok(request)],
      [
        '/api/dsh-remote/reconnect',
        'POST',
        async (request) => {
          // A running connector just skips its backoff; otherwise start it from scratch.
          if (running && status.state !== 'failed' && status.state !== 'stopped') running.retry();
          else await restart();
          return ok(request);
        },
      ],
      [
        '/api/dsh-remote/pair',
        'POST',
        async (request) => {
          if (!requestIsLocal(request))
            return error(403, 'local_only', 'Pair from a browser on the DSH computer');
          if (manual)
            return error(409, 'manual_mode', 'This profile configures relayUrl and a token file manually');
          const store = credentials();
          if (!store) return error(503, 'credentials_unavailable', 'DSH credentials are unavailable');
          const body = (await request.json().catch(() => null)) as { link?: unknown } | null;
          if (typeof body?.link !== 'string' || body.link.length > 2000)
            return error(400, 'invalid_link', 'Paste the pairing link shown by the relay');
          try {
            const result = await exchangePairing(body.link);
            const payload: PairingPayload = { ...result, pairedAt: Date.now() };
            await store.modifyRecord(PAIRING_KEY, async () => ({ kind: 'grant', payload }));
          } catch (failure) {
            if (failure instanceof PairingError)
              return error(failure.code === 'unreachable' ? 502 : 400, failure.code, failure.message);
            throw failure;
          }
          await restart();
          return ok(request);
        },
      ],
      [
        '/api/dsh-remote/settings',
        'POST',
        async (request) => {
          if (!requestIsLocal(request))
            return error(403, 'local_only', 'Change remote access from a browser on the DSH computer');
          const checked = validateSettings(await request.json().catch(() => null));
          if ('error' in checked) return error(400, 'invalid_settings', checked.error);
          if (Object.keys(checked.value).some((field) => lockedByProfile.includes(field as keyof RemoteSettings)))
            return error(409, 'locked_by_profile', 'This setting is fixed in the DSH profile configuration');
          const next = { ...settings, ...checked.value };
          saveSettings(settingsPath, next);
          settings = next;
          return ok(request);
        },
      ],
      [
        '/api/dsh-remote/unpair',
        'POST',
        async (request) => {
          if (!requestIsLocal(request))
            return error(403, 'local_only', 'Unpair from a browser on the DSH computer');
          if (manual)
            return error(409, 'manual_mode', 'This profile configures relayUrl and a token file manually');
          await credentials()?.deleteRecord(PAIRING_KEY);
          await restart();
          return ok(request);
        },
      ],
    ];
    for (const [path, method, handler] of routes)
      child.effect(() => {
        const dispose = child.connection!.fetch.register({
          path,
          methods: [method],
          requestBody: 'buffered',
          fetch: (request) =>
            handler(request).catch((failure) => {
              ctx.logger.error(`dsh-remote ${path}: ${failure instanceof Error ? failure.message : String(failure)}`);
              return error(500, 'internal', 'DSH Remote could not complete the request');
            }),
        });
        return () => void dispose();
      });
  });
}
