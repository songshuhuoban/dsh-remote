import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useNavigate,
} from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowRight,
  Clipboard,
  FileText,
  Globe2,
  KeyRound,
  Layers3,
  MessageSquare,
  Monitor,
  Radio,
  Shield,
  ShieldCheck,
  Terminal,
  Trash2,
  Zap,
} from 'lucide-react';
import {
  Settings2,
  Menu,
  Plus,
  X,
  RefreshCw,
  Check,
  Send,
  Paperclip,
  Square,
  Pencil,
  ChevronDown,
} from './icons';
import {
  api,
  ApiError,
  asList,
  asRecord,
  errorText,
  isOnline,
  instanceStatus,
  statusLabel,
  timeLabel,
  leaseActive,
  post,
  runCommand,
  type Controller,
  type Identity,
  type Instance,
  type Lease,
  type RemoteEvent,
} from './api';
import {
  contentText,
  eventMessage,
  historyEvents,
  mergeEvents,
  sessionLabel,
  sessionsFrom,
  toolCallForApproval,
  type SessionSummary,
} from './session';
import { useEvents, type PendingApproval, type LiveStream } from './use-events';
import { Modal, Spinner, Err, Empty } from './ui';
import { ModelSettings } from './model-settings';
import { RepositoryPanel } from './repository-panel';
import { getReferences, contextPreview, repositoryIdsForPrompt } from './repositories';
import { readDraft, saveDraft } from './drafts';
import { OperationsProvider, RecoveryPanel, useOperations } from './operations';
import { PairInstance, PairingLanding, PairingPanel, requestPairing, type Pairing } from './pairing';
import './styles.css';
const THEME_KEY = 'dsh.appearance';
const NEW_INSTANCE = '__new_instance__';
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status === 401) && count < 1,
      staleTime: 5000,
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false },
  },
});
const rootRoute = createRootRoute({ component: App });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (s: Record<string, unknown>) => ({
    instance: typeof s.instance === 'string' ? s.instance : undefined,
    session: typeof s.session === 'string' ? s.session : undefined,
  }),
});
const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]) });
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
const Brand = () => (
  <div className="brand" aria-label="DeepSeek Harness Remote">
    <span className="brand-wordmark">
      <span>deepseek</span>
      <span>harness</span>
    </span>
    <small className="brand-remote">remote</small>
  </div>
);
function App() {
  if (location.pathname.startsWith('/pair/')) return <PairingLanding />;
  return <SignedInApp />;
}
function SignedInApp() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Identity>('/api/me'), retry: false });
  if (me.isPending)
    return (
      <main className="boot" aria-label="正在连接">
        <Spinner />
      </main>
    );
  if (!me.data)
    return (
      <Auth error={me.error instanceof ApiError && me.error.status === 401 ? null : me.error} />
    );
  return (
    <OperationsProvider key={me.data.user.id} accountId={me.data.user.id}>
      <Console identity={me.data} />
    </OperationsProvider>
  );
}
function Auth({ error }: { error: unknown }) {
  const client = useQueryClient(),
    [register, setRegister] = useState(false),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [deviceName, setDeviceName] = useState('Web 控制台'),
    [inviteCode, setInviteCode] = useState(''),
    [authNotice, setAuthNotice] = useState('');
  // Older relays omit the mode; they behave as open registration.
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api<{ registration?: 'open' | 'invite' | 'closed' }>('/health'),
    staleTime: 60_000,
  });
  const registration = health.data?.registration ?? 'open';
  const authAttempt = useRef(0),
    authAbort = useRef<AbortController | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      const generation = ++authAttempt.current;
      authAbort.current = new AbortController();
      setAuthNotice('');
      const data = await api<Identity>(`/api/auth/${register ? 'register' : 'login'}`, {
        method: 'POST',
        body: JSON.stringify({
          email,
          password,
          deviceName,
          ...(register && registration === 'invite' ? { inviteCode } : {}),
        }),
        signal: authAbort.current.signal,
      });
      return { data, generation };
    },
    onSuccess: ({ data, generation }) => {
      if (generation !== authAttempt.current) return;
      sessionStorage.setItem('dsh.controller', data.controller.id);
      client.setQueryData(['me'], { user: data.user, controller: data.controller });
    },
  });
  return (
    <main className="auth-page">
      <form
        className="auth-form"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <Brand />
        <h1 key={register ? 'register' : 'login'} className="swap">
          {register ? '创建账户' : '登录'}
        </h1>
        <label>
          邮箱
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </label>
        <label>
          密码
          <input
            type="password"
            minLength={8}
            autoComplete={register ? 'new-password' : 'current-password'}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={register ? '至少 8 个字符' : ''}
          />
        </label>
        <label>
          设备名称
          <input
            required
            maxLength={80}
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            autoComplete="off"
          />
        </label>
        {register && registration === 'invite' && (
          <label className="swap">
            邀请码
            <input
              required
              maxLength={200}
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              autoComplete="off"
            />
          </label>
        )}
        <Err error={mutation.error || error} />
        <div className="actions">
          <button className="primary" disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner /> : null}
            {register ? '创建账户' : '登录'}
          </button>
          {mutation.isPending ? (
            <button
              className="text-button"
              type="button"
              onClick={() => {
                authAttempt.current += 1;
                authAbort.current?.abort();
                setAuthNotice('已停止等待。登录或注册可能已在服务端完成');
              }}
            >
              停止等待
            </button>
          ) : registration !== 'closed' || register ? (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setRegister(!register);
                mutation.reset();
              }}
            >
              {register ? '已有账户，登录' : '创建账户'}
            </button>
          ) : null}
        </div>
        {authNotice && (
          <div className="notice swap" role="status">
            {authNotice}
            <button
              type="button"
              className="text-button"
              onClick={() => void client.invalidateQueries({ queryKey: ['me'] })}
            >
              查询登录状态
            </button>
          </div>
        )}
      </form>
    </main>
  );
}
function Console({ identity }: { identity: Identity }) {
  const client = useQueryClient(),
    navigate = useNavigate({ from: '/' }),
    search = indexRoute.useSearch(),
    [mobileMenu, setMobileMenu] = useState(false),
    [modal, setModal] = useState<
      | 'instance'
      | 'devices'
      | 'session'
      | 'takeover'
      | 'rotate'
      | 'status'
      | 'settings'
      | 'pair'
      | null
    >(null),
    [notice, setNotice] = useState(''),
    [clock, setClock] = useState(Date.now()),
    [tab, setTab] = useState<'conversation' | 'repositories'>('conversation'),
    [writeSuspended, setWriteSuspended] = useState(false),
    [theme, setTheme] = useState<'system' | 'light' | 'dark'>(() => {
      try {
        const saved = localStorage.getItem(THEME_KEY);
        return saved === 'light' || saved === 'dark' ? saved : 'system';
      } catch {
        return 'system';
      }
    });
  const operations = useOperations(),
    hadLive = useRef(false);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const apply = () =>
      document.body.toggleAttribute(
        'data-ds-dark-theme',
        theme === 'dark' || (theme === 'system' && !!media?.matches),
      );
    apply();
    try {
      // Only an explicit per-device appearance choice is stored; nothing account-related.
      if (theme === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Storage may be unavailable; the choice then lasts for this page only.
    }
    media?.addEventListener('change', apply);
    return () => media?.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {
    const result = new URLSearchParams(location.search).get('github');
    if (!result) return;
    setTab('repositories');
    setNotice(
      result === 'connected'
        ? 'GitHub 已连接，请刷新并选择可访问的仓库'
        : result === 'cancelled'
          ? 'GitHub 授权已取消，可以重试或使用手动映射'
          : 'GitHub 授权未完成，请检查连接状态后重试',
    );
    sessionStorage.removeItem('dsh.githubFlow');
    void navigate({
      search: { instance: search.instance, session: search.session },
      replace: true,
    });
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileMenu(false);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);
  useEffect(() => {
    if (!mobileMenu) return;
    const trigger = document.activeElement as HTMLElement | null;
    const drawer = document.querySelector<HTMLElement>('.sidebar');
    drawer?.querySelector<HTMLElement>('[aria-label="关闭导航"]')?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !drawer) return;
      const controls = [
        ...drawer.querySelectorAll<HTMLElement>(
          'button:not(:disabled),select:not(:disabled),a[href],input:not(:disabled)',
        ),
      ].filter((el) => el.getClientRects().length);
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', trap);
    return () => {
      window.removeEventListener('keydown', trap);
      if (!document.querySelector('dialog[open]')) trigger?.focus();
    };
  }, [mobileMenu]);
  const instances = useQuery({
    queryKey: ['instances'],
    queryFn: () => api<{ instances: Instance[] }>('/api/instances'),
    refetchInterval: 10000,
  });
  const controllers = useQuery({
    queryKey: ['controllers'],
    queryFn: () => api<{ controllers: Controller[] }>('/api/controllers'),
  });
  const eventStream = useEvents(true);
  const instance =
    instances.data?.instances.find((i) => i.id === search.instance) ??
    (!search.instance ? instances.data?.instances[0] : undefined);
  const id = instance?.id,
    online = !!instance && isOnline(instance),
    lease = instance?.lease,
    holding =
      online &&
      eventStream.state === 'live' &&
      !writeSuspended &&
      leaseActive(lease, clock) &&
      lease?.controllerId === identity.controller.id,
    occupied = leaseActive(lease, clock) && lease?.controllerId !== identity.controller.id;
  useEffect(() => {
    if (eventStream.state === 'live') hadLive.current = true;
    else if (hadLive.current) setWriteSuspended(true);
    if (instance && instanceStatus(instance) !== 'online') setWriteSuspended(true);
  }, [eventStream.state, instance?.status, instance?.online]);
  const controllerName = (controllerId?: string) =>
    controllers.data?.controllers.find((c) => c.id === controllerId)?.name ??
    controllerId?.slice(0, 12) ??
    '未知设备';
  const sessions = useQuery({
    queryKey: ['remote', id, 'sessions'],
    queryFn: ({ signal }) =>
      runCommand(id!, identity.controller.id, 'session.list', {}, undefined, signal).then(
        sessionsFrom,
      ),
    enabled: !!id && online,
    refetchInterval: 15000,
  });
  const selectedInstance = useRef(id),
    leaseRequestTarget = useRef(id);
  selectedInstance.current = id;
  const selected = sessions.data?.find((s) => s.sessionId === search.session);
  const sessionId = search.session;
  const events = eventStream.events.filter((e) => e.instanceId === id);
  const switchInstance = (value: string) => {
    void navigate({ search: { instance: value, session: undefined } });
    setMobileMenu(false);
    setNotice('');
    setModal(null);
    setWriteSuspended(false);
  };
  const selectSession = (value: string) => {
    void navigate({ search: { instance: id, session: value } });
    setMobileMenu(false);
    setTab('conversation');
  };
  const leaseMutation = useMutation({
    mutationFn: async ({
      takeover = false,
      release = false,
    }: {
      takeover?: boolean;
      release?: boolean;
    }) => {
      const target = id;
      if (!target) throw new Error('请先选择实例');
      leaseRequestTarget.current = target;
      if (release)
        await api(`/api/instances/${target}/lease`, {
          method: 'DELETE',
          body: JSON.stringify({ controllerId: identity.controller.id }),
        });
      else
        await post<Lease>(`/api/instances/${target}/lease`, {
          controllerId: identity.controller.id,
          takeover,
        });
      return target;
    },
    onSuccess: (target) => {
      void client.invalidateQueries({ queryKey: ['instances'] });
      if (selectedInstance.current !== target) return;
      setWriteSuspended(false);
      setModal((current) => (current === 'takeover' ? null : current));
      setNotice('');
    },
    onError: (error) => {
      if (selectedInstance.current === leaseRequestTarget.current) setNotice(errorText(error));
      void client.invalidateQueries({ queryKey: ['instances'] });
    },
  });
  const logout = useMutation({
    mutationFn: () => post('/api/auth/logout', {}),
    onSuccess: () => {
      sessionStorage.removeItem('dsh.controller');
      client.setQueryData(['me'], null);
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' });
    },
  });
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!holding || !id) return;
    let running = false;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible' || running) return;
      running = true;
      post<Lease>(`/api/instances/${id}/lease`, { controllerId: identity.controller.id })
        .then(() => client.invalidateQueries({ queryKey: ['instances'] }))
        .catch((error) => {
          setNotice(`控制权续期失败：${errorText(error)}`);
          void client.invalidateQueries({ queryKey: ['instances'] });
        })
        .finally(() => {
          running = false;
        });
    }, 10000);
    return () => clearInterval(timer);
  }, [holding, id, identity.controller.id, client]);
  const streamLive = eventStream.state === 'live',
    latencyMs = eventStream.health.latencyMs,
    retryIn = eventStream.health.nextRetryAt
      ? Math.max(0, Math.ceil((eventStream.health.nextRetryAt - clock) / 1000))
      : 0,
    statusText = !instance
      ? ''
      : streamLive
        ? `${statusLabel(instance)}${latencyMs !== undefined && online ? ` · ${latencyMs} ms` : ''}`
        : eventStream.state === 'offline'
          ? '网络离线'
          : retryIn
            ? `重连中 · ${retryIn}s`
            : '重连中',
    statusKey = streamLive && instance ? instanceStatus(instance) : eventStream.state,
    controlState: 'pending' | 'held' | 'occupied' | 'acquire' = leaseMutation.isPending
      ? 'pending'
      : holding
        ? 'held'
        : occupied
          ? 'occupied'
          : lease?.pending && lease.controllerId === identity.controller.id
            ? 'pending'
            : 'acquire';
  // Session resumption: after a brief drop, renew the lease this device still holds instead of
  // asking the user to take control again. Another device's takeover is never overridden.
  const resumedLease = useRef('');
  useEffect(() => {
    if (!writeSuspended || !streamLive || !online || !id || leaseMutation.isPending) return;
    if (lease?.controllerId !== identity.controller.id || !leaseActive(lease, Date.now())) return;
    const key = `${id}:${lease.epoch}`;
    if (resumedLease.current === key) return;
    resumedLease.current = key;
    leaseMutation.mutate({}, { onSuccess: () => setNotice('连接已恢复') });
  }, [writeSuspended, streamLive, online, id, lease?.controllerId, lease?.epoch, lease?.expiresAt]);
  const leaseHolder = leaseActive(lease, clock) ? lease?.controllerId : undefined,
    previousHolder = useRef({ id, holder: leaseHolder });
  useEffect(() => {
    const before = previousHolder.current;
    previousHolder.current = { id, holder: leaseHolder };
    // A device that logged in after this list loaded would otherwise show only as a raw ID.
    if (leaseHolder && !controllers.data?.controllers.some((c) => c.id === leaseHolder))
      void controllers.refetch();
    if (
      before.id === id &&
      before.holder === identity.controller.id &&
      leaseHolder &&
      leaseHolder !== identity.controller.id
    )
      setNotice('控制权已被其他设备接管，当前为只读模式');
  }, [id, leaseHolder]);
  return (
    <div className="shell" data-stream={eventStream.state}>
      <aside className={`sidebar ${mobileMenu ? 'open' : ''}`}>
        <div className="sidebar-brand">
          <Brand />
          <button
            className="icon-button mobile-only"
            onClick={() => setMobileMenu(false)}
            aria-label="关闭导航"
          >
            <X size={18} />
          </button>
        </div>
        <label className="instance-picker">
          <span className={`status-dot ${instance ? instanceStatus(instance) : ''}`} />
          <select
            aria-label="选择实例"
            value={id ?? ''}
            onChange={(e) =>
              e.target.value === NEW_INSTANCE ? setModal('instance') : switchInstance(e.target.value)
            }
          >
            <option value="" disabled>
              选择实例
            </option>
            {instances.data?.instances.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
            <option value={NEW_INSTANCE}>＋ 连接新实例</option>
          </select>
          <ChevronDown size={15} />
        </label>
        <button
          className={`sidebar-link ${tab === 'repositories' ? 'selected' : ''}`}
          onClick={() => {
            setTab('repositories');
            setMobileMenu(false);
          }}
        >
          GitHub 仓库
        </button>
        <div className="section-label">
          <span>会话</span>
          <button
            className="icon-button"
            aria-label="新建会话"
            title={holding ? '新建会话' : '获取控制权后可新建会话'}
            disabled={!online || !holding}
            onClick={() => setModal('session')}
          >
            <Plus size={16} />
          </button>
        </div>
        <nav className="session-list" aria-label="会话列表">
          {sessions.isPending && online ? (
            <div className="subtle-loading">
              <Spinner />
            </div>
          ) : sessions.error ? (
            <Err error={sessions.error} />
          ) : sessions.data?.length ? (
            sessions.data.map((s) => (
              <button
                key={s.sessionId}
                className={`session-link ${sessionId === s.sessionId && tab !== 'repositories' ? 'selected' : ''}`}
                onClick={() => selectSession(s.sessionId)}
              >
                <strong>{sessionLabel(s)}</strong>
                <small>
                  {s.running
                    ? '运行中'
                    : s.updatedAt
                      ? new Date(s.updatedAt).toLocaleString('zh-CN', {
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : ''}
                </small>
              </button>
            ))
          ) : (
            <p className="sidebar-empty">{online ? '暂无会话' : '实例离线'}</p>
          )}
        </nav>
        <button
          className="account"
          aria-label="账户与设置"
          onClick={() => {
            setModal('settings');
            setMobileMenu(false);
          }}
        >
          <span className="avatar">{identity.user.email[0]?.toUpperCase()}</span>
          <span>
            <strong>{identity.user.email}</strong>
            <small>{identity.controller.name}</small>
          </span>
        </button>
      </aside>
      {mobileMenu && (
        <button
          className="sidebar-scrim"
          aria-label="关闭导航"
          onClick={() => setMobileMenu(false)}
        />
      )}
      <main className="main">
        <header className="topbar">
          <button
            className="icon-button mobile-only"
            onClick={() => setMobileMenu(true)}
            aria-label="打开导航"
            aria-expanded={mobileMenu}
          >
            <Menu size={20} />
          </button>
          {instance ? (
            <>
              <h1 className="instance-title">{instance.name}</h1>
              <button
                className={`status-button ${streamLive ? instanceStatus(instance) : 'connecting'}`}
                onClick={() => (streamLive ? setModal('status') : eventStream.retry())}
                aria-label={streamLive ? `实例状态：${statusText}` : `${statusText}，点击立即重连`}
              >
                <span className={`status-dot ${streamLive ? '' : 'pulse-warn'}`} />
                <span key={statusKey} className="swap">
                  {statusText}
                </span>
              </button>
              <div className="control">
                {occupied && (
                  <span className="control-note swap">{controllerName(lease?.controllerId)} 控制中</span>
                )}
                <button
                  className={`control-button ${controlState}`}
                  disabled={leaseMutation.isPending || !online || eventStream.state !== 'live'}
                  title={
                    holding
                      ? `${Math.max(0, Math.ceil((new Date(lease!.expiresAt).getTime() - clock) / 1000))}s 后自动续期`
                      : undefined
                  }
                  aria-label={holding ? '控制中，点击释放' : undefined}
                  onClick={() =>
                    holding
                      ? leaseMutation.mutate({ release: true })
                      : occupied
                        ? setModal('takeover')
                        : leaseMutation.mutate({})
                  }
                >
                  {controlState === 'pending' ? (
                    <span className="swap" key="pending">
                      <Spinner />
                      确认中
                    </span>
                  ) : controlState === 'held' ? (
                    <span className="swap held" key="held">
                      <span className="held-label">
                        <Check size={14} />
                        控制中
                      </span>
                      <span className="release-label">释放</span>
                    </span>
                  ) : controlState === 'occupied' ? (
                    <span className="swap" key="occupied">
                      接管
                    </span>
                  ) : (
                    <span className="swap" key="acquire">
                      获取控制权
                    </span>
                  )}
                </button>
              </div>
            </>
          ) : null}
        </header>
        {notice && (
          <div className="notice swap" role="status">
            {notice}
            <button className="icon-button" onClick={() => setNotice('')} aria-label="关闭提示">
              <X size={15} />
            </button>
          </div>
        )}
        <Err error={instances.error} />
        {instance ? (
          <>
            <RecoveryPanel instanceId={id} />
            <section className="conversation-panel">
              {tab === 'repositories' ? (
                <RepositoryPanel
                  key={id ?? 'none'}
                  instance={instance}
                  controller={identity.controller}
                  lease={holding ? lease! : null}
                  onClose={() => setTab('conversation')}
                />
              ) : sessionId ? (
                <Session
                  key={`${id}:${sessionId}`}
                  id={id!}
                  sessionId={sessionId}
                  controller={identity.controller}
                  lease={holding ? lease! : null}
                  online={online}
                  events={events}
                  approvals={eventStream.approvals.filter(
                    (a) => a.instanceId === id && a.sessionId === sessionId,
                  )}
                  stream={eventStream.streams[`${id}:${sessionId}`]}
                  summary={selected}
                  notify={setNotice}
                />
              ) : online ? (
                <div className="empty-state swap">
                  <h2>{holding ? '选择或新建会话' : '选择一个会话'}</h2>
                </div>
              ) : (
                <div className="empty-state swap">
                  <h2>等待实例上线</h2>
                  <p>在 DSH 的插件页安装 DSH Remote，再用配对链接连接这台实例。</p>
                  <div className="actions">
                    <button className="primary" onClick={() => setModal('pair')}>
                      配对
                    </button>
                  </div>
                </div>
              )}
            </section>
          </>
        ) : tab === 'repositories' ? (
          <RepositoryPanel
            controller={identity.controller}
            instance={instance}
            lease={null}
            onClose={() => setTab('conversation')}
          />
        ) : (
          <div className="empty-state welcome swap">
            <h1>{search.instance ? '未找到此实例' : '连接你的第一台 DSH'}</h1>
            <p>
              {search.instance
                ? '实例可能不存在，或当前账户没有访问权限。'
                : '添加实例后，用配对链接把运行 DSH 的电脑连接进来。'}
            </p>
            <div className="actions">
              <button className="primary" onClick={() => setModal('instance')}>
                连接新实例
              </button>
            </div>
          </div>
        )}
      </main>
      {modal === 'settings' && (
        <Modal title="设置" onClose={() => setModal(null)} busy={logout.isPending}>
          <label>
            外观
            <select
              className="theme-picker"
              aria-label="外观"
              value={theme}
              onChange={(e) => setTheme(e.target.value as typeof theme)}
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
          <Err error={logout.error} />
          <div className="modal-actions">
            <button className="primary" onClick={() => setModal(null)}>
              完成
            </button>
            <button className="quiet" onClick={() => setModal('devices')}>
              控制设备
            </button>
            <button className="quiet" disabled={logout.isPending} onClick={() => logout.mutate()}>
              退出登录
            </button>
          </div>
        </Modal>
      )}
      {modal === 'status' && instance && (
        <Modal title={instance.name} onClose={() => setModal(null)}>
          <dl className="facts">
            <dt>状态</dt>
            <dd>{statusLabel(instance)}</dd>
            <dt>中继延迟</dt>
            <dd>{latencyMs !== undefined ? `${latencyMs} ms` : '—'}</dd>
            <dt>最近心跳</dt>
            <dd>{timeLabel(instance.lastSeenAt)}</dd>
            <dt>连接于</dt>
            <dd>{timeLabel(instance.connectedAt)}</dd>
            <dt>断开于</dt>
            <dd>{timeLabel(instance.disconnectedAt)}</dd>
            <dt>控制设备</dt>
            <dd>
              {leaseActive(lease) ? controllerName(lease?.controllerId) : '无'}
              {lease?.pending ? '（等待主机确认）' : ''}
            </dd>
            <dt>实例 ID</dt>
            <dd>
              <code>{instance.id}</code>
            </dd>
          </dl>
          <details className="event-details">
            <summary>事件 {events.length}</summary>
            <EventLog events={events} />
          </details>
          <Err error={instances.error} />
          <div className="modal-actions">
            <button className="primary" onClick={() => setModal(null)}>
              完成
            </button>
            <button className="quiet" onClick={() => setModal('pair')}>
              重新配对
            </button>
            <button className="quiet" onClick={() => setModal('rotate')}>
              更换令牌
            </button>
          </div>
        </Modal>
      )}
      {modal === 'instance' && (
        <CreateInstance onClose={() => setModal(null)} onCreated={switchInstance} />
      )}{' '}
      {modal === 'devices' && (
        <Devices
          controllers={controllers.data?.controllers ?? []}
          error={controllers.error}
          currentId={identity.controller.id}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'rotate' && instance && (
        <RotateCredential instance={instance} onClose={() => setModal(null)} />
      )}
      {modal === 'pair' && instance && (
        <PairInstance instance={instance} onClose={() => setModal(null)} />
      )}
      {modal === 'takeover' && (
        <Modal
          title="接管控制权？"
          description={`${controllerName(lease?.controllerId)} 将变为只读。正在运行的任务不会被取消。`}
          onClose={() => setModal(null)}
        >
          <div className="modal-actions">
            <button
              className="primary"
              onClick={() => leaseMutation.mutate({ takeover: true })}
              disabled={leaseMutation.isPending}
            >
              {leaseMutation.isPending ? <Spinner /> : null}接管
            </button>
            <button className="quiet" onClick={() => setModal(null)}>
              取消
            </button>
          </div>
        </Modal>
      )}
      {modal === 'session' && id && (
        <CreateSession
          instanceId={id}
          controllerId={identity.controller.id}
          lease={
            holding && !operations.operations.some((op) => op.instanceId === id) ? lease! : null
          }
          onClose={() => setModal(null)}
          onCreated={(sid) => {
            selectSession(sid);
            setModal(null);
          }}
        />
      )}
    </div>
  );
}
function Devices({
  controllers,
  error,
  currentId,
  onClose,
}: {
  controllers: Controller[];
  error: unknown;
  currentId: string;
  onClose: () => void;
}) {
  const client = useQueryClient(),
    [target, setTarget] = useState<Controller | null>(null),
    [revoked, setRevoked] = useState<string[]>([]);
  const mutation = useMutation({
    mutationFn: (controller: Controller) =>
      post(`/api/controllers/${encodeURIComponent(controller.id)}/revoke`, {}),
    onSuccess: (_, controller) => {
      setRevoked((old) => [...old, controller.id]);
      setTarget(null);
      void client.invalidateQueries({ queryKey: ['controllers'] });
      void client.invalidateQueries({ queryKey: ['instances'] });
      if (controller.id === currentId) {
        sessionStorage.removeItem('dsh.controller');
        client.setQueryData(['me'], null);
        client.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      }
    },
  });
  return (
    <Modal
      title={target ? '撤销设备登录？' : '控制设备'}
      description={
        target
          ? `${target.name} 将立即退出登录并失去控制权。${target.id === currentId ? '这是当前设备。' : ''}`
          : undefined
      }
      onClose={onClose}
      busy={mutation.isPending}
    >
      {target ? (
        <div className="modal-actions">
          <button
            className="primary"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(target)}
          >
            {mutation.isPending ? <Spinner /> : null}撤销
          </button>
          <button className="quiet" disabled={mutation.isPending} onClick={() => setTarget(null)}>
            取消
          </button>
        </div>
      ) : (
        <div className="device-list">
          {controllers.map((c) => (
            <div key={c.id} className={c.active === false || revoked.includes(c.id) ? 'inactive' : ''}>
              <span>
                <strong>{c.name}</strong>
                {c.id === currentId && <small>当前设备</small>}
              </span>
              {c.active === false || revoked.includes(c.id) ? (
                <small className="swap">已失效</small>
              ) : (
                <button className="text-button" onClick={() => setTarget(c)}>
                  撤销
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <Err error={mutation.error || error} />
    </Modal>
  );
}
function RotateCredential({ instance, onClose }: { instance: Instance; onClose: () => void }) {
  const client = useQueryClient(),
    [token, setToken] = useState(''),
    [copied, setCopied] = useState(false);
  const mutation = useMutation({
    mutationFn: () =>
      post<{ connectorToken: string }>(
        `/api/instances/${encodeURIComponent(instance.id)}/rotate-credential`,
        {},
      ),
    onSuccess: (data) => {
      setToken(data.connectorToken);
      void client.invalidateQueries({ queryKey: ['instances'] });
    },
  });
  return (
    <Modal
      title={token ? '新的连接令牌' : '更换连接令牌？'}
      description={
        token
          ? '令牌只显示这一次。'
          : `${instance.name} 会立即断开并释放控制权，需在 DSH 主机更新令牌后重新连接。`
      }
      onClose={onClose}
      busy={mutation.isPending}
    >
      {token ? (
        <>
          <label>
            Connector 令牌
            <textarea readOnly rows={3} value={token} />
          </label>
          <div className="modal-actions">
            <button className="primary" onClick={onClose}>
              完成
            </button>
            <button
              className="quiet"
              onClick={() => {
                navigator.clipboard
                  ?.writeText(token)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              <span key={copied ? 'done' : 'copy'} className="swap">
                {copied ? <Check size={16} /> : <Clipboard size={16} />}
              </span>
              复制令牌
            </button>
          </div>
        </>
      ) : (
        <div className="modal-actions">
          <button
            className="primary"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? <Spinner /> : null}更换
          </button>
          <button className="quiet" onClick={onClose} disabled={mutation.isPending}>
            取消
          </button>
        </div>
      )}
      <Err error={mutation.error} />
    </Modal>
  );
}
function CreateInstance({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState(''),
    [created, setCreated] = useState<{ instance: Instance; connectorToken: string } | null>(null),
    [pairing, setPairing] = useState<Pairing | null>(null),
    [copied, setCopied] = useState(false),
    client = useQueryClient();
  const instances = useQuery({
    queryKey: ['instances'],
    queryFn: () => api<{ instances: Instance[] }>('/api/instances'),
    enabled: !!created,
    refetchInterval: 3000,
  });
  const live = instances.data?.instances.find((i) => i.id === created?.instance.id);
  const repair = useMutation({
    mutationFn: () => requestPairing(created!.instance.id),
    onSuccess: setPairing,
  });
  const mutation = useMutation({
    mutationFn: async () => {
      const data = await post<{ instance: Instance; connectorToken: string }>('/api/instances', {
        name,
      });
      setCreated(data);
      // The instance exists even if no pairing code could be issued; the user can retry.
      setPairing(await requestPairing(data.instance.id).catch(() => null));
      return data;
    },
    onSettled: () => void client.invalidateQueries({ queryKey: ['instances'] }),
  });
  return (
    <Modal
      busy={mutation.isPending}
      title={created ? `连接 ${created.instance.name}` : '连接新实例'}
      onClose={() => {
        if (created) onCreated(created.instance.id);
        onClose();
      }}
    >
      {created ? (
        <>
          {pairing ? (
            <PairingPanel
              pairing={pairing}
              instance={live}
              onRenew={() => repair.mutate()}
              renewing={repair.isPending}
            />
          ) : (
            <button
              className="quiet wide"
              onClick={() => repair.mutate()}
              disabled={repair.isPending}
            >
              {repair.isPending ? <Spinner /> : <RefreshCw size={16} />}生成配对链接
            </button>
          )}
          <Err error={repair.error} />
          <details className="manual-token">
            <summary>改用手动令牌</summary>
            <p className="tiny">令牌只显示这一次，配对后会失效。不要分享或提交到 Git。</p>
            <label>
              Connector 令牌
              <textarea readOnly rows={3} value={created.connectorToken} />
            </label>
            <button
              className="quiet"
              onClick={() => {
                navigator.clipboard
                  .writeText(created.connectorToken)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              <span key={copied ? 'done' : 'copy'} className="swap">
                {copied ? <Check size={16} /> : <Clipboard size={16} />}
              </span>
              复制令牌
            </button>
          </details>
          <div className="modal-actions">
            <button
              className="primary"
              onClick={() => {
                onCreated(created.instance.id);
                onClose();
              }}
            >
              进入实例
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          <label>
            实例名称
            <input
              autoFocus
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：开发工作站"
            />
          </label>
          <Err error={mutation.error} />
          <div className="modal-actions">
            <button className="primary" disabled={mutation.isPending}>
              {mutation.isPending ? <Spinner /> : null}创建实例
            </button>
            <button className="quiet" type="button" onClick={onClose} disabled={mutation.isPending}>
              取消
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
function CreateSession({
  instanceId,
  controllerId,
  lease,
  onClose,
  onCreated,
}: {
  instanceId: string;
  controllerId: string;
  lease: Lease | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [cwd, setCwd] = useState(''),
    [createdSessionId] = useState(() => crypto.randomUUID()),
    client = useQueryClient(),
    operations = useOperations(),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!lease || !leaseActive(lease)) throw new Error('控制权已失效，请重新获取');
      const data = asRecord(
        await operations.run({
          instanceId,
          controllerId,
          action: 'session.create',
          args: { sessionId: createdSessionId, ...(cwd.trim() ? { cwd: cwd.trim() } : {}) },
          leaseEpoch: lease.epoch,
          references: {},
        }),
      );
      if (typeof data.sessionId !== 'string') throw new Error('实例未返回会话标识');
      return data.sessionId;
    },
    onSuccess: (sid) => {
      void client.invalidateQueries({ queryKey: ['remote', instanceId, 'sessions'] });
      if (mounted.current) onCreated(sid);
    },
  });
  return (
    <Modal title="新建会话" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <label>
          工作目录
          <input
            autoFocus
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="默认：第一个允许的目录"
          />
        </label>
        <Err error={mutation.error} />
        <RecoveryPanel instanceId={instanceId} />
        <div className="modal-actions">
          <button className="primary" disabled={!lease || mutation.isPending}>
            {mutation.isPending ? <Spinner /> : null}创建会话
          </button>
          <button type="button" className="quiet" onClick={onClose}>
            取消
          </button>
        </div>
      </form>
    </Modal>
  );
}
function EventLog({ events }: { events: RemoteEvent[] }) {
  return (
    <div className="event-log">
      {events.length ? (
        <>
          <div className="event-log-label">最近 {events.length} 条事件 · 自动同步</div>
          {[...events].reverse().map((event) => (
            <details key={event.seq} className="event-row">
              <summary>
                <span className="event-time">
                  {new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}
                </span>
                <span>{event.kind}</span>
                <code>#{event.seq}</code>
                <ChevronDown size={13} />
              </summary>
              <pre>{JSON.stringify(event.payload, null, 2)}</pre>
            </details>
          ))}
        </>
      ) : (
        <Empty icon={<Radio size={25} />} title="等待实时事件">
          Connector 连接后，运行状态和会话事件将显示在这里
        </Empty>
      )}
    </div>
  );
}
function Session({
  id,
  sessionId,
  controller,
  lease,
  online,
  events,
  approvals,
  stream,
  summary,
  notify,
}: {
  id: string;
  sessionId: string;
  controller: Controller;
  lease: Lease | null;
  online: boolean;
  events: RemoteEvent[];
  approvals: PendingApproval[];
  stream?: LiveStream;
  summary?: SessionSummary;
  notify: (s: string) => void;
}) {
  const draftKey = `dsh.draft.${controller.id}.${id}.${sessionId}`;
  const [savedDraft] = useState(() => readDraft(draftKey));
  const client = useQueryClient(),
    [prompt, setPrompt] = useState(savedDraft.text),
    [mode, setMode] = useState<'queue' | 'steer'>(savedDraft.mode),
    [modelOpen, setModelOpen] = useState(false),
    [files, setFiles] = useState<{ name: string; content: Record<string, unknown> }[]>(
      savedDraft.files,
    ),
    [uploading, setUploading] = useState(false),
    [uploadError, setUploadError] = useState(''),
    [approvalBusy, setApprovalBusy] = useState<string | null>(null),
    [queueBusy, setQueueBusy] = useState<string | null>(null),
    [queueEdit, setQueueEdit] = useState<{ item: unknown; text: string } | null>(null),
    [actionError, setActionError] = useState(''),
    [autoScroll, setAutoScroll] = useState(true),
    [referenceIds, setReferenceIds] = useState<string[]>(savedDraft.references),
    [contextOpen, setContextOpen] = useState(false);
  useEffect(() => {
    if (!saveDraft(draftKey, { text: prompt, mode, references: referenceIds, files }))
      setUploadError('草稿未能保存在此标签页。离开前请复制文本或减少附件');
  }, [draftKey, prompt, mode, referenceIds, files]);
  const operations = useOperations();
  const references = useQuery({
    queryKey: ['repositories', id],
    queryFn: ({ signal }) => getReferences(id, signal),
    refetchInterval: 10000,
  });
  const scrollRef = useRef<HTMLDivElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    submissionLock = useRef(false),
    submission = useRef<{ fingerprint: string; requestId: string; commandId: string } | null>(null);
  const history = useQuery({
    queryKey: ['remote', id, 'session', sessionId],
    queryFn: ({ signal }) =>
      runCommand(id, controller.id, 'session.read', { sessionId }, undefined, signal),
    enabled: online,
    refetchInterval: summary?.running ? 5000 : 20000,
  });
  const data = asRecord(history.data),
    projection = asRecord(asRecord(data.projections).values),
    selection = asRecord(
      asRecord(projection.modelSelection).next ?? asRecord(projection.modelSelection).lastUsed,
    ),
    running = data.running === true || summary?.running === true;
  const wireEvents = mergeEvents(historyEvents(history.data), events, sessionId);
  const messages = wireEvents
    .map((event) => ({ event, message: eventMessage(event) }))
    .filter((row) => row.message?.text);
  const pending = new Map(approvals.map((a) => [a.approvalId, a]));
  const streamText = stream?.text ?? '';
  const queued = [
    ...asList(asRecord(projection.inbox)['next-turn'], 'items'),
    ...asList(asRecord(projection.inbox)['next-step'], 'items'),
  ];
  const canWrite =
    !!lease &&
    leaseActive(lease) &&
    online &&
    !operations.operations.some((op) => op.instanceId === id);
  const attachedReferences = referenceIds.map((referenceId) =>
    references.data?.repositories.find((row) => row.id === referenceId),
  );
  const invalidReferences = attachedReferences.some((row) => !row || row.localState !== 'verified');
  async function write(
    action: string,
    args: Record<string, unknown>,
    commandId?: string,
    repositoryIds?: string[],
  ) {
    if (!lease || !leaseActive(lease) || !online)
      throw new Error('控制权或实例连接已失效，请重新获取');
    const result = await operations.run(
      {
        instanceId: id,
        controllerId: controller.id,
        action,
        args,
        leaseEpoch: lease.epoch,
        references: repositoryIds?.length ? { repositoryIds } : {},
      },
      commandId,
    );
    void client.invalidateQueries({ queryKey: ['remote', id] });
    return result;
  }
  const send = useMutation({
    mutationFn: async () => {
      if (submissionLock.current) throw new Error('消息正在提交');
      const content = [
        ...(prompt.trim() ? [{ type: 'text', text: prompt.trim() }] : []),
        ...files.map((f) => f.content),
      ];
      const repositoryIds = repositoryIdsForPrompt(
        references.data?.repositories ?? [],
        referenceIds,
        id,
      );
      const fingerprint = JSON.stringify({ content, mode, repositoryIds });
      if (submission.current?.fingerprint !== fingerprint)
        submission.current = {
          fingerprint,
          requestId: crypto.randomUUID(),
          commandId: crypto.randomUUID(),
        };
      submissionLock.current = true;
      try {
        return await write(
          'session.prompt',
          {
            sessionId,
            requestId: submission.current.requestId,
            mode,
            content,
            clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          submission.current.commandId,
          repositoryIds,
        );
      } finally {
        submissionLock.current = false;
      }
    },
    onSuccess: () => {
      submission.current = null;
      setPrompt('');
      setFiles([]);
      setReferenceIds([]);
      setAutoScroll(true);
    },
  });
  const cancel = useMutation({
    mutationFn: () => write('session.cancel', { sessionId }),
    onSuccess: () => notify('已请求停止当前任务'),
  });
  const resume = useMutation({
    mutationFn: () => write('session.resume', { sessionId }),
    onSuccess: () => notify('已恢复会话运行环境'),
  });
  useEffect(() => {
    const el = scrollRef.current;
    if (el && autoScroll) el.scrollTop = el.scrollHeight;
  }, [messages.length, streamText, autoScroll]);
  async function upload(file: File) {
    if (file.size > 4 * 1024 * 1024) {
      setUploadError('附件不能超过 4 MiB');
      return;
    }
    setUploading(true);
    setUploadError('');
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]!);
        reader.onerror = () => reject(new Error('无法读取文件'));
        reader.readAsDataURL(file);
      });
      if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
        if (
          files.reduce(
            (total, f) => total + (typeof f.content.data === 'string' ? f.content.data.length : 0),
            0,
          ) +
            data.length >
          6 * 1024 * 1024
        )
          throw new Error('图片总大小超过单条消息限制，请减少附件');
        setFiles((old) => [
          ...old,
          {
            name: file.name,
            content: { type: 'image', mediaType: file.type, data, name: file.name },
          },
        ]);
      } else {
        const result = asRecord(
          await write('attachment.upload', { sessionId, data, name: file.name }),
        );
        if (typeof result.receiptId !== 'string') throw new Error('DSH 未返回附件回执');
        setFiles((old) => [
          ...old,
          { name: file.name, content: { type: 'file', receiptId: result.receiptId } },
        ]);
      }
    } catch (error) {
      setUploadError(errorText(error));
    } finally {
      setUploading(false);
    }
  }
  async function approve(approval: Record<string, unknown>, outcome: string) {
    setApprovalBusy(String(approval.approvalId));
    setActionError('');
    try {
      await write('approval.respond', {
        sessionId,
        approvalId: approval.approvalId,
        bootId: approval.bootId,
        presentationHash: approval.presentationHash,
        outcome,
      });
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setApprovalBusy(null);
    }
  }
  async function changeQueue(item: unknown, kind: 'steer' | 'remove' | 'edit', text?: string) {
    const row = asRecord(item);
    if (typeof row.id !== 'string') {
      setActionError('此队列项缺少标识');
      return;
    }
    setQueueBusy(row.id);
    setActionError('');
    try {
      await write('session.queue.update', {
        sessionId,
        itemId: row.id,
        action:
          kind === 'edit' ? { kind, content: [{ type: 'text', text: text?.trim() }] } : { kind },
      });
      if (kind === 'edit') setQueueEdit(null);
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setQueueBusy(null);
    }
  }
  return (
    <>
      <div className="session-toolbar">
        <strong>{summary ? sessionLabel(summary) : sessionId.slice(0, 20)}</strong>
        <span>{summary?.cwd ?? String(asRecord(data.header).cwd ?? sessionId)}</span>
      </div>
      <div
        className="transcript"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 100);
        }}
      >
        {history.isPending && online ? (
          <div className="subtle-loading">
            <Spinner />
          </div>
        ) : null}
        <Err error={history.error} />
        {!history.isPending && !messages.length && !streamText ? (
          <p className="transcript-empty">尚无消息</p>
        ) : null}
        {messages.map(({ event, message }) =>
          message!.role === '运行时上下文' ? (
            <details key={event.seq} className="runtime-record">
              <summary>
                运行时上下文 · {String(asRecord(asRecord(event.data).source).kind ?? '系统')}
              </summary>
              <pre>{message!.text}</pre>
            </details>
          ) : (
            <article
              key={event.seq}
              className={`message ${message!.role === '你' ? 'user-message' : ''}`}
            >
              <div className="message-content">
                <header>
                  <strong>{message!.role}</strong>
                  <time>
                    {event.time
                      ? new Date(event.time).toLocaleTimeString('zh-CN', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : ''}
                  </time>
                </header>
                <div className="message-text">{message!.text}</div>
              </div>
            </article>
          ),
        )}
        {streamText && (
          <article className="message live-message">
            <div className="message-content">
              <header>
                <strong>DSH</strong>
                <span className="status-dot pulse" />
                {stream?.incomplete ? <span>部分片段，结束后同步完整内容</span> : null}
              </header>
              <div className="message-text">
                {streamText}
                <span className="cursor" />
              </div>
            </div>
          </article>
        )}
      </div>
      {!autoScroll && (
        <button className="scroll-latest" onClick={() => setAutoScroll(true)}>
          <ArrowDown size={14} />
          最新消息
        </button>
      )}
      {queued.length > 0 && (
        <div className="queue-list">
          <h4>队列 {queued.length}</h4>
          {queued.map((item, index) => (
            <div key={String(asRecord(item).id ?? index)}>
              <p>{contentText(asRecord(item).content)}</p>
              <button
                className="icon-button"
                title="编辑队列项"
                aria-label="编辑队列项"
                disabled={!canWrite || !!queueBusy}
                onClick={() => setQueueEdit({ item, text: contentText(asRecord(item).content) })}
              >
                <Pencil size={14} />
              </button>
              <button
                className="icon-button"
                title="转为 steer"
                aria-label="转为 steer"
                disabled={!canWrite || !!queueBusy}
                onClick={() => void changeQueue(item, 'steer')}
              >
                <Zap size={14} />
              </button>
              <button
                className="icon-button"
                title="移除队列项"
                aria-label="移除队列项"
                disabled={!canWrite || !!queueBusy}
                onClick={() => void changeQueue(item, 'remove')}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="approval-dock">
        {pending.size > 0 &&
          [...pending.values()].map((approval) => (
            <div className="approval-card swap" key={String(approval.approvalId)}>
              <strong className="approval-title">等待你的审批</strong>
              <h4>{String(approval.toolName ?? '工具调用')}</h4>
              <p>{String(approval.reason ?? '请核对本次操作后决定是否允许')}</p>
              {toolCallForApproval(approval, wireEvents) ? (
                <div className="approval-arguments">
                  <label>本次工具调用参数 · {String(approval.callId)}</label>
                  <pre>{toolCallForApproval(approval, wireEvents)!.arguments}</pre>
                </div>
              ) : (
                <p className="approval-missing">
                  {approval.callId
                    ? '尚未载入匹配此调用的参数，请刷新历史后再允许。现在仍可拒绝。'
                    : '此审批没有关联工具调用参数，请根据上方操作说明决定。'}
                </p>
              )}
              <div className="approval-actions">
                <button
                  className="primary small"
                  disabled={
                    !canWrite ||
                    !!approvalBusy ||
                    (!!approval.callId && !toolCallForApproval(approval, wireEvents))
                  }
                  onClick={() => void approve(approval, 'allowed-once')}
                >
                  {approvalBusy === approval.approvalId ? <Spinner /> : null}允许本次
                </button>
                <button
                  className="quiet"
                  disabled={!canWrite || !!approvalBusy}
                  onClick={() => void approve(approval, 'rejected')}
                >
                  拒绝
                </button>
              </div>
            </div>
          ))}
      </div>
      <div className="composer-area">
        <Err error={send.error || cancel.error || resume.error || uploadError || actionError} />
        {invalidReferences && (
          <div className="error" role="alert">
            引用已过期或不可用，请在仓库页面重新验证，或移除对应引用
          </div>
        )}
        <form
          className={`composer ${!canWrite ? 'disabled' : ''}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (
              canWrite &&
              !invalidReferences &&
              (prompt.trim() || files.length) &&
              !send.isPending
            )
              send.mutate();
          }}
        >
          {referenceIds.length > 0 && (
            <div className="repository-chips">
              {referenceIds.map((referenceId, index) => (
                <span className="reference-chip" key={referenceId}>
                  <Layers3 size={13} />
                  <span>
                    {attachedReferences[index]?.fullName ?? '不可用引用'}
                    {attachedReferences[index]?.localState !== 'verified' ? ' · 待验证' : ''}
                  </span>
                  <button
                    type="button"
                    aria-label={`移除仓库 ${attachedReferences[index]?.fullName ?? referenceId}`}
                    onClick={() =>
                      setReferenceIds((old) => old.filter((value) => value !== referenceId))
                    }
                  >
                    <X size={13} />
                  </button>
                </span>
              ))}
              <button type="button" className="text-button" onClick={() => setContextOpen(true)}>
                预览引用上下文
              </button>
            </div>
          )}
          {files.length > 0 && (
            <div className="attachment-list">
              {files.map((file, index) => (
                <span key={index}>
                  <FileText size={13} />
                  {file.name}
                  <button
                    type="button"
                    aria-label={`移除 ${file.name}`}
                    onClick={() => setFiles((old) => old.filter((_, i) => i !== index))}
                  >
                    <X size={13} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            maxLength={100000}
            aria-label="消息"
            placeholder={
              canWrite
                ? '描述任务，或告诉 DSH 下一步该怎么做'
                : operations.operations.some((op) => op.instanceId === id)
                  ? '原命令尚待确认'
                  : online
                    ? '只读 · 获取控制权后可发送'
                    : '实例离线'
            }
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={!canWrite || send.isPending}
            rows={3}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (
                  canWrite &&
                  !invalidReferences &&
                  (prompt.trim() || files.length) &&
                  !send.isPending
                )
                  send.mutate();
              }
            }}
          />
          <div className="composer-tools">
            <div>
              <button
                type="button"
                className="icon-button"
                aria-label="添加附件"
                title="添加附件，最大 4 MiB"
                disabled={!canWrite || uploading || send.isPending || files.length >= 4}
                onClick={() => fileInput.current?.click()}
              >
                {uploading ? <Spinner /> : <Paperclip size={17} />}
              </button>
              <input
                type="file"
                hidden
                ref={fileInput}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void upload(file);
                  e.target.value = '';
                }}
              />
              <select
                className="reference-picker"
                aria-label="添加仓库引用"
                value=""
                disabled={referenceIds.length >= 8}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value)
                    setReferenceIds((old) => (old.includes(value) ? old : [...old, value]));
                }}
              >
                <option value="">引用仓库 ({referenceIds.length}/8)</option>
                {references.data?.repositories
                  .filter((row) => row.selected && !referenceIds.includes(row.id))
                  .map((row) => (
                    <option key={row.id} value={row.id} disabled={row.localState !== 'verified'}>
                      {row.fullName}
                      {row.localState !== 'verified' ? ' · 请先验证' : ''}
                    </option>
                  ))}
              </select>
              <button type="button" className="model-button" onClick={() => setModelOpen(true)}>
                <Settings2 size={14} />
                <span>{String(selection.model ?? '模型与配置')}</span>
                <ChevronDown size={12} />
              </button>
            </div>
            <div>
              <select
                className="mode-picker"
                aria-label="消息模式"
                value={mode}
                onChange={(e) => setMode(e.target.value as 'queue' | 'steer')}
                disabled={!canWrite}
              >
                <option value="queue">排队</option>
                <option value="steer">下一步引导</option>
              </select>
              {running && !prompt.trim() && !files.length ? (
                <button
                  type="button"
                  key="stop"
                  className="stop-button swap"
                  aria-label="停止任务"
                  title="停止任务"
                  disabled={!canWrite || cancel.isPending}
                  onClick={() => cancel.mutate()}
                >
                  {cancel.isPending ? <Spinner /> : <Square size={13} />}
                </button>
              ) : (
                <button
                  key="send"
                  className="send-button swap"
                  aria-label="发送消息"
                  title="发送 · Ctrl / ⌘ + Enter"
                  disabled={
                    !canWrite ||
                    invalidReferences ||
                    send.isPending ||
                    uploading ||
                    (!prompt.trim() && !files.length)
                  }
                >
                  {send.isPending ? <Spinner /> : <Send size={17} />}
                </button>
              )}
            </div>
          </div>
        </form>
        {data.agentAvailable === false && (
          <div className="composer-footer">
            <button
              className="text-button"
              disabled={!canWrite || resume.isPending}
              onClick={() => resume.mutate()}
            >
              恢复运行环境
            </button>
          </div>
        )}
      </div>
      {contextOpen && (
        <Modal
          title="本条消息的仓库上下文"
          description="仅使用实例绑定的引用 ID，服务端再次检查已有工作树。此预览不包含仓库文件或访问令牌"
          onClose={() => setContextOpen(false)}
        >
          {attachedReferences.map((row, index) => (
            <div className="repository-row" key={referenceIds[index]}>
              {row ? (
                <div>
                  <strong>{row.fullName}</strong>
                  <pre>{JSON.stringify(contextPreview(row), null, 2)}</pre>
                </div>
              ) : (
                <p>此引用已不可用，请移除</p>
              )}
              <button
                className="quiet"
                onClick={() =>
                  setReferenceIds((old) => old.filter((value) => value !== referenceIds[index]))
                }
              >
                移除引用
              </button>
            </div>
          ))}
          <div className="modal-actions">
            <button className="primary" onClick={() => setContextOpen(false)}>
              返回草稿
            </button>
          </div>
        </Modal>
      )}
      {queueEdit && (
        <Modal
          title="编辑待处理消息"
          description="只能修改尚未消费的队列文本"
          onClose={() => setQueueEdit(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void changeQueue(queueEdit.item, 'edit', queueEdit.text);
            }}
          >
            <label>
              队列消息
              <textarea
                aria-label="队列消息"
                rows={5}
                maxLength={100000}
                value={queueEdit.text}
                onChange={(e) => setQueueEdit({ ...queueEdit, text: e.target.value })}
              />
            </label>
            <Err error={actionError} />
            <div className="modal-actions">
              <button type="button" className="quiet" onClick={() => setQueueEdit(null)}>
                取消
              </button>
              <button
                className="primary"
                disabled={!canWrite || !!queueBusy || !queueEdit.text.trim()}
              >
                {queueBusy ? <Spinner /> : <Check size={16} />}保存队列消息
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modelOpen && (
        <ModelSettings
          instanceId={id}
          sessionId={sessionId}
          controllerId={controller.id}
          canWrite={canWrite}
          write={write}
          current={selection}
          onClose={() => setModelOpen(false)}
        />
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
