/**
 * Folder choice for a new session: the folders the DSH computer allows come first, and a remote
 * folder browser reaches the rest. The Host decides what may be listed (only inside the allowed
 * folders, unless "允许远程选择本机任意目录" is on there); this view never sends a typed path.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Check, ChevronRight, CornerLeftUp, Folder } from 'lucide-react';
import { asRecord, runCommand } from './api';
import { Err, Spinner } from './ui';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

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
const lastSegment = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

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
  // false: the allowed folders; null: where browsing starts; a path: that folder's subfolders.
  const [browsing, setBrowsing] = useState<string | null | false>(false);
  const workspaces = useQuery({
    queryKey: ['remote', instanceId, 'workspaces'],
    queryFn: ({ signal }) =>
      runCommand(instanceId, controllerId, 'workspace.list', {}, undefined, signal).then((raw) => {
        const data = asRecord(raw);
        return { roots: places(data.roots), anyWorkspace: data.anyWorkspace === true };
      }),
    staleTime: 30_000,
  });
  const listing = useQuery({
    queryKey: ['remote', instanceId, 'browse', browsing || ''],
    enabled: browsing !== false,
    queryFn: ({ signal }): Promise<Listing> =>
      runCommand(
        instanceId,
        controllerId,
        'workspace.browse',
        browsing ? { path: browsing } : {},
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
  const roots = workspaces.data?.roots ?? [],
    anyWorkspace = !!workspaces.data?.anyWorkspace;
  useEffect(() => {
    if (value === undefined && roots[0]) onChange(roots[0].path);
  }, [workspaces.data]);

  if (browsing !== false) {
    const here = listing.data;
    return (
      <div className="swap grid gap-2" key="browse">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="返回目录列表"
            onClick={() => setBrowsing(false)}
          >
            <ArrowLeft size={16} />
          </Button>
          <span className="min-w-0 font-mono text-sm break-all text-muted-foreground">
            {here?.path ?? (anyWorkspace ? '此电脑' : '允许的目录')}
          </span>
        </div>
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
                className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-accent text-muted-foreground"
                onClick={() => setBrowsing(here.parent ?? null)}
              >
                <CornerLeftUp size={16} />
                <span className="text-base">上一级</span>
              </button>
            ) : null}
            {here?.directories.map((folder) => (
              <button
                type="button"
                key={folder.path}
                className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-accent"
                onClick={() => setBrowsing(folder.path)}
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                onChange(here.path!);
                setBrowsing(false);
              }}
            >
              使用此目录
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  const custom = value && !roots.some((root) => root.path === value) ? value : undefined;
  return (
    <div className="swap grid gap-2" key="list">
      <span className="text-sm font-medium text-muted-foreground">工作目录</span>
      {workspaces.isPending ? (
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
          {[...(custom ? [{ name: lastSegment(custom), path: custom }] : []), ...roots].map(
            (place) => (
              <button
                type="button"
                role="radio"
                aria-checked={value === place.path}
                key={place.path}
                className={cn(
                  'flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-accent',
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
      <Err error={workspaces.error} />
      {roots.length || anyWorkspace ? (
        <div>
          <Button
            type="button"
            variant="link"
            className="text-sm"
            onClick={() => setBrowsing(value ?? null)}
          >
            {anyWorkspace ? '浏览其他目录' : '选择子目录'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
