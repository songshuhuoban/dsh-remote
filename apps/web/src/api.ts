/** `github` is the linked GitHub login, used for "Sign in with GitHub". */
export type User = { id: string; email: string; github?: string | null };
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
/** Chinese copy for relay error codes users can reach from the console. */
const ERROR_TEXT: Record<string, string> = {
  INVALID_CREDENTIALS: '邮箱或密码不正确',
  ACCOUNT_EXISTS: '该邮箱已注册，请直接登录',
  REGISTRATION_DISABLED: '此部署未开放注册，请联系管理员',
  INVITE_REQUIRED: '邀请码无效，请向管理员确认',
  GITHUB_INVITE_REQUIRED: '首次使用 GitHub 登录需要邀请码，填写后再试一次',
  GITHUB_CANCELLED: '已取消 GitHub 授权',
  GITHUB_INVALID_STATE: 'GitHub 授权已过期或不是从此浏览器发起，请重试',
  GITHUB_TOKEN_REJECTED: 'GitHub 授权未完成，请重试',
  GITHUB_UNAVAILABLE: '暂时无法连接 GitHub，请稍后再试',
  GITHUB_NOT_CONFIGURED: '此部署未启用 GitHub 登录',
  RATE_LIMITED: '尝试次数过多，请稍后再试',
  UNAUTHENTICATED: '登录已失效，请重新登录',
  INSTANCE_OFFLINE: 'DSH 实例当前离线',
  COMMAND_QUOTA: '待确认的命令过多，请稍后再试',
  TOO_LARGE: '请求内容过大',
};
export const errorText = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : (ERROR_TEXT[String(asRecord(error).code)] ??
        (typeof asRecord(error).message === 'string'
          ? String(asRecord(error).message)
          : (JSON.stringify(error) ?? '未知错误')));
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
