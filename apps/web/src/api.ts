export type User = { id: string; email: string };
export type Controller = {
  active?: boolean;
  id: string;
  name: string;
  createdAt?: string | number;
};
export type Lease = {
  controllerId: string;
  epoch: number;
  pending?: boolean;
  expiresAt: string | number;
};
export type Instance = {
  id: string;
  name: string;
  online?: boolean;
  status?: string;
  lastSeenAt?: string | number | null;
  observedAt?: number;
  connectedAt?: number | null;
  disconnectedAt?: number | null;
  bootId?: string | null;
  connectionEpoch?: number;
  lease?: Lease | null;
};
export type Identity = { user: User; controller: Controller };
export type Command = { id: string; status: string; result?: unknown; error?: unknown };
export type RemoteEvent = {
  v: 1;
  type: 'event';
  seq: number;
  instanceId: string;
  kind: string;
  payload: unknown;
  createdAt: string | number;
};
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public detail?: unknown,
  ) {
    super(message);
  }
}
export class CommandError extends Error {
  constructor(
    message: string,
    public command: Command,
  ) {
    super(message);
  }
}
export class CommandAdmissionError extends ApiError {}
export const commandPending = (command: Command) =>
  ['pending', 'queued', 'accepted', 'running', 'sent', 'dispatched'].includes(command.status);
export function commandResult(command: Command): unknown {
  if (command.status === 'succeeded' && !command.error) return command.result;
  throw new CommandError(errorText(command.error ?? `命令未完成: ${command.status}`), command);
}
export const queryCommand = async (id: string, signal?: AbortSignal) =>
  unwrapCommand(await api<Command>(`/api/commands/${encodeURIComponent(id)}`, { signal }));
export const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const asList = (value: unknown, key: string): unknown[] =>
  Array.isArray(value)
    ? value
    : Array.isArray(asRecord(value)[key])
      ? (asRecord(value)[key] as unknown[])
      : [];
export const errorText = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : typeof asRecord(error).message === 'string'
        ? String(asRecord(error).message)
        : (JSON.stringify(error) ?? '未知错误');
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000),
    credentials: 'include',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok)
    throw new ApiError(
      errorText(asRecord(body).error ?? asRecord(body).message ?? `请求失败 (${res.status})`),
      res.status,
      body,
    );
  return body as T;
}
export const post = <T>(path: string, data: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(data) });
const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const end = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(end, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
export function unwrapCommand(body: unknown): Command {
  const record = asRecord(body);
  return (record.command ?? record) as Command;
}
export async function runCommand(
  instanceId: string,
  controllerId: string,
  action: string,
  args: Record<string, unknown> = {},
  leaseEpoch?: number,
  signal?: AbortSignal,
  id: string = crypto.randomUUID(),
  references: { repositoryId?: string; repositoryIds?: string[] } = {},
): Promise<unknown> {
  let command = unwrapCommand(
    await api<Command>(`/api/instances/${encodeURIComponent(instanceId)}/commands`, {
      method: 'POST',
      body: JSON.stringify({
        id,
        controllerId,
        action,
        args,
        ...(leaseEpoch !== undefined ? { leaseEpoch } : {}),
        ...references,
      }),
      signal,
    }).catch((error) => {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500)
        throw new CommandAdmissionError(error.message, error.status, error.detail);
      throw error;
    }),
  );
  const deadline = Date.now() + 90_000;
  while (commandPending(command)) {
    if (Date.now() > deadline)
      throw new Error(`命令仍在等待结果 (${id})。请检查实例连接，勿重复提交写入操作`);
    await delay(500, signal);
    command = await queryCommand(id, signal);
  }
  return commandResult(command);
}
export function leaseActive(lease: Lease | null | undefined, now = Date.now()) {
  return !!lease && !lease.pending && new Date(lease.expiresAt).getTime() > now;
}
export type InstanceStatus = 'connecting' | 'online' | 'stale' | 'offline';
export function instanceStatus(instance: Instance): InstanceStatus {
  // An explicit stale/offline snapshot always wins over legacy cached booleans.
  if (['connecting', 'online', 'stale', 'offline'].includes(instance.status ?? ''))
    return instance.status as InstanceStatus;
  return instance.online === true || instance.status === 'connected' ? 'online' : 'offline';
}
export const isOnline = (instance: Instance) => instanceStatus(instance) === 'online';
export const statusLabel = (instance: Instance) =>
  ({ connecting: '正在连接', online: '在线', stale: '状态过期', offline: '离线' })[
    instanceStatus(instance)
  ];
export const timeLabel = (value: string | number | null | undefined) =>
  value != null && Number.isFinite(new Date(value).getTime())
    ? new Date(value).toLocaleString('zh-CN', { hour12: false })
    : '尚未观测到';
