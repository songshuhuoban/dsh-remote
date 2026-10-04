import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { asList, asRecord, runCommand } from './api';
import { Modal, Spinner, Err } from './ui';
export function ModelSettings({
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
  const edited = useRef(false);
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
    // Opening during history hydration must not freeze the first empty snapshot.
    // An explicit user edit wins over every background refresh.
    if (!edited.current) {
      const projection = asRecord(asRecord(asRecord(settings.data).projections).values);
      const projected = asRecord(projection.modelSelection);
      const candidates = [projected.next, projected.lastUsed, current, catalog.default].map(asRecord);
      const value = candidates.find((value) =>
        typeof value.provider === 'string' && typeof value.model === 'string' &&
        (!groups.length || groups.some((g) => asRecord(g).id === value.provider &&
          asList(g, 'models').some((m) => asRecord(m).id === value.model))),
      );
      if (!value) return;
      setProvider(String(value.provider ?? ''));
      setModel(String(value.model ?? ''));
      setEffort(String(value.reasoningEffort ?? ''));
    }
  }, [settings.data, current.provider, current.model, current.reasoningEffort]);
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
              aria-label="提供商"
              value={provider}
              onChange={(e) => {
                edited.current = true;
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
              aria-label="提供商"
              required
              value={provider}
              onChange={(e) => { edited.current = true; setProvider(e.target.value); }}
              placeholder="提供商标识"
            />
          )}
        </label>
        <label>
          模型
          {models.length ? (
            <select
              aria-label="模型"
              required
              value={model}
              onChange={(e) => {
                edited.current = true;
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
              aria-label="模型"
              required
              value={model}
              onChange={(e) => { edited.current = true; setModel(e.target.value); }}
              placeholder="模型标识"
            />
          )}
        </label>
        <label>
          推理强度 <span className="optional">可选</span>
          {efforts.length ? (
            <select aria-label="推理强度" value={effort} onChange={(e) => { edited.current = true; setEffort(e.target.value); }}>
              <option value="">使用默认值</option>
              {efforts.map((e) => (
                <option key={String(asRecord(e).id)} value={String(asRecord(e).id)}>
                  {String(asRecord(e).name ?? asRecord(e).id)}
                </option>
              ))}
            </select>
          ) : (
            <input
              aria-label="推理强度"
              value={effort}
              onChange={(e) => { edited.current = true; setEffort(e.target.value); }}
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
