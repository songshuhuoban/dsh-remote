import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check } from './icons';
import { asList, asRecord, runCommand } from './api';
import { Actions, Err, Field, Modal, NativeSelect, Spinner } from './ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
      const candidates = [projected.next, projected.lastUsed, current, catalog.default].map(
        asRecord,
      );
      const value = candidates.find(
        (value) =>
          typeof value.provider === 'string' &&
          typeof value.model === 'string' &&
          (!groups.length ||
            groups.some(
              (g) =>
                asRecord(g).id === value.provider &&
                asList(g, 'models').some((m) => asRecord(m).id === value.model),
            )),
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
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        {settings.isPending && (
          <div className="flex items-center gap-2 text-sm text-caption">
            <Spinner />
            读取模型目录…
          </div>
        )}
        <Err error={settings.error} />
        <Field label="提供商">
          {groups.length ? (
            <NativeSelect
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
            </NativeSelect>
          ) : (
            <Input
              aria-label="提供商"
              required
              value={provider}
              onChange={(e) => {
                edited.current = true;
                setProvider(e.target.value);
              }}
              placeholder="提供商标识"
            />
          )}
        </Field>
        <Field label="模型">
          {models.length ? (
            <NativeSelect
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
            </NativeSelect>
          ) : (
            <Input
              aria-label="模型"
              required
              value={model}
              onChange={(e) => {
                edited.current = true;
                setModel(e.target.value);
              }}
              placeholder="模型标识"
            />
          )}
        </Field>
        <Field
          label={
            <span>
              推理强度 <span className="font-normal text-caption">可选</span>
            </span>
          }
        >
          {efforts.length ? (
            <NativeSelect
              aria-label="推理强度"
              value={effort}
              onChange={(e) => {
                edited.current = true;
                setEffort(e.target.value);
              }}
            >
              <option value="">使用默认值</option>
              {efforts.map((e) => (
                <option key={String(asRecord(e).id)} value={String(asRecord(e).id)}>
                  {String(asRecord(e).name ?? asRecord(e).id)}
                </option>
              ))}
            </NativeSelect>
          ) : (
            <Input
              aria-label="推理强度"
              value={effort}
              onChange={(e) => {
                edited.current = true;
                setEffort(e.target.value);
              }}
              placeholder="留空使用模型默认值"
            />
          )}
        </Field>
        {asList(catalog, 'failures').map((f) => (
          <Err key={String(asRecord(f).id)} error={`${asRecord(f).name}: ${asRecord(f).message}`} />
        ))}
        <details className="group rounded-xl bg-accent/60 px-3 py-2.5">
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground select-none">
            权限与 Agent 预设
          </summary>
          <div className="mt-3 grid gap-3">
            <p className="text-sm text-caption">
              只显示主机允许远程选择的预设。Agent 预设仅能在首轮任务前更改
            </p>
            <div className="flex items-end gap-2">
              <Field label="权限预设" className="flex-1">
                <NativeSelect
                  aria-label="权限预设"
                  value={permission}
                  onChange={(e) => setPermission(e.target.value)}
                >
                  <option value="">选择权限预设</option>
                  {asList(settings.data, 'allowedPermissionPresets').map((p) => (
                    <option key={String(p)} value={String(p)}>
                      {String(p)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Button
                type="button"
                variant="outline"
                className="h-10"
                disabled={!canWrite || !permission || settingsMutation.isPending}
                onClick={() =>
                  settingsMutation.mutate({ key: 'permissionPreset', value: permission })
                }
              >
                应用权限
              </Button>
            </div>
            <div className="flex items-end gap-2">
              <Field label="Agent 预设" className="flex-1">
                <NativeSelect
                  aria-label="Agent 预设"
                  value={preset}
                  onChange={(e) => setPreset(e.target.value)}
                >
                  <option value="">选择 Agent 预设</option>
                  {asList(settings.data, 'allowedAgentPresets').map((p) => (
                    <option key={String(p)} value={String(p)}>
                      {String(p)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Button
                type="button"
                variant="outline"
                className="h-10"
                disabled={!canWrite || !preset || settingsMutation.isPending}
                onClick={() => settingsMutation.mutate({ key: 'agentPreset', value: preset })}
              >
                应用预设
              </Button>
            </div>
            <Err error={settingsMutation.error} />
          </div>
        </details>
        <details className="group rounded-xl bg-accent/60 px-3 py-2.5">
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground select-none">
            查看实例配置快照
          </summary>
          <pre className="mt-2 max-h-60 overflow-auto rounded-lg bg-background p-2 font-mono text-xs leading-5 text-muted-foreground">
            {JSON.stringify(asRecord(settings.data).projections ?? {}, null, 2)}
          </pre>
        </details>
        <Err error={mutation.error} />
        <Actions>
          <Button disabled={!canWrite || mutation.isPending || !provider || !model}>
            {mutation.isPending ? <Spinner /> : <Check size={16} />}应用配置
          </Button>
          <Button variant="outline" type="button" onClick={onClose} disabled={mutation.isPending}>
            取消
          </Button>
        </Actions>
      </form>
    </Modal>
  );
}
