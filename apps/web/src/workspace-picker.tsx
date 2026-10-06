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
      <div className="workspace-picker swap" key="browse">
        <div className="picker-head">
          <button
            type="button"
            className="icon-button"
            aria-label="返回目录列表"
            onClick={() => setBrowsing(false)}
          >
            <ArrowLeft size={16} />
          </button>
          <span className="picker-path">
            {here?.path ?? (anyWorkspace ? '此电脑' : '允许的目录')}
          </span>
        </div>
        {listing.isPending ? (
          <div className="subtle-loading">
            <Spinner />
          </div>
        ) : (
          <div className="picker-list" role="list" aria-label="文件夹">
            {here?.path ? (
              <button
                type="button"
                className="picker-row"
                onClick={() => setBrowsing(here.parent ?? null)}
              >
                <CornerLeftUp size={16} />
                <span>上一级</span>
              </button>
            ) : null}
            {here?.directories.map((folder) => (
              <button
                type="button"
                key={folder.path}
                className="picker-row"
                onClick={() => setBrowsing(folder.path)}
              >
                <Folder size={16} />
                <span>
                  <strong>{folder.name}</strong>
                  {here.path ? null : <small>{folder.path}</small>}
                </span>
                <ChevronRight size={16} className="picker-enter" />
              </button>
            ))}
            {here && !here.directories.length ? <p className="picker-note">没有子文件夹</p> : null}
            {here?.truncated ? <p className="picker-note">只显示前 500 个文件夹</p> : null}
          </div>
        )}
        <Err error={listing.error} />
        {here?.path ? (
          <button
            type="button"
            className="quiet"
            onClick={() => {
              onChange(here.path!);
              setBrowsing(false);
            }}
          >
            使用此目录
          </button>
        ) : null}
      </div>
    );
  }

  const custom = value && !roots.some((root) => root.path === value) ? value : undefined;
  return (
    <div className="workspace-picker swap" key="list">
      <span className="field-label">工作目录</span>
      {workspaces.isPending ? (
        <div className="subtle-loading">
          <Spinner />
        </div>
      ) : !roots.length && !anyWorkspace ? (
        <p className="picker-note">
          这台实例还没有允许远程使用的目录。请在运行 DSH 的电脑上打开 插件 → DSH Remote
          添加工作目录，或开启「允许远程选择本机任意目录」。
        </p>
      ) : (
        <div className="picker-list" role="radiogroup" aria-label="工作目录">
          {[...(custom ? [{ name: lastSegment(custom), path: custom }] : []), ...roots].map(
            (place) => (
              <button
                type="button"
                role="radio"
                aria-checked={value === place.path}
                key={place.path}
                className="picker-row"
                onClick={() => onChange(place.path)}
              >
                <Folder size={16} />
                <span>
                  <strong>{place.name}</strong>
                  <small>{place.path}</small>
                </span>
                {value === place.path ? <Check size={16} className="picker-enter" /> : null}
              </button>
            ),
          )}
        </div>
      )}
      <Err error={workspaces.error} />
      {roots.length || anyWorkspace ? (
        <button type="button" className="text-button" onClick={() => setBrowsing(value ?? null)}>
          {anyWorkspace ? '浏览其他目录' : '选择子目录'}
        </button>
      ) : null}
    </div>
  );
}
