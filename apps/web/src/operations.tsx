import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  CommandAdmissionError,
  CommandError,
  errorText,
  queryCommand,
  runCommand,
} from './api';
import { Button } from '@/components/ui/button';

export type Operation = {
  id: string;
  instanceId: string;
  controllerId: string;
  action: string;
  args: Record<string, unknown>;
  leaseEpoch: number;
  references: { repositoryId?: string; repositoryIds?: string[] };
  state: 'pending' | 'uncertain';
  error?: string;
};
export function uncertainError(error: unknown) {
  if (error instanceof CommandError)
    return !['succeeded', 'failed', 'rejected', 'cancelled'].includes(error.command.status);
  // A rejected POST is definitive. Transport errors, HTTP 5xx and failed GETs are not.
  return !(error instanceof CommandAdmissionError);
}
function metadata(operation: Operation) {
  return {
    id: operation.id,
    instanceId: operation.instanceId,
    controllerId: operation.controllerId,
    action: operation.action,
  };
}
function restoreMetadata(key: string): Operation[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value
      .slice(0, 128)
      .filter(
        (op) =>
          op &&
          ['id', 'instanceId', 'controllerId', 'action'].every(
            (key) => typeof op[key] === 'string',
          ),
      )
      .map((op) => ({
        ...metadata(op),
        args: {},
        references: {},
        leaseEpoch: 0,
        state: 'uncertain',
        error: '从其他浏览器标签页恢复的原命令。只会查询此 ID，不会重新发送',
      }));
  } catch {
    return [];
  }
}
const Context = createContext<{
  operations: Operation[];
  run: (request: Omit<Operation, 'id' | 'state'>, id?: string) => Promise<unknown>;
  stop: (id: string) => void;
  reconcile: (id: string) => Promise<void>;
} | null>(null);
export function OperationsProvider({
  accountId,
  children,
}: {
  accountId: string;
  children: ReactNode;
}) {
  const key = `dsh.operations.${accountId}`;
  // localStorage is origin-isolated. Only identifiers survive a closed tab;
  // prompt bodies, files, local paths and credentials never enter this journal.
  const metadataKey = `dsh.unresolved.${accountId}`;
  const [operations, setOperations] = useState<Operation[]>(() => {
    try {
      const exact: Operation[] = JSON.parse(sessionStorage.getItem(key) ?? '[]').map(
        (op: Operation) => ({
          ...op,
          state: 'uncertain',
        }),
      );
      return [
        ...exact,
        ...restoreMetadata(metadataKey).filter((op) => !exact.some((item) => item.id === op.id)),
      ];
    } catch {
      return restoreMetadata(metadataKey);
    }
  });
  const current = useRef(operations),
    aborts = useRef(new Map<string, AbortController>()),
    client = useQueryClient();
  const save = (next: Operation[], admission = false) => {
    // Persist exact admission body before network dispatch. If quota/storage fails,
    // fail before sending rather than lose recovery identity (including attachments).
    let previousSession: string | null = null;
    try {
      previousSession = sessionStorage.getItem(key);
      const others = restoreMetadata(metadataKey).filter(
        (op) => !current.current.some((item) => item.id === op.id),
      );
      const all = [...next, ...others];
      if (admission && all.length > 128) throw new Error('Recovery journal full');
      if (next.length) sessionStorage.setItem(key, JSON.stringify(next));
      else sessionStorage.removeItem(key);
      if (all.length) localStorage.setItem(metadataKey, JSON.stringify(all.map(metadata)));
      else localStorage.removeItem(metadataKey);
    } catch {
      if (admission) {
        try {
          if (previousSession === null) sessionStorage.removeItem(key);
          else sessionStorage.setItem(key, previousSession);
        } catch {
          /* No request has been dispatched. */
        }
        throw new Error(
          '无法在此浏览器保存恢复记录。尚未发送命令；请减少附件大小或允许此站点使用会话存储',
        );
      }
    }
    current.current = next;
    setOperations(next);
  };
  useEffect(() => {
    const updated = (event: StorageEvent) => {
      if (event.key !== metadataKey) return;
      const restored = restoreMetadata(metadataKey).filter(
        (op) => !current.current.some((item) => item.id === op.id),
      );
      if (restored.length) {
        current.current = [...current.current, ...restored];
        setOperations(current.current);
      }
    };
    window.addEventListener('storage', updated);
    return () => window.removeEventListener('storage', updated);
  }, [metadataKey]);
  const finish = (id: string) => {
    save(current.current.filter((op) => op.id !== id));
    void client.invalidateQueries({ queryKey: ['remote'] });
    void client.invalidateQueries({ queryKey: ['repositories'] });
    void client.invalidateQueries({ queryKey: ['instances'] });
  };
  return (
    <Context.Provider
      value={{
        operations,
        async run(request, id = crypto.randomUUID()) {
          if (
            [...current.current, ...restoreMetadata(metadataKey)].some(
              (op) => op.instanceId === request.instanceId,
            )
          )
            throw new Error('请先查询此实例上尚未确认的原命令，不要重复提交');
          const operation: Operation = { ...structuredClone(request), id, state: 'pending' };
          save([...current.current, operation], true);
          const abort = new AbortController();
          aborts.current.set(id, abort);
          try {
            const result = await runCommand(
              operation.instanceId,
              operation.controllerId,
              operation.action,
              operation.args,
              operation.leaseEpoch,
              abort.signal,
              id,
              operation.references,
            );
            finish(id);
            return result;
          } catch (error) {
            if (uncertainError(error))
              save(
                current.current.map((op) =>
                  op.id === id
                    ? { ...op, state: 'uncertain', error: errorText(error).slice(0, 640) }
                    : op,
                ),
              );
            else finish(id);
            throw error;
          } finally {
            aborts.current.delete(id);
          }
        },
        stop(id) {
          aborts.current.get(id)?.abort();
        },
        async reconcile(id) {
          try {
            const command = await queryCommand(id);
            if (
              !['succeeded', 'failed', 'rejected', 'cancelled'].includes(command.status) ||
              command.id !== id
            ) {
              save(
                current.current.map((op) =>
                  op.id === id
                    ? {
                        ...op,
                        state: 'uncertain',
                        error: `原命令状态：${command.status}。继续查看历史或稍后查询；不会重新发送`,
                      }
                    : op,
                ),
              );
            } else {
              finish(id);
              if (command.status !== 'succeeded')
                throw new CommandError(errorText(command.error ?? command.status), command);
            }
          } catch (error) {
            if (error instanceof ApiError && error.status === 404)
              throw new Error('暂未查到原命令；它可能仍在提交。保留原 ID，稍后再查');
            throw error;
          }
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useOperations() {
  const value = useContext(Context);
  if (!value) throw new Error('OperationsProvider missing');
  return value;
}
export function RecoveryPanel({ instanceId }: { instanceId?: string }) {
  const { operations, stop, reconcile } = useOperations(),
    [reading, setReading] = useState(false),
    [error, setError] = useState('');
  const operation = operations.find((op) => op.instanceId === instanceId);
  if (!operation) return null;
  return (
    <section className="swap px-6 max-md:px-3" role="status" aria-label="命令恢复">
      <div className="mx-auto flex max-w-[760px] flex-wrap items-center gap-3 rounded-xl bg-warning-surface px-4 py-3">
        <div className="grid min-w-0 flex-1 gap-0.5">
          <strong className="text-base font-medium">
            {operation.state === 'pending' ? '正在等待主机确认' : '原命令结果尚未确认'}
          </strong>
          <p className="truncate text-sm text-muted-foreground">
            {operation.action} · <code className="font-mono text-xs">{operation.id}</code>
          </p>
          <p className="text-sm text-muted-foreground">
            {operation.error ?? '可以停止等待或离开此页面。停止等待不会取消已提交的主机操作'}
          </p>
        </div>
        {operation.state === 'pending' ? (
          <Button size="sm" variant="outline" onClick={() => stop(operation.id)}>
            停止等待
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={reading}
            onClick={async () => {
              setReading(true);
              setError('');
              try {
                await reconcile(operation.id);
              } catch (e) {
                setError(errorText(e));
              } finally {
                setReading(false);
              }
            }}
          >
            {reading ? '正在查询…' : '查询原命令'}
          </Button>
        )}
        {error && (
          <p role="alert" className="w-full text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
