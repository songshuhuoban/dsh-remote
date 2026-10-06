/**
 * Browser half: the DSH Remote page on DSH's Plugins page. Loaded by DSH's client module system;
 * `react` and `@deepseek-ai/cordis` come from the page's module table, nothing else is shared.
 * Layout follows docs/design/minimal-ui.md: one left edge, no rules, one element per state.
 */
import { useCallback, useEffect, useState } from 'react';
import { en, zh, type LocaleKeys } from './locales.ts';

const PACKAGE = '@dsh-remote/plugin';
const ROW = 'dsh-remote';
const NS = 'dshRemote';
const API = 'api/dsh-remote';

type T = (key: LocaleKeys) => string;
type SettingsField = 'allowedWorkspaceRoots' | 'allowedPermissionPresets' | 'allowedAgentPresets';
interface Status {
  mode: 'paired' | 'manual' | 'unpaired';
  state: string;
  relayUrl?: string;
  instance?: { id: string; name: string };
  detail?: string;
  onlineSince?: number;
  nextRetryAt?: number;
  workspaceRoots: Array<{ path: string; available: boolean }>;
  settings: Record<SettingsField, string[]> & { allowAnyWorkspace?: boolean };
  lockedByProfile: SettingsField[];
  localControl: boolean;
}
interface ClientContext {
  effect(callback: () => () => void): void;
  get(name: string): unknown;
  locale: { register(ns: string, dicts: { zh: object; en: object }): () => void };
  slots: {
    inject(name: string, callback: () => () => void): () => void;
    register(options: Record<string, unknown>, component: (props: any) => unknown): () => void;
  };
}
/** Known keys only: DSH's translator echoes unknown keys instead of failing. */
const known = (key: string, fallback: LocaleKeys): LocaleKeys =>
  (key in zh ? key : fallback) as LocaleKeys;
const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));
const isAbsolute = (path: string) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path);
const hostOf = (url?: string) => {
  try {
    return url ? new URL(url).host : '';
  } catch {
    return url ?? '';
  }
};

async function call(path: string, body?: unknown): Promise<Status> {
  const response = await fetch(`${API}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = (await response.json().catch(() => ({}))) as Status & { error?: { code?: string } };
  if (!response.ok) throw new Error(data.error?.code ?? 'unknown');
  return data;
}

function useStatus() {
  const [status, setStatus] = useState<Status | undefined>();
  useEffect(() => {
    const refresh = () => call('status').then(setStatus, () => {});
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, []);
  return [status, setStatus] as const;
}

/** Whole seconds until `at`, ticking each second; 0 once passed or absent. */
function useCountdown(at?: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!at) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [at]);
  return at ? Math.max(0, Math.ceil((at - now) / 1000)) : 0;
}

/** Runs one plugin action, mapping relay/Host error codes to copy. */
function useAction(t: T, onChange: (s: Status) => void) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const run = useCallback(
    (path: string, body: unknown = {}) => {
      setBusy(true);
      setError('');
      return call(path, body)
        .then(
          (next) => {
            onChange(next);
            return true;
          },
          (e: Error) => {
            setError(t(known(`error.${e.message}`, 'error.unknown')));
            return false;
          },
        )
        .finally(() => setBusy(false));
    },
    [t, onChange],
  );
  return { busy, error, run };
}

/** Connection: state word, relay and instance read as one line; actions follow as text. */
function Connection({ t, status, onChange }: { t: T; status: Status; onChange(s: Status): void }) {
  const { busy, error, run } = useAction(t, onChange);
  const [linking, setLinking] = useState(false),
    [link, setLink] = useState('');
  const online = status.state === 'online';
  const retryIn = useCountdown(online ? undefined : status.nextRetryAt);
  const tone = online ? 'ok' : status.state === 'unpaired' ? '' : 'warn';
  const showForm = status.mode === 'unpaired' || linking;
  const pair = () =>
    run('pair', { link: link.trim() }).then((ok) => {
      if (ok) {
        setLink('');
        setLinking(false);
      }
    });
  return (
    <section>
      <p className={`dshr-state ${tone}`}>
        <span className="dshr-dot" />
        <span key={status.state} className="dshr-swap">
          {t(known(`state.${status.state}`, 'state.failed'))}
        </span>
        {retryIn ? (
          <span className="dshr-muted">{fill(t('retryIn'), { s: retryIn })}</span>
        ) : null}
        {status.relayUrl ? <span className="dshr-muted">{hostOf(status.relayUrl)}</span> : null}
        {status.instance ? <span className="dshr-muted">{status.instance.name}</span> : null}
      </p>
      {status.detail && !online && status.mode !== 'unpaired' ? (
        <p className="dshr-muted">{status.detail}</p>
      ) : null}
      {status.mode === 'manual' ? <p className="dshr-muted">{t('manualMode')}</p> : null}
      {showForm && status.mode !== 'manual' ? (
        <form
          className="dshr-inline dshr-swap"
          onSubmit={(e) => {
            e.preventDefault();
            void pair();
          }}
        >
          <input
            autoFocus={linking}
            value={link}
            aria-label={t('pairHeading')}
            placeholder={t('pairPlaceholder')}
            disabled={busy || !status.localControl}
            onChange={(e) => setLink(e.target.value)}
          />
          <button
            type="submit"
            className="primary"
            disabled={busy || !link.trim() || !status.localControl}
          >
            {busy ? t('pairing') : t('pair')}
          </button>
        </form>
      ) : null}
      {status.mode !== 'unpaired' ? (
        <div className="dshr-actions">
          {online ? null : (
            <button type="button" disabled={busy} onClick={() => void run('reconnect')}>
              {t('reconnect')}
            </button>
          )}
          {status.mode === 'paired' ? (
            <>
              <button
                type="button"
                disabled={busy || !status.localControl}
                onClick={() => setLinking(!linking)}
              >
                {linking ? t('cancel') : t('switchInstance')}
              </button>
              <button
                type="button"
                disabled={busy || !status.localControl}
                onClick={() => window.confirm(t('unpairConfirm')) && void run('unpair')}
              >
                {t('unpair')}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="dshr-error dshr-swap">{error}</p> : null}
    </section>
  );
}

function ListEditor({
  t,
  status,
  onChange,
  field,
  heading,
  empty,
  placeholder,
  validate,
}: {
  t: T;
  status: Status;
  onChange(s: Status): void;
  field: SettingsField;
  heading: string;
  empty?: string;
  placeholder: string;
  validate?: (value: string) => LocaleKeys | undefined;
}) {
  const { busy, error, run } = useAction(t, onChange);
  const [draft, setDraft] = useState(''),
    [problem, setProblem] = useState<LocaleKeys | undefined>();
  const items = status.settings[field] ?? [];
  const locked = status.lockedByProfile.includes(field);
  const writable = status.localControl && !locked;
  const missing = new Set(
    field === 'allowedWorkspaceRoots'
      ? status.workspaceRoots.filter((root) => !root.available).map((root) => root.path)
      : [],
  );
  const save = (next: string[]) =>
    run('settings', { [field]: next }).then((ok) => {
      if (ok) setDraft('');
    });
  const add = () => {
    const value = draft.trim();
    const found = validate?.(value) ?? (items.includes(value) ? 'duplicate' : undefined);
    setProblem(found);
    if (!found && value) void save([...items, value]);
  };
  return (
    <section>
      <h3>{heading}</h3>
      {items.length ? (
        <ul className="dshr-list">
          {items.map((item) => (
            <li key={item} className="dshr-swap">
              <code>{item}</code>
              {missing.has(item) ? <small className="dshr-warn">{t('rootsMissing')}</small> : null}
              {writable ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void save(items.filter((i) => i !== item))}
                >
                  {t('remove')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : empty ? (
        <p className="dshr-warn">{empty}</p>
      ) : null}
      {writable ? (
        <form
          className="dshr-inline"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            value={draft}
            aria-label={heading}
            placeholder={placeholder}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" disabled={busy || !draft.trim()}>
            {busy ? t('saving') : t('add')}
          </button>
        </form>
      ) : null}
      {locked ? <p className="dshr-muted">{t('lockedByProfile')}</p> : null}
      {problem || error ? (
        <p className="dshr-error dshr-swap">{problem ? t(problem) : error}</p>
      ) : null}
    </section>
  );
}

/** One switch: whether remote devices may browse and use any folder on this computer. */
function AnyWorkspace({ t, status, onChange }: { t: T; status: Status; onChange(s: Status): void }) {
  const { busy, error, run } = useAction(t, onChange);
  const on = !!status.settings.allowAnyWorkspace;
  return (
    <section>
      <label className="dshr-check">
        <input
          type="checkbox"
          checked={on}
          disabled={busy || !status.localControl}
          onChange={(e) => void run('settings', { allowAnyWorkspace: e.target.checked })}
        />
        <span>{t('anyWorkspace')}</span>
      </label>
      <p className="dshr-muted">{t(on ? 'anyWorkspaceOn' : 'anyWorkspaceOff')}</p>
      {error ? <p className="dshr-error dshr-swap">{error}</p> : null}
    </section>
  );
}

function RemotePage(props: { view: 'summary' | 'page'; t: T }) {
  const { t } = props;
  const [status, setStatus] = useStatus();
  if (props.view === 'summary') {
    if (!status) return null;
    if (status.state === 'online') return fill(t('summaryOnline'), { relay: hostOf(status.relayUrl) });
    if (status.mode === 'unpaired') return t('summaryUnpaired');
    return fill(t('summaryOffline'), { state: t(known(`state.${status.state}`, 'state.failed')) });
  }
  if (!status) return <div className="dshr" />;
  return (
    <div className="dshr">
      {!status.localControl ? <p className="dshr-muted">{t('localOnly')}</p> : null}
      <Connection t={t} status={status} onChange={setStatus} />
      <ListEditor
        t={t}
        status={status}
        onChange={setStatus}
        field="allowedWorkspaceRoots"
        heading={t('rootsHeading')}
        empty={t('rootsEmpty')}
        placeholder={t('rootPlaceholder')}
        validate={(value) => (isAbsolute(value) ? undefined : 'notAbsolute')}
      />
      <AnyWorkspace t={t} status={status} onChange={setStatus} />
      <details>
        <summary>{t('advanced')}</summary>
        <ListEditor
          t={t}
          status={status}
          onChange={setStatus}
          field="allowedPermissionPresets"
          heading={t('permissionPresets')}
          placeholder={t('presetPlaceholder')}
        />
        <ListEditor
          t={t}
          status={status}
          onChange={setStatus}
          field="allowedAgentPresets"
          heading={t('agentPresets')}
          placeholder={t('presetPlaceholder')}
        />
      </details>
    </div>
  );
}

// DSH semantic tokens keep the page consistent with the host theme in light and dark modes.
const CSS = `
.dshr{display:flex;flex-direction:column;gap:32px;max-width:640px;text-align:left}
.dshr section{display:flex;flex-direction:column;gap:8px}
.dshr h3{margin:0;color:var(--dsw-alias-label-secondary,#888);font-size:12px;font-weight:400}
.dshr details>summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#888);font-size:13px}
.dshr details[open]>summary{margin-bottom:24px}
.dshr details>section+section{margin-top:24px}
.dshr p{margin:0}
.dshr-muted{color:var(--dsw-alias-label-secondary,#888);font-size:12px;line-height:1.6}
.dshr-state{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;font-size:15px}
.dshr-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#999);transition:background-color 200ms ease-out}
.dshr-state.ok .dshr-dot{background:var(--dsw-alias-state-success-primary,#2a2)}
.dshr-state.warn .dshr-dot{background:var(--dsw-alias-state-warn-label,#c80)}
.dshr-state .dshr-muted{font-size:13px}
.dshr-actions{display:flex;flex-wrap:wrap;gap:16px;margin-top:4px}
.dshr .dshr-actions button{padding:0;min-height:0;background:transparent;color:var(--dsw-alias-link,#36c);font-size:13px}
.dshr-inline{display:flex;gap:8px;margin-top:4px}
.dshr-check{display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer}
.dshr-check input{margin:0}
.dshr-inline input{flex:1;min-width:0}
.dshr button,.dshr input{font:inherit;font-size:13px;padding:7px 12px;border:0;border-radius:8px;color:inherit;transition:background-color 200ms ease-out,opacity 200ms ease-out}
.dshr input{background:var(--dsw-specific-selector,#8881)}
.dshr input:focus-visible,.dshr button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#36c);outline-offset:2px}
.dshr button{background:var(--dsw-specific-selector,#8881);cursor:pointer}
.dshr button.primary{background:var(--dsw-alias-label-primary,#111);color:var(--dsw-alias-label-primary-inverted,#fff)}
.dshr button:disabled{opacity:.45;cursor:not-allowed}
.dshr-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.dshr-list li{display:flex;align-items:center;gap:12px;font-size:13px}
.dshr-list code{flex:1;overflow-wrap:anywhere;font-size:13px}
.dshr .dshr-list button{padding:0;background:transparent;color:var(--dsw-alias-link,#36c)}
.dshr-error{color:var(--dsw-alias-state-error-primary,#d33);font-size:12px}
.dshr-warn{color:var(--dsw-alias-state-warn-label,#c80);font-size:12px}
@keyframes dshr-in{from{opacity:0;transform:translateY(4px)}}
.dshr-swap{animation:dshr-in 200ms ease-out}
@media (prefers-reduced-motion:reduce){.dshr *{animation:none!important;transition:none!important}}
`;
function injectStyle() {
  if (typeof document === 'undefined' || document.querySelector('style[data-plugin-css="dsh-remote"]')) return;
  const style = document.createElement('style');
  style.dataset.pluginCss = 'dsh-remote';
  style.textContent = CSS;
  document.head.appendChild(style);
}

export const inject = ['slots', 'locale'];
export function apply(ctx: ClientContext) {
  injectStyle();
  ctx.effect(() => ctx.locale.register(NS, { zh, en }));
  ctx.effect(() =>
    ctx.slots.inject('plugins.row.config', () =>
      ctx.slots.register({ name: 'plugins.row.config', key: `${PACKAGE}#${ROW}`, locale: NS }, RemotePage),
    ),
  );
  ctx.effect(() =>
    ctx.slots.inject('plugins.bundle.config', () =>
      ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE, locale: NS }, RemotePage),
    ),
  );
}
