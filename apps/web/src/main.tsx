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
  Clock,
  GitHubMark,
  User,
  Warn,
  Attach,
} from './icons';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { TooltipProvider } from '@/components/ui/tooltip';
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
import { setInstanceLease, useEvents, type PendingApproval, type LiveStream } from './use-events';
import { Actions, Empty, Err, Field, Modal, NativeSelect, Spinner } from './ui';
import { ModelSettings } from './model-settings';
import { RepositoryPanel } from './repository-panel';
import { getReferences, contextPreview, repositoryIdsForPrompt } from './repositories';
import { readDraft, saveDraft } from './drafts';
import { OperationsProvider, RecoveryPanel, useOperations } from './operations';
import {
  PairInstance,
  PairingLanding,
  PairingPanel,
  CopyField,
  usePluginPackage,
  requestPairing,
  type Pairing,
} from './pairing';
import { WorkspacePicker } from './workspace-picker';
import './index.css';
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
/** DSH-style wordmark: the brand face plus a badge, like DSH's "deepseek [HARNESS]". */
const Brand = ({ className }: { className?: string }) => (
  <div className={cn('flex items-center gap-1.5 select-none', className)} aria-label="DSH Remote">
    <span className="font-brand text-[19px] leading-none font-medium tracking-[-0.01em] text-foreground">
      DSH
    </span>
    <span className="rounded-[5px] bg-foreground px-1.5 py-[3px] font-brand text-[9px] leading-none font-medium tracking-[0.12em] text-background">
      REMOTE
    </span>
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
      <main className="grid min-h-dvh place-items-center text-caption" aria-label="正在连接">
        <Spinner className="size-5" />
      </main>
    );
  if (!me.data)
    return (
      <Auth error={me.error instanceof ApiError && me.error.status === 401 ? null : me.error} />
    );
  return (
    <OperationsProvider key={me.data.user.id} accountId={me.data.user.id}>
      <TooltipProvider delayDuration={300}>
        <Console identity={me.data} />
      </TooltipProvider>
    </OperationsProvider>
  );
}
/** Outcome of a "Sign in with GitHub" round trip, read once and removed from the address bar. */
function takeGitHubOutcome() {
  const value = new URLSearchParams(location.search).get('github');
  if (value) history.replaceState(history.state, '', location.pathname);
  return value;
}
function Auth({ error }: { error: unknown }) {
  const [githubOutcome] = useState(takeGitHubOutcome);
  const client = useQueryClient(),
    [register, setRegister] = useState(githubOutcome === 'INVITE_REQUIRED'),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [deviceName, setDeviceName] = useState('Web 控制台'),
    [inviteCode, setInviteCode] = useState(''),
    [authNotice, setAuthNotice] = useState('');
  // Older relays omit the mode; they behave as open registration.
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () =>
      api<{ registration?: 'open' | 'invite' | 'closed'; githubSignIn?: boolean }>('/health'),
    staleTime: 60_000,
  });
  const registration = health.data?.registration ?? 'open';
  const github = useMutation({
    mutationFn: () =>
      api<{ authorizationUrl: string }>('/api/auth/github', {
        method: 'POST',
        body: JSON.stringify({
          deviceName,
          ...(register && registration === 'invite' && inviteCode.trim() ? { inviteCode } : {}),
        }),
      }),
    onSuccess: ({ authorizationUrl }) => location.assign(authorizationUrl),
  });
  const githubError =
    !githubOutcome || githubOutcome === 'signed_in'
      ? null
      : {
          code:
            githubOutcome === 'cancelled'
              ? 'GITHUB_CANCELLED'
              : githubOutcome === 'INVITE_REQUIRED'
                ? 'GITHUB_INVITE_REQUIRED'
                : githubOutcome,
        };
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
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 py-12 max-sm:items-start max-sm:pt-16">
      <form
        className="grid w-full max-w-[380px] gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <Brand className="mb-6" />
        <div className="grid gap-1.5">
          <h1 key={register ? 'register' : 'login'} className="swap text-2xl font-medium">
            {register ? '创建账户' : '登录'}
          </h1>
          <p className="text-base text-muted-foreground">
            {register ? '注册后即可连接和控制你的 DSH 实例。' : '连接和控制你的 DSH 实例。'}
          </p>
        </div>
        <div className="grid gap-4">
          <Field label="邮箱">
            <Input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </Field>
          <Field label="密码">
            <Input
              type="password"
              minLength={8}
              autoComplete={register ? 'new-password' : 'current-password'}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={register ? '至少 8 个字符' : ''}
            />
          </Field>
          <Field label="设备名称">
            <Input
              required
              maxLength={80}
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              autoComplete="off"
            />
          </Field>
          {register && registration === 'invite' && (
            <Field label="邀请码" className="swap">
              <Input
                required
                maxLength={200}
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                autoComplete="off"
              />
            </Field>
          )}
        </div>
        <Err
          error={
            mutation.error ||
            github.error ||
            (mutation.isIdle && github.isIdle ? githubError : null) ||
            error
          }
        />
        <div className="grid gap-2.5">
          <Button size="lg" disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner /> : null}
            {register ? '创建账户' : '登录'}
          </Button>
          {health.data?.githubSignIn && !mutation.isPending ? (
            <Button
              type="button"
              size="lg"
              variant="outline"
              disabled={github.isPending || github.isSuccess}
              onClick={() => github.mutate()}
            >
              {github.isPending || github.isSuccess ? <Spinner /> : <GitHubMark />}
              使用 GitHub 继续
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-1 text-base text-muted-foreground">
          {mutation.isPending ? (
            <Button
              variant="link"
              type="button"
              onClick={() => {
                authAttempt.current += 1;
                authAbort.current?.abort();
                setAuthNotice('已停止等待。登录或注册可能已在服务端完成');
              }}
            >
              停止等待
            </Button>
          ) : registration !== 'closed' || register ? (
            <>
              <span>{register ? '已有账户？' : '还没有账户？'}</span>
              <Button
                variant="link"
                type="button"
                onClick={() => {
                  setRegister(!register);
                  mutation.reset();
                }}
              >
                {register ? '已有账户，登录' : '创建账户'}
              </Button>
            </>
          ) : null}
        </div>
        {authNotice && (
          <div
            className="swap flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-accent px-3 py-2 text-sm text-muted-foreground"
            role="status"
          >
            {authNotice}
            <Button
              variant="link"
              type="button"
              className="text-sm"
              onClick={() => void client.invalidateQueries({ queryKey: ['me'] })}
            >
              查询登录状态
            </Button>
          </div>
        )}
      </form>
    </main>
  );
}
function Console({ identity }: { identity: Identity }) {
  // Accounts created through GitHub carry a placeholder address; their GitHub login reads better.
  const accountName =
    identity.user.github && identity.user.email.endsWith('@users.noreply.github.com')
      ? identity.user.github
      : identity.user.email;
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
    // Bumped by timers to re-render when time changes what is shown (see below).
    [, setClock] = useState(0),
    [tab, setTab] = useState<'conversation' | 'repositories'>('conversation'),
    [writeSuspended, setWriteSuspended] = useState(false),
    // Instances this tab only watches: control was declined, released or taken by another device.
    [viewOnly, setViewOnly] = useState<Record<string, true>>({}),
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
    // Back from installing the GitHub App: GitHub appends installation_id and setup_action.
    const params = new URLSearchParams(location.search);
    if (params.has('setup_action') || params.has('installation_id')) {
      setTab('repositories');
      setNotice('GitHub 安装已更新，正在读取可映射的仓库');
      void client.invalidateQueries({ queryKey: ['github'] });
      void navigate({
        search: { instance: search.instance, session: search.session },
        replace: true,
      });
      return;
    }
    const result = params.get('github');
    if (!result) return;
    // A completed "Sign in with GitHub" lands here signed in; nothing to report.
    if (result === 'signed_in') {
      void navigate({
        search: { instance: search.instance, session: search.session },
        replace: true,
      });
      return;
    }
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
  // While the event stream is live it says what changed; polling is only its fallback, since
  // every poll is a billed relay request (and host reads cost a relayed command each).
  const eventStream = useEvents(true);
  const polling = eventStream.state !== 'live';
  const instances = useQuery({
    queryKey: ['instances'],
    queryFn: () => api<{ instances: Instance[] }>('/api/instances'),
    refetchInterval: polling ? 10000 : false,
  });
  const controllers = useQuery({
    queryKey: ['controllers'],
    queryFn: () => api<{ controllers: Controller[] }>('/api/controllers'),
  });
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
      leaseActive(lease, Date.now()) &&
      lease?.controllerId === identity.controller.id,
    occupied = leaseActive(lease, Date.now()) && lease?.controllerId !== identity.controller.id;
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
    refetchInterval: polling ? 15000 : false,
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
      const next = afterControl.current;
      afterControl.current = null;
      if (selectedInstance.current !== target) return;
      setWriteSuspended(false);
      setModal((current) => (current === 'takeover' ? null : current));
      setNotice('');
      next?.();
    },
    onError: (error) => {
      afterControl.current = null;
      if (selectedInstance.current === leaseRequestTarget.current) setNotice(errorText(error));
      void client.invalidateQueries({ queryKey: ['instances'] });
    },
  });
  /** What to do once control is ours, e.g. open "新建会话" after a takeover. */
  const afterControl = useRef<(() => void) | null>(null);
  // Effects in the same commit must see a choice before React re-renders with it.
  const viewOnlyNow = useRef(viewOnly);
  viewOnlyNow.current = viewOnly;
  const watchOnly = (instanceId: string | undefined, watching: boolean) => {
    if (!instanceId) return;
    const { [instanceId]: _, ...rest } = viewOnlyNow.current;
    viewOnlyNow.current = watching ? { ...rest, [instanceId]: true } : rest;
    setViewOnly(viewOnlyNow.current);
  };
  const takeControl = () => {
    watchOnly(id, false);
    if (occupied) setModal('takeover');
    else leaseMutation.mutate({});
  };
  const declineTakeover = () => {
    afterControl.current = null;
    watchOnly(id, true);
    setModal(null);
  };
  const startSession = () => {
    if (holding) return setModal('session');
    afterControl.current = () => setModal('session');
    takeControl();
  };
  const logout = useMutation({
    mutationFn: () => post('/api/auth/logout', {}),
    onSuccess: () => {
      sessionStorage.removeItem('dsh.controller');
      client.setQueryData(['me'], null);
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' });
    },
  });
  // Re-render on time only when time changes what is shown: the reconnect countdown, or the
  // moment a lease expires. A once-a-second tick of the whole console costs CPU for nothing.
  useEffect(() => {
    if (eventStream.state !== 'live' && eventStream.health.nextRetryAt) {
      const timer = setInterval(() => setClock(Date.now()), 1000);
      return () => clearInterval(timer);
    }
    const expires = lease?.expiresAt ? new Date(lease.expiresAt).getTime() - Date.now() : 0;
    if (expires <= 0) return;
    // Renewals are pushed; an expiry still shown means none came, so check with the relay.
    const timer = setTimeout(() => {
      setClock(Date.now());
      void client.invalidateQueries({ queryKey: ['instances'] });
    }, expires + 50);
    return () => clearTimeout(timer);
  }, [eventStream.state, eventStream.health.nextRetryAt, lease?.expiresAt]);
  useEffect(() => {
    if (!holding || !id) return;
    let running = false;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible' || running) return;
      running = true;
      post<Lease>(`/api/instances/${id}/lease`, { controllerId: identity.controller.id })
        .then((next) => setInstanceLease(client, id, next))
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
    retryIn = eventStream.health.nextRetryAt
      ? Math.max(0, Math.ceil((eventStream.health.nextRetryAt - Date.now()) / 1000))
      : 0,
    statusText = !instance
      ? ''
      : streamLive
        ? statusLabel(instance)
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
  const leaseHolder = leaseActive(lease, Date.now()) ? lease?.controllerId : undefined,
    previousHolder = useRef({ id, holder: leaseHolder });
  useEffect(() => {
    const before = previousHolder.current;
    previousHolder.current = { id, holder: leaseHolder };
    // A device that logged in after this list loaded would otherwise show only as a raw ID.
    const known = controllers.data?.controllers.some((c) => c.id === leaseHolder);
    const names = leaseHolder && !known ? controllers.refetch() : undefined;
    if (
      before.id === id &&
      before.holder === identity.controller.id &&
      leaseHolder &&
      leaseHolder !== identity.controller.id
    ) {
      // Never take it straight back: two tabs would push each other off forever.
      watchOnly(id, true);
      const announce = (list?: Controller[]) =>
        setNotice(
          `${list?.find((c) => c.id === leaseHolder)?.name ?? '另一台设备'} 已接管控制，当前为只读`,
        );
      if (names) void names.then((result) => announce(result.data?.controllers));
      else announce(controllers.data?.controllers);
    }
  }, [id, leaseHolder]);
  // Connecting takes control, as in remote-desktop clients: a free instance is controlled at once;
  // one another device controls asks first whether to push that device off. Each lease state is
  // handled once, and an instance the person chose to only watch is left alone. Declared after the
  // takeover check above, so a device that was just pushed off never prompts to push back.
  const autoControlled = useRef('');
  useEffect(() => {
    if (!id || !online || !streamLive || viewOnlyNow.current[id] || modal) return;
    if (leaseMutation.isPending || lease?.controllerId === identity.controller.id) return;
    const key = `${id}:${lease?.controllerId ?? ''}:${lease?.epoch ?? 0}`;
    if (autoControlled.current === key) return;
    autoControlled.current = key;
    if (leaseActive(lease, Date.now())) setModal('takeover');
    else leaseMutation.mutate({});
  }, [
    id,
    online,
    streamLive,
    viewOnly,
    modal,
    lease?.controllerId,
    lease?.epoch,
    lease?.expiresAt,
  ]);
  const sidebarRow =
    'flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-base text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-45';
  return (
    <div className="shell flex h-dvh overflow-hidden bg-background" data-stream={eventStream.state}>
      <aside
        className={cn(
          'sidebar flex w-[280px] shrink-0 flex-col gap-1 border-r-[0.8px] border-sidebar-border bg-sidebar px-3 pt-4 pb-3',
          'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:w-[min(300px,86vw)] max-md:shadow-panel max-md:transition-transform max-md:duration-200 max-md:ease-ds',
          mobileMenu ? 'open max-md:translate-x-0' : 'max-md:-translate-x-full max-md:invisible',
        )}
      >
        <div className="mb-3 flex h-8 items-center justify-between px-2">
          <Brand />
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            onClick={() => setMobileMenu(false)}
            aria-label="关闭导航"
          >
            <X size={16} />
          </Button>
        </div>
        <label className="relative mb-1 flex h-10 items-center rounded-lg border-[0.8px] border-border bg-outline-fill transition-colors focus-within:ring-[3px] focus-within:ring-ring hover:bg-accent">
          <span
            className={cn(
              'pointer-events-none absolute left-3 size-2 rounded-full',
              instance && instanceStatus(instance) === 'online'
                ? 'bg-success'
                : instance && instanceStatus(instance) !== 'offline'
                  ? 'bg-warning'
                  : 'bg-caption',
            )}
          />
          <select
            aria-label="选择实例"
            className="h-full w-full cursor-pointer appearance-none truncate bg-transparent pr-8 pl-8 text-base font-medium text-foreground outline-none"
            value={id ?? ''}
            onChange={(e) =>
              e.target.value === NEW_INSTANCE
                ? setModal('instance')
                : switchInstance(e.target.value)
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
          <ChevronDown size={14} className="pointer-events-none absolute right-3 text-caption" />
        </label>
        <Button
          variant="outline"
          className="h-[38px] w-full"
          disabled={!online || !streamLive || leaseMutation.isPending}
          onClick={startSession}
        >
          <Plus size={16} />
          新建会话
        </Button>
        <button
          className={cn(sidebarRow, 'mt-2', tab === 'repositories' && 'bg-accent-active')}
          onClick={() => {
            setTab('repositories');
            setMobileMenu(false);
          }}
        >
          <GitHubMark size={16} className="text-muted-foreground" />
          GitHub 仓库
        </button>
        <div className="mt-4 mb-1 px-2 text-base text-caption">会话</div>
        <nav className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1" aria-label="会话列表">
          {sessions.isPending && online ? (
            <div className="px-2 py-2 text-caption">
              <Spinner />
            </div>
          ) : sessions.error ? (
            <Err error={sessions.error} />
          ) : sessions.data?.length ? (
            <div className="grid gap-0.5">
              {sessions.data.map((s) => {
                const active = sessionId === s.sessionId && tab !== 'repositories';
                return (
                  <button
                    key={s.sessionId}
                    className={cn(
                      'group flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-[7px] text-left transition-colors hover:bg-accent',
                      active && 'bg-accent-active',
                    )}
                    onClick={() => selectSession(s.sessionId)}
                  >
                    <strong className="min-w-0 flex-1 truncate text-base font-normal text-foreground">
                      {sessionLabel(s)}
                    </strong>
                    <small
                      className={cn(
                        'shrink-0 text-xs',
                        s.running ? 'flex items-center gap-1 text-success' : 'text-caption',
                      )}
                    >
                      {s.running ? (
                        <>
                          <span className="size-1.5 animate-pulse rounded-full bg-success" />
                          运行中
                        </>
                      ) : s.updatedAt ? (
                        new Date(s.updatedAt).toLocaleString('zh-CN', {
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      ) : (
                        ''
                      )}
                    </small>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="px-2 py-1 text-base text-caption">{online ? '暂无会话' : '实例离线'}</p>
          )}
        </nav>
        <button
          className="mt-1 flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent"
          aria-label="账户与设置"
          onClick={() => {
            setModal('settings');
            setMobileMenu(false);
          }}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-sm font-medium text-background">
            {accountName[0]?.toUpperCase()}
          </span>
          <span className="grid min-w-0 flex-1">
            <strong className="truncate text-base font-medium">{accountName}</strong>
            <small className="truncate text-xs text-caption">{identity.controller.name}</small>
          </span>
          <Settings2 size={16} className="text-caption" />
        </button>
      </aside>
      {mobileMenu && (
        <button
          className="fixed inset-0 z-30 bg-overlay md:hidden"
          aria-label="关闭导航"
          onClick={() => setMobileMenu(false)}
        />
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 px-6 max-md:px-3">
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            onClick={() => setMobileMenu(true)}
            aria-label="打开导航"
            aria-expanded={mobileMenu}
          >
            <Menu size={18} />
          </Button>
          {instance ? (
            <>
              <h1 className="min-w-0 truncate text-md leading-5 font-medium">{instance.name}</h1>
              <button
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-sm leading-5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => (streamLive ? setModal('status') : eventStream.retry())}
                aria-label={streamLive ? `实例状态：${statusText}` : `${statusText}，点击立即重连`}
              >
                <span
                  className={cn(
                    'size-2 rounded-full',
                    !streamLive
                      ? 'animate-pulse bg-warning'
                      : instanceStatus(instance) === 'online'
                        ? 'bg-success'
                        : instanceStatus(instance) === 'offline'
                          ? 'bg-caption'
                          : 'bg-warning',
                  )}
                />
                <span key={statusKey} className="swap whitespace-nowrap">
                  {statusText}
                </span>
              </button>
              {online && streamLive ? (
                <div className="ml-auto flex min-w-0 items-center gap-2">
                  {occupied && (
                    <span className="swap truncate text-sm text-muted-foreground max-sm:hidden">
                      {controllerName(lease?.controllerId)} 控制中
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant={
                      controlState === 'held'
                        ? 'secondary'
                        : controlState === 'acquire'
                          ? 'default'
                          : 'outline'
                    }
                    className={cn('group min-w-[84px]', controlState === 'held' && 'text-success')}
                    disabled={leaseMutation.isPending}
                    title={holding ? '控制中，自动续期' : undefined}
                    aria-label={holding ? '控制中，点击释放' : undefined}
                    onClick={() => {
                      if (!holding) return takeControl();
                      watchOnly(id, true);
                      leaseMutation.mutate({ release: true });
                    }}
                  >
                    {controlState === 'pending' ? (
                      <span className="swap flex items-center gap-1.5" key="pending">
                        <Spinner />
                        确认中
                      </span>
                    ) : controlState === 'held' ? (
                      <span className="swap flex items-center gap-1.5" key="held">
                        <span className="flex items-center gap-1.5 group-hover:hidden">
                          <Check size={14} />
                          控制中
                        </span>
                        <span className="hidden text-foreground group-hover:inline">释放</span>
                      </span>
                    ) : controlState === 'occupied' ? (
                      <span className="swap" key="occupied">
                        接管
                      </span>
                    ) : (
                      <span className="swap" key="acquire">
                        开始控制
                      </span>
                    )}
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
        </header>
        {notice && (
          <div className="px-6 max-md:px-3">
            <div
              className="swap mx-auto flex max-w-[760px] items-center gap-2 rounded-lg bg-accent py-2 pr-1.5 pl-3 text-sm text-foreground"
              role="status"
            >
              <span className="min-w-0 flex-1">{notice}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setNotice('')}
                aria-label="关闭提示"
              >
                <X size={14} />
              </Button>
            </div>
          </div>
        )}
        <Err error={instances.error} className="mx-6 mt-2" />
        {instance ? (
          <>
            <RecoveryPanel instanceId={id} />
            <section className="flex min-h-0 flex-1 flex-col">
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
                  live={streamLive}
                  events={events}
                  approvals={eventStream.approvals.filter(
                    (a) => a.instanceId === id && a.sessionId === sessionId,
                  )}
                  stream={eventStream.streams[`${id}:${sessionId}`]}
                  summary={selected}
                  notify={setNotice}
                />
              ) : online ? (
                <Landing
                  icon={<Plus size={20} />}
                  title="选择或新建会话"
                  text="会话在这台 DSH 实例上运行，这里实时同步，可随时接手。"
                >
                  <Button disabled={!streamLive || leaseMutation.isPending} onClick={startSession}>
                    <Plus size={16} />
                    新建会话
                  </Button>
                </Landing>
              ) : (
                <Landing
                  icon={<Clock size={20} />}
                  title="等待实例上线"
                  text="在 DSH 的插件页安装 DSH Remote，再用配对链接连接这台实例。"
                >
                  <Button onClick={() => setModal('pair')}>配对</Button>
                </Landing>
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
          <Landing
            icon={<Plus size={20} />}
            title={search.instance ? '未找到此实例' : '连接你的第一台 DSH'}
            text={
              search.instance
                ? '实例可能不存在，或当前账户没有访问权限。'
                : '添加实例后，用配对链接把运行 DSH 的电脑连接进来。'
            }
            heading="h1"
          >
            <Button onClick={() => setModal('instance')}>连接新实例</Button>
          </Landing>
        )}
      </main>
      {modal === 'settings' && (
        <Modal title="设置" onClose={() => setModal(null)} busy={logout.isPending}>
          <Field label="外观">
            <NativeSelect
              aria-label="外观"
              value={theme}
              onChange={(e) => setTheme(e.target.value as typeof theme)}
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </NativeSelect>
          </Field>
          <Err error={logout.error} />
          <Actions>
            <Button onClick={() => setModal(null)}>完成</Button>
            <Button variant="outline" onClick={() => setModal('devices')}>
              控制设备
            </Button>
            <Button variant="quiet" disabled={logout.isPending} onClick={() => logout.mutate()}>
              退出登录
            </Button>
          </Actions>
        </Modal>
      )}
      {modal === 'status' && instance && (
        <Modal title={instance.name} onClose={() => setModal(null)}>
          <dl className="grid grid-cols-[96px_1fr] gap-x-4 gap-y-2.5 text-base">
            <dt className="text-caption">状态</dt>
            <dd>{statusLabel(instance)}</dd>
            <dt className="text-caption">最近心跳</dt>
            <dd>{timeLabel(instance.lastSeenAt)}</dd>
            <dt className="text-caption">连接于</dt>
            <dd>{timeLabel(instance.connectedAt)}</dd>
            <dt className="text-caption">断开于</dt>
            <dd>{timeLabel(instance.disconnectedAt)}</dd>
            <dt className="text-caption">控制设备</dt>
            <dd>
              {leaseActive(lease) ? controllerName(lease?.controllerId) : '无'}
              {lease?.pending ? '（等待主机确认）' : ''}
            </dd>
            <dt className="text-caption">实例 ID</dt>
            <dd className="min-w-0 font-mono text-sm break-all text-muted-foreground">
              {instance.id}
            </dd>
          </dl>
          <details className="group rounded-lg bg-accent/60 px-3 py-2">
            <summary className="cursor-pointer text-sm text-muted-foreground select-none">
              事件 {events.length}
            </summary>
            <EventLog events={events} />
          </details>
          <Err error={instances.error} />
          <Actions>
            <Button onClick={() => setModal(null)}>完成</Button>
            <Button variant="outline" onClick={() => setModal('pair')}>
              重新配对
            </Button>
            <Button variant="quiet" onClick={() => setModal('rotate')}>
              更换令牌
            </Button>
          </Actions>
        </Modal>
      )}
      {modal === 'instance' && (
        <CreateInstance onClose={() => setModal(null)} onCreated={switchInstance} />
      )}
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
          title={`${controllerName(lease?.controllerId)} 正在控制`}
          description="接管后对方会被挤下线，只能查看；正在运行的任务不会中断。"
          onClose={declineTakeover}
        >
          <Actions>
            <Button
              onClick={() => leaseMutation.mutate({ takeover: true })}
              disabled={leaseMutation.isPending}
            >
              {leaseMutation.isPending ? <Spinner /> : null}接管
            </Button>
            <Button variant="outline" onClick={declineTakeover}>
              仅查看
            </Button>
          </Actions>
        </Modal>
      )}
      {modal === 'session' && id && (
        <CreateSession
          instanceId={id}
          controllerId={identity.controller.id}
          capabilities={instance?.capabilities ?? []}
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
/** A calm placeholder for the main area: icon tile, title, one line, primary action. */
function Landing({
  icon,
  title,
  text,
  children,
  heading = 'h2',
}: {
  icon: ReactNode;
  title: string;
  text: string;
  children?: ReactNode;
  heading?: 'h1' | 'h2';
}) {
  const Heading = heading;
  return (
    <div className="swap flex flex-1 items-center justify-center px-6 pb-16">
      <div className="grid w-full max-w-[440px] justify-items-start gap-3">
        <div className="flex size-11 items-center justify-center rounded-2xl bg-accent text-muted-foreground">
          {icon}
        </div>
        <Heading className="text-xl font-medium">{title}</Heading>
        <p className="text-base text-muted-foreground">{text}</p>
        {children ? <div className="mt-2 flex flex-wrap gap-2">{children}</div> : null}
      </div>
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
          : '登录过这个账户的设备。撤销后对方立即退出登录。'
      }
      onClose={onClose}
      busy={mutation.isPending}
    >
      {target ? (
        <Actions>
          <Button
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(target)}
          >
            {mutation.isPending ? <Spinner /> : null}撤销
          </Button>
          <Button variant="outline" disabled={mutation.isPending} onClick={() => setTarget(null)}>
            取消
          </Button>
        </Actions>
      ) : (
        <div className="-mx-2 grid gap-0.5">
          {controllers.map((c) => {
            const inactive = c.active === false || revoked.includes(c.id);
            return (
              <div
                key={c.id}
                className={cn(
                  'flex min-h-11 items-center gap-3 rounded-lg px-2 py-1.5',
                  inactive && 'opacity-50',
                )}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-muted-foreground">
                  <User size={15} />
                </span>
                <span className="grid min-w-0 flex-1">
                  <strong className="truncate text-base font-medium">{c.name}</strong>
                  {c.id === currentId && <small className="text-xs text-caption">当前设备</small>}
                </span>
                {inactive ? (
                  <small className="swap text-sm text-caption">已失效</small>
                ) : (
                  <Button variant="quiet" size="sm" onClick={() => setTarget(c)}>
                    撤销
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <Err error={mutation.error || error} />
    </Modal>
  );
}
/** A read-only secret with a copy button that briefly turns into a check. */
function SecretField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="grid gap-2">
      <Field label={label}>
        <Textarea readOnly rows={3} value={value} className="font-mono text-sm break-all" />
      </Field>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            navigator.clipboard
              ?.writeText(value)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          <span key={copied ? 'done' : 'copy'} className="swap flex">
            {copied ? <Check size={15} /> : <Clipboard size={15} />}
          </span>
          复制令牌
        </Button>
      </div>
    </div>
  );
}
function RotateCredential({ instance, onClose }: { instance: Instance; onClose: () => void }) {
  const client = useQueryClient(),
    [token, setToken] = useState('');
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
          <SecretField label="Connector 令牌" value={token} />
          <Actions>
            <Button onClick={onClose}>完成</Button>
          </Actions>
        </>
      ) : (
        <Actions>
          <Button
            variant="destructive"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? <Spinner /> : null}更换
          </Button>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            取消
          </Button>
        </Actions>
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
      description={
        created ? undefined : '为运行 DSH 的一台电脑起个名字，下一步用配对链接把它连进来。'
      }
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
            <Button variant="outline" onClick={() => repair.mutate()} disabled={repair.isPending}>
              {repair.isPending ? <Spinner /> : <RefreshCw size={16} />}生成配对链接
            </Button>
          )}
          <Err error={repair.error} />
          <details className="group rounded-lg bg-accent/60 px-3 py-2.5">
            <summary className="cursor-pointer text-sm text-muted-foreground select-none">
              改用手动令牌
            </summary>
            <div className="mt-3 grid gap-3">
              <p className="text-sm text-muted-foreground">
                令牌只显示这一次，配对后会失效。不要分享或提交到 Git。
              </p>
              <SecretField label="Connector 令牌" value={created.connectorToken} />
            </div>
          </details>
          <Actions>
            <Button
              onClick={() => {
                onCreated(created.instance.id);
                onClose();
              }}
            >
              进入实例
            </Button>
          </Actions>
        </>
      ) : (
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          <Field label="实例名称">
            <Input
              autoFocus
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：开发工作站"
            />
          </Field>
          <Err error={mutation.error} />
          <Actions>
            <Button disabled={mutation.isPending}>
              {mutation.isPending ? <Spinner /> : null}创建实例
            </Button>
            <Button variant="outline" type="button" onClick={onClose} disabled={mutation.isPending}>
              取消
            </Button>
          </Actions>
        </form>
      )}
    </Modal>
  );
}
function CreateSession({
  instanceId,
  controllerId,
  capabilities,
  lease,
  onClose,
  onCreated,
}: {
  instanceId: string;
  controllerId: string;
  capabilities: string[];
  lease: Lease | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  // Plugins before the folder picker only take a typed path.
  const browsable = capabilities.includes('workspace.browse');
  const [picked, setPicked] = useState<string>(),
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
          args: { sessionId: createdSessionId, ...(browsable && picked ? { cwd: picked } : {}) },
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
    <Modal title="新建会话" onClose={onClose} className="max-w-[520px]">
      <form
        className="grid gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        {browsable ? (
          <WorkspacePicker
            instanceId={instanceId}
            controllerId={controllerId}
            value={picked}
            onChange={setPicked}
          />
        ) : (
          <OutdatedPlugin />
        )}
        <Err error={mutation.error} />
        <RecoveryPanel instanceId={instanceId} />
        <Actions>
          <Button disabled={!lease || mutation.isPending || (browsable && !picked)}>
            {mutation.isPending ? <Spinner /> : null}
            {browsable ? '创建会话' : '在默认目录创建'}
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            取消
          </Button>
        </Actions>
      </form>
    </Modal>
  );
}
/** For a host plugin that cannot browse folders yet: how to update it, never a typed path. */
function OutdatedPlugin() {
  const plugin = usePluginPackage();
  return (
    <div className="grid gap-3 rounded-xl bg-accent/70 p-3.5">
      <p className="text-base text-muted-foreground">
        这台实例的 DSH Remote 插件版本较旧，不能远程浏览目录。在 DSH
        的插件页用下面的地址更新插件后，即可在这里选择文件夹；现在也可以先在它的默认目录创建。
      </p>
      {plugin ? <CopyField label="插件地址" value={plugin.url} /> : null}
    </div>
  );
}
function EventLog({ events }: { events: RemoteEvent[] }) {
  return (
    <div className="mt-2 grid gap-0.5">
      {events.length ? (
        <>
          <div className="pb-1 text-xs text-caption">最近 {events.length} 条事件 · 自动同步</div>
          {[...events].reverse().map((event) => (
            <details key={event.seq} className="group rounded-md">
              <summary className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm select-none hover:bg-accent">
                <span className="font-mono text-xs text-caption tabular-nums">
                  {new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}
                </span>
                <span className="min-w-0 flex-1 truncate">{event.kind}</span>
                <code className="font-mono text-xs text-caption">#{event.seq}</code>
                <ChevronDown
                  size={12}
                  className="text-caption transition-transform group-open:rotate-180"
                />
              </summary>
              <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-background p-2 font-mono text-xs leading-5 text-muted-foreground">
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            </details>
          ))}
        </>
      ) : (
        <Empty icon={<Radio size={20} />} title="等待实时事件">
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
  live,
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
  /** The event stream is live, so host changes arrive as events instead of by polling. */
  live: boolean;
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
    refetchInterval: live ? 60000 : 10000,
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
    refetchInterval: live ? false : summary?.running ? 5000 : 20000,
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
  const column = 'mx-auto w-full max-w-[760px]';
  const pill =
    'inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-45';
  const roundAction =
    'swap inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-[background-color,opacity] hover:bg-primary-hover disabled:pointer-events-none disabled:opacity-30';
  return (
    <>
      <div className="shrink-0 px-6 pb-1 max-md:px-3">
        <div className={cn(column, 'flex min-w-0 items-baseline gap-3')}>
          <strong className="truncate text-base font-medium">
            {summary ? sessionLabel(summary) : sessionId.slice(0, 20)}
          </strong>
          <span className="min-w-0 truncate font-mono text-xs text-caption">
            {summary?.cwd ?? String(asRecord(data.header).cwd ?? sessionId)}
          </span>
        </div>
      </div>
      <div
        className="relative min-h-0 flex-1 overflow-y-auto px-6 max-md:px-3"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 100);
        }}
      >
        <div className={cn(column, 'grid grid-cols-1 gap-7 pt-4 pb-6')}>
          {history.isPending && online ? (
            <div className="text-caption">
              <Spinner />
            </div>
          ) : null}
          <Err error={history.error} />
          {!history.isPending && !messages.length && !streamText ? (
            <p className="py-10 text-base text-caption">尚无消息，在下方描述任务开始。</p>
          ) : null}
          {messages.map(({ event, message }) =>
            message!.role === '运行时上下文' ? (
              <details key={event.seq} className="runtime-record group">
                <summary className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-sm text-caption select-none hover:bg-accent">
                  <ChevronDown size={12} className="transition-transform group-open:rotate-180" />
                  运行时上下文 · {String(asRecord(asRecord(event.data).source).kind ?? '系统')}
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto rounded-xl bg-accent/70 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-muted-foreground">
                  {message!.text}
                </pre>
              </details>
            ) : message!.role === '你' ? (
              <article key={event.seq} className="user-message grid justify-items-end gap-1">
                <div className="message-text max-w-[85%] rounded-[20px] bg-accent px-4 py-2.5 text-md break-words whitespace-pre-wrap">
                  {message!.text}
                </div>
                <time className="px-1 text-xs text-caption">
                  {event.time
                    ? new Date(event.time).toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : ''}
                </time>
              </article>
            ) : (
              <article key={event.seq} className="message grid gap-1.5">
                <header className="flex items-center gap-2 text-xs text-caption">
                  <strong className="font-medium text-muted-foreground">{message!.role}</strong>
                  <time>
                    {event.time
                      ? new Date(event.time).toLocaleTimeString('zh-CN', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : ''}
                  </time>
                </header>
                <div className="message-text text-md break-words whitespace-pre-wrap">
                  {message!.text}
                </div>
              </article>
            ),
          )}
          {streamText && (
            <article className="message grid gap-1.5">
              <header className="flex items-center gap-2 text-xs text-caption">
                <strong className="font-medium text-muted-foreground">DSH</strong>
                <span className="size-1.5 animate-pulse rounded-full bg-success" />
                {stream?.incomplete ? <span>部分片段，结束后同步完整内容</span> : null}
              </header>
              <div className="message-text text-md break-words whitespace-pre-wrap">
                {streamText}
                <span className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[3px] animate-pulse bg-foreground" />
              </div>
            </article>
          )}
        </div>
      </div>
      <div className="relative shrink-0 px-6 pb-5 max-md:px-3 max-md:pb-3">
        {!autoScroll && (
          <button
            className="swap absolute -top-11 left-1/2 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border-[0.8px] border-border bg-card px-3 text-sm text-muted-foreground shadow-soft hover:text-foreground"
            onClick={() => setAutoScroll(true)}
          >
            <ArrowDown size={14} />
            最新消息
          </button>
        )}
        <div className={cn(column, 'grid grid-cols-1 gap-2.5')}>
          {queued.length > 0 && (
            <div className="queue-list grid gap-1 rounded-2xl bg-accent/70 p-2">
              <h4 className="px-2 pt-0.5 text-xs font-medium text-caption">队列 {queued.length}</h4>
              {queued.map((item, index) => (
                <div
                  key={String(asRecord(item).id ?? index)}
                  className="flex items-center gap-1 rounded-lg bg-card py-1 pr-1 pl-3 shadow-soft"
                >
                  <p className="min-w-0 flex-1 truncate text-base">
                    {contentText(asRecord(item).content)}
                  </p>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="编辑队列项"
                    aria-label="编辑队列项"
                    disabled={!canWrite || !!queueBusy}
                    onClick={() =>
                      setQueueEdit({ item, text: contentText(asRecord(item).content) })
                    }
                  >
                    <Pencil size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="转为 steer"
                    aria-label="转为 steer"
                    disabled={!canWrite || !!queueBusy}
                    onClick={() => void changeQueue(item, 'steer')}
                  >
                    <Zap size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="移除队列项"
                    aria-label="移除队列项"
                    disabled={!canWrite || !!queueBusy}
                    onClick={() => void changeQueue(item, 'remove')}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              ))}
            </div>
          )}
          {pending.size > 0 &&
            [...pending.values()].map((approval) => (
              <div
                className="approval-card swap grid gap-2 rounded-2xl bg-warning-surface p-4"
                key={String(approval.approvalId)}
              >
                <strong className="flex items-center gap-1.5 text-sm font-medium text-warning">
                  <Warn size={14} />
                  等待你的审批
                </strong>
                <h4 className="text-md font-medium">{String(approval.toolName ?? '工具调用')}</h4>
                <p className="text-base text-muted-foreground">
                  {String(approval.reason ?? '请核对本次操作后决定是否允许')}
                </p>
                {toolCallForApproval(approval, wireEvents) ? (
                  <div className="grid gap-1">
                    <span className="text-xs text-caption">
                      本次工具调用参数 · {String(approval.callId)}
                    </span>
                    <pre className="max-h-56 overflow-auto rounded-xl bg-background/70 p-3 font-mono text-xs leading-5 whitespace-pre-wrap">
                      {toolCallForApproval(approval, wireEvents)!.arguments}
                    </pre>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {approval.callId
                      ? '尚未载入匹配此调用的参数，请刷新历史后再允许。现在仍可拒绝。'
                      : '此审批没有关联工具调用参数，请根据上方操作说明决定。'}
                  </p>
                )}
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    size="sm"
                    disabled={
                      !canWrite ||
                      !!approvalBusy ||
                      (!!approval.callId && !toolCallForApproval(approval, wireEvents))
                    }
                    onClick={() => void approve(approval, 'allowed-once')}
                  >
                    {approvalBusy === approval.approvalId ? <Spinner /> : null}允许本次
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canWrite || !!approvalBusy}
                    onClick={() => void approve(approval, 'rejected')}
                  >
                    拒绝
                  </Button>
                </div>
              </div>
            ))}
          <Err error={send.error || cancel.error || resume.error || uploadError || actionError} />
          {invalidReferences && (
            <Err error="引用已过期或不可用，请在仓库页面重新验证，或移除对应引用" />
          )}
          <form
            className={cn(
              'grid grid-cols-1 gap-1 rounded-[22px] border-[0.8px] border-border bg-card px-3 pt-2.5 pb-2 shadow-soft transition-[box-shadow,border-color] duration-150 focus-within:border-ring',
              !canWrite && 'bg-accent/40 shadow-none',
            )}
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
              <div className="flex flex-wrap items-center gap-1.5 px-1 pb-1">
                {referenceIds.map((referenceId, index) => (
                  <span
                    className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-accent pr-1 pl-2.5 text-sm"
                    key={referenceId}
                  >
                    <Layers3 size={13} className="shrink-0 text-muted-foreground" />
                    <span className="truncate">
                      {attachedReferences[index]?.fullName ?? '不可用引用'}
                      {attachedReferences[index]?.localState !== 'verified' ? ' · 待验证' : ''}
                    </span>
                    <button
                      type="button"
                      className="inline-flex size-5 items-center justify-center rounded-full text-caption hover:bg-accent-active hover:text-foreground"
                      aria-label={`移除仓库 ${attachedReferences[index]?.fullName ?? referenceId}`}
                      onClick={() =>
                        setReferenceIds((old) => old.filter((value) => value !== referenceId))
                      }
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
                <Button
                  type="button"
                  variant="link"
                  className="text-sm"
                  onClick={() => setContextOpen(true)}
                >
                  预览引用上下文
                </Button>
              </div>
            )}
            {files.length > 0 && (
              <div className="attachment-list flex flex-wrap gap-1.5 px-1 pb-1">
                {files.map((file, index) => (
                  <span
                    key={index}
                    className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-accent pr-1 pl-2.5 text-sm"
                  >
                    <FileText size={13} className="shrink-0 text-muted-foreground" />
                    <span className="truncate">{file.name}</span>
                    <button
                      type="button"
                      className="inline-flex size-5 items-center justify-center rounded-full text-caption hover:bg-accent-active hover:text-foreground"
                      aria-label={`移除 ${file.name}`}
                      onClick={() => setFiles((old) => old.filter((_, i) => i !== index))}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              className="max-h-60 min-h-[52px] w-full resize-none bg-transparent px-1 text-md text-foreground outline-none placeholder:text-caption disabled:cursor-not-allowed"
              maxLength={100000}
              aria-label="消息"
              placeholder={
                canWrite
                  ? '描述任务，或告诉 DSH 下一步该怎么做'
                  : operations.operations.some((op) => op.instanceId === id)
                    ? '原命令尚待确认'
                    : online
                      ? '只读 · 控制此实例后可发送'
                      : '实例离线'
              }
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={!canWrite || send.isPending}
              rows={2}
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
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-full text-muted-foreground"
                  aria-label="添加附件"
                  title="添加附件，最大 4 MiB"
                  disabled={!canWrite || uploading || send.isPending || files.length >= 4}
                  onClick={() => fileInput.current?.click()}
                >
                  {uploading ? <Spinner /> : <Attach size={16} />}
                </Button>
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
                  className={cn(
                    pill,
                    'max-w-[180px] min-w-0 shrink cursor-pointer appearance-none truncate bg-transparent outline-none',
                  )}
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
                <button
                  type="button"
                  className={cn(pill, 'model-button min-w-0 shrink')}
                  onClick={() => setModelOpen(true)}
                >
                  <Settings2 size={14} className="shrink-0" />
                  <span className="truncate">{String(selection.model ?? '模型与配置')}</span>
                  <ChevronDown size={12} className="shrink-0" />
                </button>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <select
                  className={cn(pill, 'cursor-pointer appearance-none bg-transparent outline-none')}
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
                    className={roundAction}
                    aria-label="停止任务"
                    title="停止任务"
                    disabled={!canWrite || cancel.isPending}
                    onClick={() => cancel.mutate()}
                  >
                    {cancel.isPending ? <Spinner /> : <Square size={12} />}
                  </button>
                ) : (
                  <button
                    key="send"
                    className={roundAction}
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
                    {send.isPending ? <Spinner /> : <Send size={16} />}
                  </button>
                )}
              </div>
            </div>
          </form>
          {data.agentAvailable === false && (
            <div className="px-1">
              <Button
                variant="link"
                className="text-sm"
                disabled={!canWrite || resume.isPending}
                onClick={() => resume.mutate()}
              >
                恢复运行环境
              </Button>
            </div>
          )}
        </div>
      </div>
      {contextOpen && (
        <Modal
          title="本条消息的仓库上下文"
          description="仅使用实例绑定的引用 ID，服务端再次检查已有工作树。此预览不包含仓库文件或访问令牌"
          onClose={() => setContextOpen(false)}
          className="max-w-[560px]"
        >
          <div className="grid gap-3">
            {attachedReferences.map((row, index) => (
              <div className="grid gap-2 rounded-xl bg-accent/60 p-3" key={referenceIds[index]}>
                {row ? (
                  <>
                    <strong className="text-base font-medium">{row.fullName}</strong>
                    <pre className="max-h-48 overflow-auto rounded-lg bg-background p-2 font-mono text-xs leading-5 text-muted-foreground">
                      {JSON.stringify(contextPreview(row), null, 2)}
                    </pre>
                  </>
                ) : (
                  <p className="text-base text-muted-foreground">此引用已不可用，请移除</p>
                )}
                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setReferenceIds((old) => old.filter((value) => value !== referenceIds[index]))
                    }
                  >
                    移除引用
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <Actions>
            <Button onClick={() => setContextOpen(false)}>返回草稿</Button>
          </Actions>
        </Modal>
      )}
      {queueEdit && (
        <Modal
          title="编辑待处理消息"
          description="只能修改尚未消费的队列文本"
          onClose={() => setQueueEdit(null)}
        >
          <form
            className="grid gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              void changeQueue(queueEdit.item, 'edit', queueEdit.text);
            }}
          >
            <Field label="队列消息">
              <Textarea
                aria-label="队列消息"
                rows={5}
                maxLength={100000}
                value={queueEdit.text}
                onChange={(e) => setQueueEdit({ ...queueEdit, text: e.target.value })}
              />
            </Field>
            <Err error={actionError} />
            <Actions>
              <Button disabled={!canWrite || !!queueBusy || !queueEdit.text.trim()}>
                {queueBusy ? <Spinner /> : <Check size={16} />}保存队列消息
              </Button>
              <Button type="button" variant="outline" onClick={() => setQueueEdit(null)}>
                取消
              </Button>
            </Actions>
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
