/**
 * Choosing folders on the DSH host. The host may run another system than this browser, so its
 * paths are only displayed, split into breadcrumbs or converted into the host's own style
 * through packages/protocol/src/host-path.ts; the host resolves every path and decides what
 * may be listed (the allowed folders, or anything once "允许远程选择本机任意目录" is on there).
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CornerLeftUp,
  Folder,
  TextCursorInput,
} from 'lucide-react';
import { asRecord, runCommand } from './api';
import { Err, Spinner } from './ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  hostPathCrumbs,
  hostPathName,
  hostPathStyle,
  toHostPath,
  type HostPathStyle,
} from '../../../packages/protocol/src/host-path.ts';

type Place = { name: string; path: string };
type Listing = {
  path: string | null;
  parent: string | null;
  directories: Place[];
  truncated: boolean;
};
const places = (value: unknown): Place[] =>
  (Array.isArray(value) ? value : [])
    .map(asRecord)
    .filter((p) => typeof p.path === 'string' && typeof p.name === 'string') as Place[];
const row =
  'flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-accent';

/** The host's allowed folders, whether anything may be browsed, and its path style. */
export function useHostFolders(instanceId: string, controllerId: string, enabled = true) {
  const query = useQuery({
    queryKey: ['remote', instanceId, 'workspaces'],
    enabled,
    queryFn: ({ signal }) =>
      runCommand(instanceId, controllerId, 'workspace.list', {}, undefined, signal).then((raw) => {
        const data = asRecord(raw);
        const roots = places(data.roots);
        // Older hosts do not report their style; their own paths reveal it.
        const style: HostPathStyle | null =
          data.style === 'windows' || data.style === 'posix'
            ? data.style
            : roots[0]
              ? hostPathStyle(roots[0].path)
              : null;
        return { roots, anyWorkspace: data.anyWorkspace === true, style };
      }),
    staleTime: 30_000,
  });
  return {
    ...query,
    roots: query.data?.roots ?? [],
    anyWorkspace: !!query.data?.anyWorkspace,
    style: query.data?.style ?? null,
  };
}

/** Whether `path` is one of `roots` or inside one, compared in the host's style. */
function insideRoots(path: string, roots: Place[]) {
  const windows = hostPathStyle(path) === 'windows';
  const fold = (value: string) => (windows ? value.toLowerCase() : value);
  return roots.some((root) => {
    const base = fold(root.path),
      target = fold(path);
    const sep = windows ? '\\' : '/';
    return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
  });
}

/**
 * One folder level on the host with breadcrumbs, the way up, its subfolders and a field that
 * accepts a pasted path in any common form. `start` null begins at the host's starting places.
 */
export function FolderBrowser({
  instanceId,
  controllerId,
  start,
  roots,
  anyWorkspace,
  style,
  confirmLabel = '使用此目录',
  onConfirm,
  onBack,
}: {
  instanceId: string;
  controllerId: string;
  start: string | null;
  roots: Place[];
  anyWorkspace: boolean;
  style: HostPathStyle | null;
  confirmLabel?: string;
  onConfirm: (path: string) => void;
  onBack: () => void;
}) {
  const [at, setAt] = useState<string | null>(start),
    [typing, setTyping] = useState(false),
    [typed, setTyped] = useState(''),
    [typedError, setTypedError] = useState('');
  const listing = useQuery({
    queryKey: ['remote', instanceId, 'browse', at ?? ''],
    queryFn: ({ signal }): Promise<Listing> =>
      runCommand(
        instanceId,
        controllerId,
        'workspace.browse',
        at ? { path: at } : {},
        undefined,
        signal,
      ).then((raw) => {
        const data = asRecord(raw);
        return {
          path: typeof data.path === 'string' ? data.path : null,
          parent: typeof data.parent === 'string' ? data.parent : null,
          directories: places(data.directories),
          truncated: data.truncated === true,
        };
      }),
    staleTime: 15_000,
  });
  const here = listing.data;
  const hostStyle = style ?? (here?.path ? hostPathStyle(here.path) : null);
  const crumbs = here?.path ? hostPathCrumbs(here.path) : [];
  // Not a <form>: the picker sits inside dialogs' forms, and Enter must not submit those.
  const go = () => {
    const converted = hostStyle ? toHostPath(typed, hostStyle) : null;
    if (!converted) {
      setTypedError(
        hostStyle === 'windows'
          ? '这台实例是 Windows，请输入类似 D:\\projects 的完整路径'
          : '请输入以 / 开头的完整路径，例如 /home/me/projects',
      );
      return;
    }
    setTypedError('');
    setTyping(false);
    setTyped('');
    setAt(converted);
  };
  return (
    <div className="swap grid gap-2" key="browse">
      <div className="flex min-w-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="返回目录列表"
          onClick={onBack}
        >
          <ArrowLeft size={16} />
        </Button>
        <nav
          aria-label="当前位置"
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-sm whitespace-nowrap"
        >
          <button
            type="button"
            className="shrink-0 rounded-md px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => setAt(null)}
          >
            {anyWorkspace ? '此电脑' : '允许的目录'}
          </button>
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            const reachable = anyWorkspace || insideRoots(crumb.path, roots);
            return (
              <span key={crumb.path} className="flex shrink-0 items-center gap-0.5">
                <ChevronRight size={12} className="text-caption" />
                {last || !reachable ? (
                  <span
                    className={cn(
                      'px-1.5 py-1 font-mono',
                      last ? 'text-foreground' : 'text-caption',
                    )}
                    aria-current={last ? 'location' : undefined}
                  >
                    {crumb.name}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="rounded-md px-1.5 py-1 font-mono text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => setAt(crumb.path)}
                  >
                    {crumb.name}
                  </button>
                )}
              </span>
            );
          })}
        </nav>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="输入路径"
          aria-pressed={typing}
          onClick={() => {
            setTyping(!typing);
            setTypedError('');
          }}
        >
          <TextCursorInput size={16} />
        </Button>
      </div>
      {typing && (
        <div className="swap grid gap-1.5">
          <Input
            autoFocus
            aria-label="前往路径"
            className="font-mono text-sm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              e.stopPropagation();
              go();
            }}
            placeholder={
              hostStyle === 'windows'
                ? '粘贴路径，如 D:\\projects 或 D:/projects'
                : '粘贴路径，如 /home/me/projects'
            }
          />
          {typedError ? <p className="text-sm text-destructive">{typedError}</p> : null}
        </div>
      )}
      {listing.isPending ? (
        <div className="px-3 py-3 text-caption">
          <Spinner />
        </div>
      ) : (
        <div
          className="-mx-1 grid max-h-[300px] gap-0.5 overflow-y-auto px-1"
          role="list"
          aria-label="文件夹"
        >
          {here?.path ? (
            <button
              type="button"
              className={cn(row, 'text-muted-foreground')}
              onClick={() => setAt(here.parent ?? null)}
            >
              <CornerLeftUp size={16} />
              <span className="text-base">上一级</span>
            </button>
          ) : null}
          {here?.directories.map((folder) => (
            <button
              type="button"
              key={folder.path}
              className={row}
              onClick={() => setAt(folder.path)}
            >
              <Folder size={16} className="shrink-0 text-link" />
              <span className="grid min-w-0 flex-1">
                <strong className="truncate text-base font-normal">{folder.name}</strong>
                {here.path ? null : (
                  <small className="truncate font-mono text-xs text-caption">{folder.path}</small>
                )}
              </span>
              <ChevronRight size={16} className="shrink-0 text-caption" />
            </button>
          ))}
          {here && !here.directories.length ? (
            <p className="px-3 py-2 text-base text-caption">没有子文件夹</p>
          ) : null}
          {here?.truncated ? (
            <p className="px-3 py-2 text-sm text-caption">只显示前 500 个文件夹</p>
          ) : null}
        </div>
      )}
      <Err error={listing.error} />
      {here?.path ? (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => onConfirm(here.path!)}>
            {confirmLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Folder choice for a new session: the allowed folders first, the browser for the rest. */
export function WorkspacePicker({
  instanceId,
  controllerId,
  value,
  onChange,
}: {
  instanceId: string;
  controllerId: string;
  value: string | undefined;
  onChange: (path: string) => void;
}) {
  const [browsing, setBrowsing] = useState(false);
  const folders = useHostFolders(instanceId, controllerId);
  const { roots, anyWorkspace } = folders;
  useEffect(() => {
    if (value === undefined && roots[0]) onChange(roots[0].path);
  }, [folders.data]);

  if (browsing)
    return (
      <FolderBrowser
        instanceId={instanceId}
        controllerId={controllerId}
        start={value ?? null}
        roots={roots}
        anyWorkspace={anyWorkspace}
        style={folders.style}
        onBack={() => setBrowsing(false)}
        onConfirm={(path) => {
          onChange(path);
          setBrowsing(false);
        }}
      />
    );

  const custom = value && !roots.some((root) => root.path === value) ? value : undefined;
  return (
    <div className="swap grid gap-2" key="list">
      <span className="text-sm font-medium text-muted-foreground">工作目录</span>
      {folders.isPending ? (
        <div className="px-3 py-3 text-caption">
          <Spinner />
        </div>
      ) : !roots.length && !anyWorkspace ? (
        <p className="rounded-xl bg-accent/70 px-3 py-2.5 text-base text-muted-foreground">
          这台实例还没有允许远程使用的目录。请在运行 DSH 的电脑上打开 插件 → DSH Remote
          添加工作目录，或开启「允许远程选择本机任意目录」。
        </p>
      ) : (
        <div
          className="-mx-1 grid max-h-[300px] gap-0.5 overflow-y-auto px-1"
          role="radiogroup"
          aria-label="工作目录"
        >
          {[...(custom ? [{ name: hostPathName(custom), path: custom }] : []), ...roots].map(
            (place) => (
              <button
                type="button"
                role="radio"
                aria-checked={value === place.path}
                key={place.path}
                className={cn(
                  row,
                  value === place.path && 'bg-accent-active hover:bg-accent-active',
                )}
                onClick={() => onChange(place.path)}
              >
                <Folder size={16} className="shrink-0 text-link" />
                <span className="grid min-w-0 flex-1">
                  <strong className="truncate text-base font-medium">{place.name}</strong>
                  <small className="truncate font-mono text-xs text-caption">{place.path}</small>
                </span>
                {value === place.path ? (
                  <Check size={16} className="shrink-0 text-foreground" />
                ) : null}
              </button>
            ),
          )}
        </div>
      )}
      <Err error={folders.error} />
      {roots.length || anyWorkspace ? (
        <div>
          <Button
            type="button"
            variant="link"
            className="text-sm"
            onClick={() => setBrowsing(true)}
          >
            {anyWorkspace ? '浏览其他目录' : '选择子目录'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A host folder chosen with the browser, e.g. an existing Git checkout to map. Shows the choice
 * read-only with a way to change it; `value` stays undefined until something is chosen.
 */
export function FolderField({
  label,
  instanceId,
  controllerId,
  value,
  onChange,
}: {
  label: string;
  instanceId: string;
  controllerId: string;
  value: string | undefined;
  onChange: (path: string) => void;
}) {
  const [browsing, setBrowsing] = useState(false);
  const folders = useHostFolders(instanceId, controllerId);
  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      {browsing ? (
        <div className="rounded-xl border-[0.8px] border-border p-2">
          <FolderBrowser
            instanceId={instanceId}
            controllerId={controllerId}
            start={value ?? null}
            roots={folders.roots}
            anyWorkspace={folders.anyWorkspace}
            style={folders.style}
            confirmLabel="选择此文件夹"
            onBack={() => setBrowsing(false)}
            onConfirm={(path) => {
              onChange(path);
              setBrowsing(false);
            }}
          />
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-2">
          {value ? (
            <span className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-field px-3 py-2">
              <Folder size={16} className="shrink-0 text-link" />
              <span className="truncate font-mono text-sm" title={value}>
                {value}
              </span>
            </span>
          ) : null}
          <Button type="button" variant="outline" onClick={() => setBrowsing(true)}>
            <Folder size={15} />
            {value ? '更改' : '选择文件夹'}
          </Button>
        </div>
      )}
    </div>
  );
}
