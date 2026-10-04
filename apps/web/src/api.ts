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
  lastSeenAt?: string | number;
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
      }),
      signal,
    }),
  );
  const deadline = Date.now() + 90_000;
  while (
    ['pending', 'queued', 'accepted', 'running', 'sent', 'dispatched'].includes(command.status)
  ) {
    if (Date.now() > deadline)
      throw new Error(`命令仍在等待结果 (${id})。请检查实例连接，勿重复提交写入操作`);
    await delay(500, signal);
    command = unwrapCommand(
      await api<Command>(`/api/commands/${encodeURIComponent(id)}`, { signal }),
    );
  }
  if (
    ['failed', 'error', 'cancelled', 'timeout', 'rejected', 'indeterminate'].includes(
      command.status,
    ) ||
    command.error
  )
    throw new Error(errorText(command.error ?? `命令未完成: ${command.status}`));
  if (command.status !== 'succeeded')
    throw new Error(`无法确认命令结果 (${id}): ${command.status}`);
  return command.result;
}
export function leaseActive(lease: Lease | null | undefined, now = Date.now()) {
  return !!lease && !lease.pending && new Date(lease.expiresAt).getTime() > now;
}
export const isOnline = (instance: Instance) =>
  instance.online === true || instance.status === 'online' || instance.status === 'connected';
