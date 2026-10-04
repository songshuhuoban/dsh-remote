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
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Command as CommandIcon,
  Cpu,
  FileText,
  Globe2,
  KeyRound,
  Layers3,
  Loader2,
  LogOut,
  Menu,
  MessageSquare,
  Monitor,
  Paperclip,
  Pencil,
  Plus,
  Radio,
  RefreshCw,
  Send,
  Settings2,
  Shield,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import {
  api,
  ApiError,
  asList,
  asRecord,
  errorText,
  isOnline,
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
import './styles.css';
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
  <div className="brand">
    <span className="brand-mark">
      <Terminal size={19} />
    </span>
    <span>
      DSH <span className="brand-light">REMOTE</span>
    </span>
  </div>
);
const Spinner = () => <Loader2 className="spin" size={16} />;
const Err = ({ error }: { error: unknown }) =>
  error ? (
    <div role="alert" className="error">
      <Shield size={15} />
      <span>{errorText(error)}</span>
    </div>
  ) : null;
const Empty = ({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) => (
  <div className="empty">
    <div className="empty-icon">{icon}</div>
    <h3>{title}</h3>
    <p>{children}</p>
  </div>
);
function Modal({
  title,
  description,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
      onClick={(e) => {
        if (!busy && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-top">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <button className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭">
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function App() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Identity>('/api/me'), retry: false });
  if (me.isPending)
    return (
      <main className="boot">
        <Brand />
        <Spinner />
        <p>正在连接控制台…</p>
      </main>
    );
  if (!me.data)
    return (
      <Auth error={me.error instanceof ApiError && me.error.status === 401 ? null : me.error} />
    );
  return <Console identity={me.data} />;
}
function Auth({ error }: { error: unknown }) {
  const client = useQueryClient(),
    [register, setRegister] = useState(false),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [deviceName, setDeviceName] = useState('Web 控制台');
  const mutation = useMutation({
    mutationFn: () =>
      post<Identity>(`/api/auth/${register ? 'register' : 'login'}`, {
        email,
        password,
        deviceName,
      }),
    onSuccess: (data) => {
      sessionStorage.setItem('dsh.controller', data.controller.id);
      client.setQueryData(['me'], {user:data.user,controller:data.controller});
    },
  });
  return (
    <main className="auth-page">
      <section className="auth-story">
        <Brand />
        <div className="auth-hero">
          <span className="eyebrow">YOUR AGENTS. WITHIN REACH.</span>
          <h1>
            工作在继续
            <br />
            控制，随你而行<span>。</span>
          </h1>
          <p>
            一个安全的入口，连接每一台 DSH 实例
            <br />
            让终端、浏览器与手机保持同步
          </p>
          <div className="connection-art" aria-hidden="true">
            <div>
              <Terminal />
              <span>DSH 实例</span>
            </div>
            <i />
            <div className="hub">
              <Globe2 />
              <span>REMOTE</span>
            </div>
            <i />
            <div>
              <Monitor />
              <span>控制设备</span>
            </div>
          </div>
          <div className="story-points">
            <span>
              <ShieldCheck size={17} /> 出站连接
            </span>
            <span>
              <Layers3 size={17} /> 多实例隔离
            </span>
            <span>
              <KeyRound size={17} /> 单一写入租约
            </span>
          </div>
        </div>
        <footer>
          DSH REMOTE <span>开源 · 自托管 · 为协作而生</span>
        </footer>
      </section>
      <section className="auth-form-wrap">
        <form
          className="auth-form"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          <span className="eyebrow">CONTROL CENTER</span>
          <h2>{register ? '建立你的工作空间' : '欢迎回来'}</h2>
          <p>
            {register ? '创建账户，安全地连接你的第一台实例' : '登录以继续管理你的 DSH 工作空间'}
          </p>
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
              minLength={12}
              autoComplete={register ? 'new-password' : 'current-password'}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={register ? '至少 12 个字符' : '输入你的密码'}
            />
          </label>
          <label>
            当前设备名称
            <input
              required
              maxLength={80}
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              autoComplete="off"
            />
          </label>
          <Err error={mutation.error || error} />
          <button className="primary wide" disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner /> : null}
            {register ? '创建账户' : '登录控制台'}
            <ArrowRight size={17} />
          </button>
          <p className="auth-switch">
            {register ? '已经有账户？' : '第一次使用？'}{' '}
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setRegister(!register);
                mutation.reset();
              }}
            >
              {register ? '登录' : '创建账户'}
            </button>
          </p>
          <div className="secure-note">
            <ShieldCheck size={15} /> 登录凭据使用 HttpOnly Cookie 保管
          </div>
        </form>
      </section>
    </main>
  );
}
function Console({ identity }: { identity: Identity }) {
  const client = useQueryClient(),
    navigate = useNavigate({ from: '/' }),
    search = indexRoute.useSearch(),
    [mobileMenu, setMobileMenu] = useState(false),
    [modal, setModal] = useState<'instance' | 'devices' | 'session' | 'takeover' | 'rotate' | null>(
      null,
    ),
    [notice, setNotice] = useState(''),
    [clock, setClock] = useState(Date.now()),
    [tab, setTab] = useState<'conversation' | 'events'>('conversation');
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
    holding = leaseActive(lease, clock) && lease?.controllerId === identity.controller.id,
    occupied = leaseActive(lease, clock) && !holding;
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
  const selected = sessions.data?.find((s) => s.sessionId === search.session);
  const sessionId = search.session;
  const events = eventStream.events.filter((e) => e.instanceId === id);
  const switchInstance = (value: string) => {
    void navigate({ search: { instance: value, session: undefined } });
    setMobileMenu(false);
    setNotice('');
  };
  const selectSession = (value: string) => {
    void navigate({ search: { instance: id, session: value } });
    setMobileMenu(false);
    setTab('conversation');
  };
  const leaseMutation = useMutation({
    mutationFn: ({
      takeover = false,
      release = false,
    }: {
      takeover?: boolean;
      release?: boolean;
    }) =>
      release
        ? api(`/api/instances/${id}/lease`, {
            method: 'DELETE',
            body: JSON.stringify({ controllerId: identity.controller.id }),
          })
        : post<Lease>(`/api/instances/${id}/lease`, {
            controllerId: identity.controller.id,
            takeover,
          }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['instances'] });
      setModal(null);
      setNotice('');
    },
    onError: (error) => {
      setNotice(errorText(error));
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
  return (
    <div className="shell">
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
        <div className="workspace-label">
          工作空间 <span>PERSONAL</span>
        </div>
        <div className="instance-picker">
          <Cpu size={18} />
          <select
            aria-label="选择实例"
            value={id ?? ''}
            onChange={(e) => switchInstance(e.target.value)}
          >
            <option value="" disabled>
              选择实例
            </option>
            {instances.data?.instances.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
                {isOnline(i) ? ' · 在线' : ' · 离线'}
              </option>
            ))}
          </select>
          <ChevronDown size={15} />
        </div>
        <button className="sidebar-action" onClick={() => setModal('instance')}>
          <Plus size={16} /> 连接新实例
          <ArrowUpRight size={14} />
        </button>
        <div className="sidebar-divider" />
        <div className="section-label">
          <span>
            会话 <em>{sessions.data?.length ?? 0}</em>
          </span>
          <button
            className="icon-button"
            title="刷新会话"
            aria-label="刷新会话"
            disabled={!online || sessions.isFetching}
            onClick={() => void sessions.refetch()}
          >
            <RefreshCw size={14} className={sessions.isFetching ? 'spin' : ''} />
          </button>
        </div>
        <button
          className="new-session"
          disabled={!online || !holding}
          onClick={() => setModal('session')}
        >
          <Plus size={17} /> 新建会话<kbd>NEW</kbd>
        </button>
        {!holding && online && <p className="tiny sidebar-hint">获取控制权后可创建和发送消息</p>}
        <nav className="session-list" aria-label="会话列表">
          {sessions.isPending && online ? (
            <div className="subtle-loading">
              <Spinner /> 读取会话…
            </div>
          ) : sessions.error ? (
            <Err error={sessions.error} />
          ) : sessions.data?.length ? (
            sessions.data.map((s) => (
              <button
                key={s.sessionId}
                className={`session-link ${sessionId === s.sessionId ? 'selected' : ''}`}
                onClick={() => selectSession(s.sessionId)}
              >
                <MessageSquare size={16} />
                <span>
                  <strong>{sessionLabel(s)}</strong>
                  <small>
                    {s.running
                      ? '正在运行'
                      : s.updatedAt
                        ? new Date(s.updatedAt).toLocaleString('zh-CN', {
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : '已保存的会话'}
                  </small>
                </span>
                {s.running && <span className="status-dot pulse" />}
              </button>
            ))
          ) : (
            <div className="sidebar-empty">
              {online ? '暂无会话，从一个新任务开始' : '连接实例后查看会话'}
            </div>
          )}
        </nav>
        <div className="sidebar-bottom">
          <button onClick={() => setModal('devices')}>
            <Monitor size={17} />
            <span>控制设备</span>
            <span className="counter">{controllers.data?.controllers.length ?? '—'}</span>
          </button>
          <div className="account">
            <span className="avatar">{identity.user.email[0]?.toUpperCase()}</span>
            <span>
              <strong>{identity.user.email}</strong>
              <small>{identity.controller.name}</small>
            </span>
            <button
              className="icon-button"
              aria-label="退出登录"
              title="退出登录"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
            >
              <LogOut size={16} />
            </button>
          </div>
          <Err error={logout.error} />
        </div>
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
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumbs">
            <span>控制台</span>
            <ChevronRight size={13} />
            <strong>{instance?.name ?? '工作空间'}</strong>
          </div>
          {instance && (
            <button
              className="icon-button"
              aria-label="实例连接凭据"
              title="实例连接凭据"
              onClick={() => setModal('rotate')}
            >
              <KeyRound size={16} />
            </button>
          )}
          <div className={`stream-status ${eventStream.state === 'live' ? 'good' : ''}`}>
            <span className="status-dot" />
            {eventStream.state === 'live'
              ? '实时同步'
              : eventStream.state === 'offline'
                ? '网络离线'
                : eventStream.state === 'reconnecting'
                  ? '正在重连'
                  : '正在连接'}
          </div>
        </header>
        {notice && (
          <div className="notice" role="status">
            {notice}
            <button className="icon-button" onClick={() => setNotice('')} aria-label="关闭提示">
              <X size={15} />
            </button>
          </div>
        )}
        <Err error={instances.error} />
        {instance ? (
          <>
            <section className="instance-head">
              <div>
                <div className="eyebrow">INSTANCE WORKSPACE</div>
                <h1>
                  {instance.name}
                  <span className={`pill ${online ? 'online' : ''}`}>
                    <span className="status-dot" />
                    {online ? '在线' : '离线'}
                  </span>
                </h1>
                <p>你的 DSH 会话、运行状态与控制权，尽在此处</p>
              </div>
              <div className="lease-card">
                <div className={`lease-icon ${holding ? 'owned' : ''}`}>
                  {holding ? <KeyRound size={20} /> : <Shield size={20} />}
                </div>
                <div>
                  <strong>
                    {holding
                      ? '你拥有控制权'
                      : occupied
                        ? '当前为只读模式'
                        : lease?.pending
                          ? '等待控制权确认'
                          : '可获取控制权'}
                  </strong>
                  <small>
                    {holding
                      ? `${identity.controller.name} · ${Math.max(0, Math.ceil((new Date(lease!.expiresAt).getTime() - clock) / 1000))}s 后续期 / 到期`
                      : occupied
                        ? `${controllerName(lease?.controllerId)} 正在控制`
                        : '其他设备可同时查看会话'}
                  </small>
                </div>
                <button
                  className={holding ? 'quiet' : 'primary small'}
                  disabled={leaseMutation.isPending || !online}
                  onClick={() =>
                    holding
                      ? leaseMutation.mutate({ release: true })
                      : occupied
                        ? setModal('takeover')
                        : leaseMutation.mutate({})
                  }
                >
                  {leaseMutation.isPending ? (
                    <Spinner />
                  ) : holding ? (
                    '释放'
                  ) : occupied ? (
                    '接管'
                  ) : (
                    '获取控制权'
                  )}
                </button>
              </div>
            </section>
            <div className="content-grid">
              <section className="conversation-panel">
                <div className="panel-tabs">
                  <div>
                    <button
                      className={tab === 'conversation' ? 'active' : ''}
                      onClick={() => setTab('conversation')}
                    >
                      <MessageSquare size={16} /> 会话
                    </button>
                    <button
                      className={tab === 'events' ? 'active' : ''}
                      onClick={() => setTab('events')}
                    >
                      <Radio size={16} /> 实时事件 <span>{events.length}</span>
                    </button>
                  </div>
                  <span className="session-indicator">
                    {selected?.running ? (
                      <>
                        <span className="status-dot pulse" />
                        运行中
                      </>
                    ) : sessionId ? (
                      '会话已选择'
                    ) : (
                      '等待选择会话'
                    )}
                  </span>
                </div>
                {tab === 'events' ? (
                  <EventLog events={events} />
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
                ) : (
                  <div className="choose-session">
                    <div className="hero-glyph">
                      <CommandIcon size={33} />
                    </div>
                    <span className="eyebrow">READY WHEN YOU ARE</span>
                    <h2>接下来，做点什么？</h2>
                    <p>
                      选择左侧会话，查看 DSH 的工作进展
                      <br />
                      或创建一个新会话，开始你的下一个任务
                    </p>
                    <button
                      className="primary"
                      disabled={!holding || !online}
                      onClick={() => setModal('session')}
                    >
                      <Plus size={17} />
                      新建会话
                    </button>
                    <div className="empty-features">
                      <span>
                        <MessageSquare size={18} /> 持续对话
                      </span>
                      <span>
                        <Zap size={18} /> 实时反馈
                      </span>
                      <span>
                        <ShieldCheck size={18} /> 安全协作
                      </span>
                    </div>
                  </div>
                )}
              </section>
              <aside className="inspector">
                <div className="section-label">
                  实例概览
                  <Cpu size={16} />
                </div>
                <div className="info-block">
                  <label>连接状态</label>
                  <strong>
                    <span className={`status-dot ${online ? 'green' : ''}`} />
                    {online ? 'Connector 已连接' : '等待 Connector 连接'}
                  </strong>
                </div>
                <div className="info-block">
                  <label>实例标识</label>
                  <code>{id}</code>
                </div>
                <div className="info-block">
                  <label>当前设备</label>
                  <strong>{identity.controller.name}</strong>
                  <small>{identity.controller.id.slice(0, 18)}</small>
                </div>
                <div className="info-block">
                  <label>写入租约</label>
                  <strong>
                    {holding
                      ? '本设备'
                      : occupied
                        ? controllerName(lease?.controllerId)
                        : '暂无持有者'}
                  </strong>
                  <small>
                    {leaseActive(lease, clock)
                      ? `Epoch ${lease?.epoch} · 到期自动释放`
                      : '每台实例同时仅一个设备可写入'}
                  </small>
                </div>
                <div className="inspector-note">
                  <ShieldCheck size={19} />
                  <strong>协作，无需抢占</strong>
                  <p>查看会话不会改变 DSH 状态。发送消息、审批和配置操作需要有效的控制租约</p>
                </div>
                <div className="inspector-footer">
                  <Globe2 size={15} /> 出站连接 · 无需暴露 DSH 端口
                </div>
              </aside>
            </div>
          </>
        ) : (
          <div className="welcome">
            <div className="hero-glyph">
              <Cpu size={34} />
            </div>
            <span className="eyebrow">YOUR WORKSPACE STARTS HERE</span>
            <h1>{search.instance ? '未找到此实例' : '连接你的第一台 DSH'}</h1>
            <p>
              {search.instance
                ? '实例可能不存在，或当前账户没有访问权限'
                : '注册一个实例，然后在运行 DSH 的机器上配置出站 Connector'}
            </p>
            <button className="primary" onClick={() => setModal('instance')}>
              <Plus size={17} />
              连接新实例
            </button>
          </div>
        )}
      </main>
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
      {modal === 'takeover' && (
        <Modal
          title="接管这个实例？"
          description={`${controllerName(lease?.controllerId)} 将立即失去写入权限，仍可查看会话。正在运行的 DSH 任务不会因此取消`}
          onClose={() => setModal(null)}
        >
          <div className="modal-actions">
            <button className="quiet" onClick={() => setModal(null)}>
              保持只读
            </button>
            <button
              className="primary"
              onClick={() => leaseMutation.mutate({ takeover: true })}
              disabled={leaseMutation.isPending}
            >
              {leaseMutation.isPending ? <Spinner /> : <KeyRound size={16} />}确认接管
            </button>
          </div>
        </Modal>
      )}
      {modal === 'session' && id && (
        <CreateSession
          instanceId={id}
          controllerId={identity.controller.id}
          lease={holding ? lease! : null}
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
          ? `${target.name} 的所有登录会话和写入租约将立即失效。${target.id === currentId ? '这是当前设备，确认后你将退出登录。' : '该设备需要重新登录才能访问。'}`
          : '每次登录建立独立设备身份。撤销后需要重新登录'
      }
      onClose={onClose}
      busy={mutation.isPending}
    >
      {target ? (
        <div className="modal-actions">
          <button className="quiet" disabled={mutation.isPending} onClick={() => setTarget(null)}>
            取消
          </button>
          <button
            className="primary"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(target)}
          >
            {mutation.isPending ? <Spinner /> : <Shield size={16} />}确认撤销
          </button>
        </div>
      ) : (
        <div className="device-list">
          {controllers.map((c) => (
            <div key={c.id}>
              <Monitor size={20} />
              <span>
                <strong>{c.name}</strong>
                <small>{c.id}</small>
                {c.id === currentId && <small>当前设备</small>}
              </span>
              {c.active === false || revoked.includes(c.id) ? (
                <span className="pill">登录已失效</span>
              ) : (
                <button className="quiet" onClick={() => setTarget(c)}>
                  撤销登录
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
      title={token ? '新的连接令牌' : '更换 Connector 凭据？'}
      description={
        token
          ? '新令牌只显示这一次，请安全保存'
          : `更换 ${instance.name} 的令牌会立即断开现有 Connector 并释放控制权。你需要在 DSH 主机更新令牌文件后重新连接`
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
          <p className="tiny">
            保存到主机权限 0600 的令牌文件，父目录权限 0700。插件只配置 connectorTokenFile
            绝对路径，不能内嵌令牌
          </p>
          <div className="modal-actions">
            <button
              className="quiet"
              onClick={() => {
                navigator.clipboard
                  ?.writeText(token)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? <Check size={16} /> : <Clipboard size={16} />}复制令牌
            </button>
            <button className="primary" onClick={onClose}>
              我已保存
            </button>
          </div>
        </>
      ) : (
        <div className="modal-actions">
          <button className="quiet" onClick={onClose} disabled={mutation.isPending}>
            取消
          </button>
          <button
            className="primary"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? <Spinner /> : <KeyRound size={16} />}确认更换
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
    [copied, setCopied] = useState(false),
    client = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      post<{ instance: Instance; connectorToken: string }>('/api/instances', { name }),
    onSuccess: (data) => {
      setCreated(data);
      void client.invalidateQueries({ queryKey: ['instances'] });
    },
  });
  return (
    <Modal
      busy={mutation.isPending}
      title={created ? '实例已创建' : '连接新实例'}
      description={
        created
          ? '保存一次性连接令牌，并在 DSH 主机上配置 Connector'
          : '实例属于当前账户，与其他账户隔离'
      }
      onClose={() => {
        if (created) onCreated(created.instance.id);
        onClose();
      }}
    >
      {created ? (
        <>
          <div className="token-warning">
            <KeyRound size={18} />
            <p>连接令牌只显示这一次。它允许 Connector 代表此实例连接，请勿分享或提交到 Git</p>
          </div>
          <label>
            实例 ID
            <input readOnly value={created.instance.id} />
          </label>
          <label>
            Connector 令牌
            <textarea readOnly rows={3} value={created.connectorToken} />
          </label>
          <button
            className="quiet wide"
            onClick={() => {
              navigator.clipboard
                .writeText(created.connectorToken)
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            {copied ? <Check size={16} /> : <Clipboard size={16} />}{' '}
            {copied ? '已复制令牌' : '复制连接令牌'}
          </button>
          <p className="tiny">
            在 DSH 主机上将令牌保存到权限为 0600 的文件，父目录权限为 0700。在插件配置的
            connectorTokenFile
            中填写此文件的绝对路径，不要将令牌直接写入插件配置。具体安装步骤见仓库 README
          </p>
          <div className="modal-actions">
            <button
              className="primary"
              onClick={() => {
                onCreated(created.instance.id);
                onClose();
              }}
            >
              我已保存，进入实例
              <ArrowRight size={16} />
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
            <button className="quiet" type="button" onClick={onClose} disabled={mutation.isPending}>
              取消
            </button>
            <button className="primary" disabled={mutation.isPending}>
              {mutation.isPending ? <Spinner /> : <Plus size={16} />}创建实例
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
    client = useQueryClient();
  const mutation = useMutation({
    mutationFn: async () => {
      if (!lease || !leaseActive(lease)) throw new Error('控制权已失效，请重新获取');
      const data = asRecord(
        await runCommand(
          instanceId,
          controllerId,
          'session.create',
          { sessionId: createdSessionId, ...(cwd.trim() ? { cwd: cwd.trim() } : {}) },
          lease.epoch,
        ),
      );
      if (typeof data.sessionId !== 'string') throw new Error('实例未返回会话标识');
      return data.sessionId;
    },
    onSuccess: (sid) => {
      void client.invalidateQueries({ queryKey: ['remote', instanceId, 'sessions'] });
      onCreated(sid);
    },
  });
  return (
    <Modal
      busy={mutation.isPending}
      title="新建会话"
      description="在选中实例上创建一个新的 DSH 会话"
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <label>
          工作目录 <span className="optional">可选</span>
          <input
            autoFocus
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="留空使用 DSH 默认目录"
          />
        </label>
        <p className="tiny">目录路径对应运行 DSH 的机器</p>
        <Err error={mutation.error} />
        <div className="modal-actions">
          <button type="button" className="quiet" onClick={onClose} disabled={mutation.isPending}>
            取消
          </button>
          <button className="primary" disabled={!lease || mutation.isPending}>
            {mutation.isPending ? <Spinner /> : <Plus size={16} />}创建会话
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
  const client = useQueryClient(),
    [prompt, setPrompt] = useState(''),
    [mode, setMode] = useState<'queue' | 'steer'>('queue'),
    [modelOpen, setModelOpen] = useState(false),
    [files, setFiles] = useState<{ name: string; content: Record<string, unknown> }[]>([]),
    [uploading, setUploading] = useState(false),
    [uploadError, setUploadError] = useState(''),
    [approvalBusy, setApprovalBusy] = useState<string | null>(null),
    [queueBusy, setQueueBusy] = useState<string | null>(null),
    [queueEdit, setQueueEdit] = useState<{ item: unknown; text: string } | null>(null),
    [actionError, setActionError] = useState(''),
    [autoScroll, setAutoScroll] = useState(true);
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
  const canWrite = !!lease && leaseActive(lease) && online;
  async function write(action: string, args: Record<string, unknown>, commandId?: string) {
    if (!lease || !leaseActive(lease)) throw new Error('控制权已失效，请重新获取');
    const result = await runCommand(
      id,
      controller.id,
      action,
      args,
      lease.epoch,
      undefined,
      commandId,
    );
    void client.invalidateQueries({ queryKey: ['remote', id] });
    return result;
  }
  const send = useMutation({
    mutationFn: async () => {
      if (submissionLock.current) throw new Error('消息正在提交');
      submissionLock.current = true;
      const content = [
        ...(prompt.trim() ? [{ type: 'text', text: prompt.trim() }] : []),
        ...files.map((f) => f.content),
      ];
      const fingerprint = JSON.stringify({ content, mode });
      if (submission.current?.fingerprint !== fingerprint)
        submission.current = {
          fingerprint,
          requestId: crypto.randomUUID(),
          commandId: crypto.randomUUID(),
        };
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
        );
      } finally {
        submissionLock.current = false;
      }
    },
    onSuccess: () => {
      submission.current = null;
      setPrompt('');
      setFiles([]);
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
        <div>
          <strong>{summary ? sessionLabel(summary) : sessionId.slice(0, 20)}</strong>
          <span>{summary?.cwd ?? String(asRecord(data.header).cwd ?? sessionId)}</span>
        </div>
        <button
          className="icon-button"
          title="刷新历史"
          aria-label="刷新历史"
          onClick={() => void history.refetch()}
          disabled={history.isFetching || !online}
        >
          <RefreshCw size={16} className={history.isFetching ? 'spin' : ''} />
        </button>
      </div>
      {!online && (
        <div className="offline-banner">实例已离线。已加载历史仍可查看，连接恢复后自动同步</div>
      )}
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
            <Spinner /> 读取会话历史…
          </div>
        ) : null}
        <Err error={history.error} />
        {!history.isPending && !messages.length && !streamText ? (
          <Empty icon={<MessageSquare size={25} />} title="一个新的开始">
            写下你的目标、问题或任务，DSH 会从这里开始
          </Empty>
        ) : null}
        {messages.map(({ event, message }) => (
          <article
            key={event.seq}
            className={`message ${message!.role === '你' ? 'user-message' : ''}`}
          >
            <div className="message-avatar">
              {message!.role === '你' ? (
                <span>你</span>
              ) : message!.role === 'DSH' ? (
                <Terminal size={17} />
              ) : (
                <Settings2 size={16} />
              )}
            </div>
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
        ))}
        {streamText && (
          <article className="message live-message">
            <div className="message-avatar">
              <Terminal size={17} />
            </div>
            <div className="message-content">
              <header>
                <strong>DSH</strong>
                <span>
                  <span className="status-dot pulse" />{' '}
                  {stream?.incomplete ? '实时片段 · 完整内容将在结束后同步' : '实时输出'}
                </span>
              </header>
              <div className="message-text">
                {streamText}
                <span className="cursor" />
              </div>
            </div>
          </article>
        )}
        {pending.size > 0 &&
          [...pending.values()].map((approval) => (
            <div className="approval-card" key={String(approval.approvalId)}>
              <div>
                <Shield size={19} />
                <strong>等待你的审批</strong>
                <span className="pill">仅本次</span>
              </div>
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
                  className="quiet"
                  disabled={!canWrite || !!approvalBusy}
                  onClick={() => void approve(approval, 'rejected')}
                >
                  拒绝
                </button>
                <button
                  className="primary small"
                  disabled={
                    !canWrite ||
                    !!approvalBusy ||
                    (!!approval.callId && !toolCallForApproval(approval, wireEvents))
                  }
                  onClick={() => void approve(approval, 'allowed-once')}
                >
                  {approvalBusy === approval.approvalId ? <Spinner /> : <Check size={15} />}允许本次
                </button>
              </div>
            </div>
          ))}
      </div>
      {!autoScroll && (
        <button className="scroll-latest" onClick={() => setAutoScroll(true)}>
          <ArrowDown size={14} />
          最新消息
        </button>
      )}
      {queued.length > 0 && (
        <div className="queue-list">
          <div className="eyebrow">待处理队列 · {queued.length}</div>
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
      <div className="composer-area">
        <Err error={send.error || cancel.error || resume.error || uploadError || actionError} />
        {!canWrite && (
          <div className="view-only">
            <Shield size={14} />
            {online ? '只读模式 · 获取控制权后可发送消息与处理审批' : '实例离线 · 等待重新连接'}
          </div>
        )}
        <form
          className={`composer ${!canWrite ? 'disabled' : ''}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (canWrite && (prompt.trim() || files.length) && !send.isPending) send.mutate();
          }}
        >
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
              canWrite ? '描述任务，或告诉 DSH 下一步该怎么做…' : '先获取控制权，再开始对话'
            }
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={!canWrite || send.isPending}
            rows={3}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (canWrite && (prompt.trim() || files.length) && !send.isPending) send.mutate();
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
                <option value="queue">排队发送</option>
                <option value="steer">下一步引导</option>
              </select>
              {running && (
                <button
                  type="button"
                  className="stop-button"
                  title="停止任务"
                  disabled={!canWrite || cancel.isPending}
                  onClick={() => cancel.mutate()}
                >
                  {cancel.isPending ? <Spinner /> : <Square size={13} />}
                </button>
              )}
              <button
                className="send-button"
                aria-label="发送消息"
                title="发送 · Ctrl / ⌘ + Enter"
                disabled={
                  !canWrite || send.isPending || uploading || (!prompt.trim() && !files.length)
                }
              >
                {send.isPending ? <Spinner /> : <Send size={17} />}
              </button>
            </div>
          </div>
        </form>
        <div className="composer-footer">
          <span>
            {mode === 'steer' ? 'Steer 在下一个步骤边界生效' : '消息进入 DSH 会话队列'} · Ctrl / ⌘ +
            Enter 发送
          </span>
          {data.agentAvailable === false && (
            <button
              className="text-button"
              disabled={!canWrite || resume.isPending}
              onClick={() => resume.mutate()}
            >
              恢复运行环境
            </button>
          )}
        </div>
      </div>
      {queueEdit && (
        <Modal
          title="编辑待处理消息"
          description="只能修改尚未消费的队列文本"
          busy={!!queueBusy}
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
              <button
                type="button"
                className="quiet"
                onClick={() => setQueueEdit(null)}
                disabled={!!queueBusy}
              >
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
function ModelSettings({
  instanceId,
  sessionId,
  controllerId,
  canWrite,
  write,
  current,
  onClose,
}: {
  instanceId: string;
  sessionId: string;
  controllerId: string;
  canWrite: boolean;
  write: (action: string, args: Record<string, unknown>) => Promise<unknown>;
  current: Record<string, unknown>;
  onClose: () => void;
}) {
  const [permission, setPermission] = useState(''),
    [preset, setPreset] = useState(''),
    [provider, setProvider] = useState(String(current.provider ?? '')),
    [model, setModel] = useState(String(current.model ?? '')),
    [effort, setEffort] = useState(String(current.reasoningEffort ?? ''));
  const settings = useQuery({
    queryKey: ['remote', instanceId, 'settings', sessionId],
    queryFn: ({ signal }) =>
      runCommand(instanceId, controllerId, 'settings.describe', { sessionId }, undefined, signal),
  });
  const catalog = asRecord(asRecord(settings.data).modelCatalog),
    groups = asList(catalog, 'groups'),
    models = asList(
      groups.find((g) => asRecord(g).id === provider),
      'models',
    ),
    modelMeta = asRecord(models.find((m) => asRecord(m).id === model)),
    efforts = asList(asRecord(modelMeta.reasoning), 'efforts');
  const settingsMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      write('settings.update', {
        sessionId,
        [key]: value,
        expectedRevision: asRecord(asRecord(settings.data).projections).asOfSeq,
      }),
    onSuccess: () => {
      setPermission('');
      setPreset('');
      void settings.refetch();
    },
  });
  const mutation = useMutation({
    mutationFn: () =>
      write('model.select', {
        sessionId,
        provider,
        model,
        ...(effort ? { reasoningEffort: effort } : {}),
      }),
    onSuccess: onClose,
  });
  useEffect(() => {
    if (!provider && catalog.default) {
      const value = asRecord(catalog.default);
      setProvider(String(value.provider ?? ''));
      setModel(String(value.model ?? ''));
      setEffort(String(value.reasoningEffort ?? ''));
    }
  }, [catalog.default, provider]);
  return (
    <Modal
      title="模型与配置"
      description="配置来自当前 DSH 实例。选择模型同时更新 DSH 的默认模型设置"
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        {settings.isPending && (
          <div className="subtle-loading">
            <Spinner />
            读取模型目录…
          </div>
        )}
        <Err error={settings.error} />
        <label>
          提供商
          {groups.length ? (
            <select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setModel('');
                setEffort('');
              }}
            >
              <option value="" disabled>
                选择提供商
              </option>
              {groups.map((g) => (
                <option key={String(asRecord(g).id)} value={String(asRecord(g).id)}>
                  {String(asRecord(g).name ?? asRecord(g).id)}
                </option>
              ))}
            </select>
          ) : (
            <input
              required
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              placeholder="提供商标识"
            />
          )}
        </label>
        <label>
          模型
          {models.length ? (
            <select
              required
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setEffort('');
              }}
            >
              <option value="" disabled>
                选择模型
              </option>
              {models.map((m) => (
                <option key={String(asRecord(m).id)} value={String(asRecord(m).id)}>
                  {String(asRecord(m).name ?? asRecord(m).id)}
                </option>
              ))}
            </select>
          ) : (
            <input
              required
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="模型标识"
            />
          )}
        </label>
        <label>
          推理强度 <span className="optional">可选</span>
          {efforts.length ? (
            <select value={effort} onChange={(e) => setEffort(e.target.value)}>
              <option value="">使用默认值</option>
              {efforts.map((e) => (
                <option key={String(asRecord(e).id)} value={String(asRecord(e).id)}>
                  {String(asRecord(e).name ?? asRecord(e).id)}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={effort}
              onChange={(e) => setEffort(e.target.value)}
              placeholder="留空使用模型默认值"
            />
          )}
        </label>
        {asList(catalog, 'failures').map((f) => (
          <Err key={String(asRecord(f).id)} error={`${asRecord(f).name}: ${asRecord(f).message}`} />
        ))}
        <details className="config-details">
          <summary>权限与 Agent 预设</summary>
          <p className="tiny">只显示主机允许远程选择的预设。Agent 预设仅能在首轮任务前更改</p>
          <label>
            权限预设
            <select value={permission} onChange={(e) => setPermission(e.target.value)}>
              <option value="">选择权限预设</option>
              {asList(settings.data, 'allowedPermissionPresets').map((p) => (
                <option key={String(p)} value={String(p)}>
                  {String(p)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="quiet"
            disabled={!canWrite || !permission || settingsMutation.isPending}
            onClick={() => settingsMutation.mutate({ key: 'permissionPreset', value: permission })}
          >
            应用权限
          </button>
          <label>
            Agent 预设
            <select value={preset} onChange={(e) => setPreset(e.target.value)}>
              <option value="">选择 Agent 预设</option>
              {asList(settings.data, 'allowedAgentPresets').map((p) => (
                <option key={String(p)} value={String(p)}>
                  {String(p)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="quiet"
            disabled={!canWrite || !preset || settingsMutation.isPending}
            onClick={() => settingsMutation.mutate({ key: 'agentPreset', value: preset })}
          >
            应用预设
          </button>
          <Err error={settingsMutation.error} />
        </details>
        <details className="config-details">
          <summary>查看实例配置快照</summary>
          <pre>{JSON.stringify(asRecord(settings.data).projections ?? {}, null, 2)}</pre>
        </details>
        <Err error={mutation.error} />
        <div className="modal-actions">
          <button className="quiet" type="button" onClick={onClose} disabled={mutation.isPending}>
            取消
          </button>
          <button
            className="primary"
            disabled={!canWrite || mutation.isPending || !provider || !model}
          >
            {mutation.isPending ? <Spinner /> : <Check size={16} />}应用配置
          </button>
        </div>
      </form>
    </Modal>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
