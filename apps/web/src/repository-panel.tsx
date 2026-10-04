import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { Plus, X, RefreshCw, Check } from './icons';
import {
  api,
  errorText,
  isOnline,
  leaseActive,
  post,
  timeLabel,
  type Controller,
  type Instance,
  type Lease,
} from './api';
import {
  authorizationLabel,
  canonicalPathError,
  getReferences,
  localStateLabel,
  mapRepository,
  selectRepository,
  type GitHubRepository,
  type GitHubStatus,
  type Installation,
  type Mapping,
  type RepositoryReference,
} from './repositories';
import { Err, Modal, Spinner } from './ui';
import { useOperations } from './operations';

type Choice = { repo: GitHubRepository; page: number; installationPage: number; localPath: string };
export function RepositoryPanel({
  instance,
  controller,
  lease,
  onClose,
}: {
  instance?: Instance;
  controller: Controller;
  lease: Lease | null;
  onClose: () => void;
}) {
  const client = useQueryClient(),
    operations = useOperations();
  const [installationPage, setInstallationPage] = useState(1),
    [page, setPage] = useState(1),
    [installation, setInstallation] = useState<number>(),
    [choices, setChoices] = useState<Choice[]>([]),
    [search, setSearch] = useState(''),
    [mappingOpen, setMappingOpen] = useState(false),
    [manualOpen, setManualOpen] = useState(false),
    [url, setUrl] = useState(''),
    [branch, setBranch] = useState('main'),
    [path, setPath] = useState(''),
    [confirmDisconnect, setConfirmDisconnect] = useState(false),
    [notice, setNotice] = useState(''),
    [authBusy, setAuthBusy] = useState(false),
    [authError, setAuthError] = useState(''),
    [authStarted, setAuthStarted] = useState(!!sessionStorage.getItem('dsh.githubFlow'));
  const attempt = useRef(0);
  useEffect(
    () => () => {
      attempt.current += 1;
    },
    [],
  );
  const status = useQuery({
    queryKey: ['github', 'status'],
    refetchInterval: 60000,
    queryFn: ({ signal }) => api<GitHubStatus>('/api/github/status', { signal }),
  });
  const connected = status.data?.state === 'connected';
  const installations = useQuery({
    queryKey: ['github', 'installations', installationPage],
    enabled: connected,
    queryFn: ({ signal }) =>
      api<{ installations: Installation[]; hasMore: boolean }>(
        `/api/github/installations?page=${installationPage}`,
        { signal },
      ),
  });
  const repositories = useQuery({
    queryKey: ['github', 'repositories', installation, page, installationPage],
    enabled: connected && !!installation,
    queryFn: ({ signal }) =>
      api<{ repositories: GitHubRepository[]; hasMore: boolean }>(
        `/api/github/repositories?installationId=${installation}&page=${page}&installationPage=${installationPage}`,
        { signal },
      ),
  });
  const references = useQuery({
    queryKey: ['repositories', instance?.id],
    enabled: !!instance,
    queryFn: ({ signal }) => getReferences(instance!.id, signal),
  });
  const writable =
    !!instance &&
    isOnline(instance) &&
    !!lease &&
    leaseActive(lease) &&
    !operations.operations.some((op) => op.instanceId === instance.id);
  const reload = () => {
    void client.invalidateQueries({ queryKey: ['github'] });
    void references.refetch();
  };
  const refreshReferences = () => {
    void client.invalidateQueries({ queryKey: ['repositories', instance?.id] });
  };
  const mapping = useMutation({
    mutationFn: async (rows: Mapping[]) => {
      if (!instance) throw new Error('请先选择目标实例');
      for (const row of rows) {
        const error = canonicalPathError(row.localPath);
        if (error) throw new Error(error);
      }
      for (const row of rows) {
        await mapRepository(instance.id, controller.id, row);
        // Remove each confirmed mapping from retry selection. A later row failing must
        // never silently recreate the already-successful references.
        if (row.source === 'github')
          setChoices((old) => old.filter((item) => item.repo.id !== row.repositoryId));
        refreshReferences();
      }
    },
    onError: () => {
      refreshReferences();
      setNotice('请刷新下方引用列表确认已保存的映射；重复的相同路径不会创建副本');
    },
    onSuccess: () => {
      setMappingOpen(false);
      setManualOpen(false);
      setPath('');
      setNotice('映射已保存，仍需主机验证后才能引用');
    },
  });
  const select = useMutation({
    mutationFn: ({ row, selected }: { row: RepositoryReference; selected: boolean }) =>
      selectRepository(instance!.id, controller.id, row.id, selected),
    onSuccess: refreshReferences,
  });
  const inspect = useMutation({
    mutationFn: async (row: RepositoryReference) => {
      if (!writable || !lease) throw new Error('在线实例的当前控制设备才能验证工作树');
      return operations.run({
        instanceId: instance!.id,
        controllerId: controller.id,
        action: 'repository.inspect',
        args: {},
        leaseEpoch: lease.epoch,
        references: { repositoryId: row.id },
      });
    },
    onSettled: refreshReferences,
  });
  const install = useMutation({
    mutationFn: () =>
      post<{ installationUrl: string }>('/api/github/install', { controllerId: controller.id }),
    onSuccess: ({ installationUrl }) => {
      window.location.assign(installationUrl);
    },
  });
  const disconnect = useMutation({
    mutationFn: () =>
      post<{ manageUrl: string }>('/api/github/disconnect', { controllerId: controller.id }),
    onSuccess: () => {
      setConfirmDisconnect(false);
      sessionStorage.removeItem('dsh.githubFlow');
      setAuthStarted(false);
      reload();
      setNotice('本地 GitHub 授权已移除。GitHub App 本身仍保持安装，可在 GitHub 设置中撤销');
    },
  });
  async function authorize() {
    const generation = ++attempt.current;
    setAuthBusy(true);
    setAuthError('');
    setAuthStarted(true);
    try {
      const result = await post<{ authorizationUrl: string; expiresAt: number }>(
        '/api/github/authorize',
        { controllerId: controller.id },
      );
      if (attempt.current !== generation) return;
      sessionStorage.setItem('dsh.githubFlow', String(result.expiresAt));
      window.location.assign(result.authorizationUrl);
    } catch (e) {
      if (attempt.current === generation) setAuthError(errorText(e));
    } finally {
      if (attempt.current === generation) setAuthBusy(false);
    }
  }
  async function cancelAuthorization() {
    ++attempt.current;
    setAuthBusy(true);
    setAuthError('');
    try {
      await post('/api/github/cancel', { controllerId: controller.id });
      sessionStorage.removeItem('dsh.githubFlow');
      setAuthStarted(false);
      setNotice('授权请求已取消，可继续使用手动工作树映射');
      reload();
    } catch (e) {
      setAuthError(errorText(e));
    } finally {
      setAuthBusy(false);
    }
  }
  return (
    <section className="repository-page" aria-label="GitHub 仓库与本地引用">
      <div className="repository-actions">
        <div>
          <h2>GitHub 仓库</h2>
          <p>授权、实例映射与主机验证分别管理。不会自动克隆或读取仓库文件</p>
        </div>
        <button className="quiet" onClick={onClose}>
          <X size={16} />
          返回会话
        </button>
      </div>
      {notice && (
        <div className="notice" role="status">
          {notice}
          <button className="icon-button" aria-label="关闭仓库提示" onClick={() => setNotice('')}>
            <X size={14} />
          </button>
        </div>
      )}
      <Err error={status.error || authError || install.error || disconnect.error} />
      <section className="repository-status">
        <GitBranch size={22} />
        <div>
          <h3>
            {status.isPending
              ? '正在读取 GitHub 状态…'
              : !status.data?.configured
                ? '此部署尚未配置 GitHub App'
                : connected
                  ? `已连接 ${status.data.account?.login}`
                  : status.data.state === 'expired'
                    ? 'GitHub 授权已过期'
                    : 'GitHub 尚未连接'}
          </h3>
          <p>
            {connected
              ? `授权到期：${timeLabel(status.data?.account?.expiresAt)}。仓库权限将在发现和选择时重新检查`
              : !status.data?.configured
                ? '管理员需配置只读 GitHub App。你仍可以映射实例上的已有工作树'
                : '在当前浏览器完成授权，只请求 Contents / Metadata 只读权限；可选择多个仓库'}
          </p>
        </div>
        <div className="repository-actions">
          <button className="quiet" onClick={reload} disabled={status.isFetching}>
            <RefreshCw size={15} />
            刷新状态
          </button>
          {connected ? (
            <>
              <button
                className="quiet"
                disabled={install.isPending}
                onClick={() => install.mutate()}
              >
                选择 GitHub 授权仓库
              </button>
              <button className="quiet" onClick={() => setConfirmDisconnect(true)}>
                断开 GitHub
              </button>
            </>
          ) : (
            <button
              className="primary"
              disabled={!status.data?.configured || !status.data.browserOAuthSupported || authBusy}
              onClick={() => void authorize()}
            >
              {authBusy ? <Spinner /> : <GitBranch size={15} />}连接 GitHub
            </button>
          )}
          {authStarted && (
            <button className="quiet" onClick={() => void cancelAuthorization()}>
              取消授权请求
            </button>
          )}
        </div>
      </section>
      {connected && (
        <section>
          <div className="repository-actions">
            <label>
              GitHub 安装
              <select
                aria-label="GitHub 安装"
                value={installation ?? ''}
                onChange={(e) => {
                  setInstallation(Number(e.target.value));
                  setPage(1);
                }}
              >
                <option value="" disabled>
                  选择组织或个人安装
                </option>
                {installations.data?.installations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.account.login} ·{' '}
                    {item.repositorySelection === 'all' ? '全部授权仓库' : '指定授权仓库'}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="quiet"
              disabled={installationPage <= 1}
              onClick={() => {
                setInstallationPage((n) => n - 1);
                setInstallation(undefined);
              }}
            >
              上一页安装
            </button>
            <span>安装页 {installationPage}</span>
            <button
              className="quiet"
              disabled={!installations.data?.hasMore}
              onClick={() => {
                setInstallationPage((n) => n + 1);
                setInstallation(undefined);
              }}
            >
              下一页安装
            </button>
          </div>
          <Err error={installations.error || repositories.error} />
          {!installations.isPending &&
            !installations.error &&
            !installations.data?.installations.length && (
              <p>没有可用安装。请在 GitHub 上选择仓库，然后返回刷新</p>
            )}
          {!!installation && (
            <>
              <label>
                筛选本页仓库
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="owner / repository"
                />
              </label>
              {repositories.isFetching && (
                <p>
                  <Spinner />
                  读取 GitHub 仓库…
                </p>
              )}
              <div className="repository-list">
                {repositories.data?.repositories
                  .filter((repo) => repo.fullName.toLowerCase().includes(search.toLowerCase()))
                  .map((repo) => (
                    <label className="repository-row" key={repo.id}>
                      <input
                        type="checkbox"
                        disabled={
                          !choices.some((choice) => choice.repo.id === repo.id) &&
                          choices.length >= 8
                        }
                        checked={choices.some((choice) => choice.repo.id === repo.id)}
                        onChange={(e) =>
                          setChoices((old) =>
                            e.target.checked
                              ? [...old, { repo, page, installationPage, localPath: '' }]
                              : old.filter((choice) => choice.repo.id !== repo.id),
                          )
                        }
                      />
                      <span>
                        <strong>{repo.fullName}</strong>
                        <small>
                          {repo.private ? '私有' : '公开'} · 默认分支 {repo.defaultBranch}
                          {repo.archived ? ' · 已归档' : ''}
                        </small>
                      </span>
                    </label>
                  ))}
              </div>
              {!repositories.isFetching &&
                !repositories.error &&
                !repositories.data?.repositories.filter((repo) =>
                  repo.fullName.toLowerCase().includes(search.toLowerCase()),
                ).length && <p>本页没有匹配仓库。清空筛选、翻页或调整 GitHub 安装权限</p>}
              <div className="repository-actions">
                <button
                  className="quiet"
                  disabled={page <= 1}
                  onClick={() => setPage((n) => n - 1)}
                >
                  上一页仓库
                </button>
                <span>仓库页 {page}</span>
                <button
                  className="quiet"
                  disabled={!repositories.data?.hasMore}
                  onClick={() => setPage((n) => n + 1)}
                >
                  下一页仓库
                </button>
              </div>
            </>
          )}
          {choices.length > 0 && (
            <div className="repository-actions">
              <span>已选 {choices.length}/8 个仓库（每批最多 8 个）</span>
              <button className="quiet" onClick={() => setChoices([])}>
                清空选择
              </button>
              <button className="primary" disabled={!instance} onClick={() => setMappingOpen(true)}>
                映射到 {instance?.name ?? '实例'}
              </button>
            </div>
          )}
        </section>
      )}
      <section>
        <div className="repository-actions">
          <div>
            <h3>{instance ? `${instance.name} · 本地工作树引用` : '请先选择或连接一个实例'}</h3>
            <p>已有本地工作树，不自动 clone、fetch 或切换分支</p>
          </div>
          <button
            className="quiet"
            disabled={!instance}
            onClick={() => {
              mapping.reset();
              setManualOpen(true);
            }}
          >
            <Plus size={15} />
            手动映射
          </button>
        </div>
        <Err error={references.error || select.error || inspect.error} />
        {!writable && instance && (
          <p className="tiny">当前可管理映射偏好；验证工作树需要在线状态和当前写入租约</p>
        )}
        <div className="repository-list">
          {references.data?.repositories.map((row) => (
            <article className="repository-row" key={row.id}>
              <div>
                <strong>{row.fullName}</strong>
                <small>
                  {localStateLabel(row)} · {authorizationLabel(row)}
                </small>
                <code>{row.localPath}</code>
                <small>
                  默认分支 {row.defaultBranch} · 实际分支 {row.branch ?? '尚未验证'}
                </small>
                <small>
                  验证时间：{timeLabel(row.verifiedAt)} · 授权检查：
                  {timeLabel(row.authorizationCheckedAt)}
                </small>
              </div>
              <div className="repository-actions">
                <label>
                  <input
                    type="checkbox"
                    checked={row.selected}
                    disabled={select.isPending}
                    onChange={(e) => select.mutate({ row, selected: e.target.checked })}
                  />
                  供消息引用
                </label>
                <button
                  className="quiet"
                  disabled={!writable || inspect.isPending}
                  onClick={() => inspect.mutate(row)}
                >
                  {inspect.isPending && inspect.variables?.id === row.id ? (
                    <Spinner />
                  ) : (
                    <Check size={15} />
                  )}
                  验证工作树
                </button>
              </div>
            </article>
          ))}
        </div>
        {!references.isPending && !references.data?.repositories.length && (
          <p>还没有本地引用。先映射已有路径，再由主机验证</p>
        )}
      </section>
      {(manualOpen || mappingOpen) && (
        <Modal
          title={manualOpen ? '映射已有工作树' : `映射 ${choices.length} 个已有工作树`}
          description={`目标实例：${instance?.name}。路径必须已存在于主机允许的目录内；保存后仍需验证`}
          onClose={() => {
            setManualOpen(false);
            setMappingOpen(false);
          }}
          busy={mapping.isPending}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              mapping.mutate(
                manualOpen
                  ? [{ source: 'manual', url, defaultBranch: branch, localPath: path }]
                  : choices.map((choice) => ({
                      source: 'github',
                      installationId: choice.repo.installationId,
                      repositoryId: choice.repo.id,
                      page: choice.page,
                      installationPage: choice.installationPage,
                      localPath: choice.localPath,
                    })),
              );
            }}
          >
            {manualOpen ? (
              <>
                <label>
                  GitHub 仓库 URL
                  <input
                    type="url"
                    required
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://github.com/owner/repo"
                  />
                </label>
                <label>
                  默认分支
                  <input required value={branch} onChange={(e) => setBranch(e.target.value)} />
                </label>
                <label>
                  已有工作树绝对路径
                  <input
                    required
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    placeholder="/allowed/existing/repo"
                  />
                </label>
              </>
            ) : (
              choices.map((choice) => (
                <label key={choice.repo.id}>
                  {choice.repo.fullName} · 已有工作树绝对路径
                  <input
                    required
                    value={choice.localPath}
                    onChange={(e) =>
                      setChoices((old) =>
                        old.map((item) =>
                          item.repo.id === choice.repo.id
                            ? { ...item, localPath: e.target.value }
                            : item,
                        ),
                      )
                    }
                    placeholder="/allowed/existing/repo"
                  />
                </label>
              ))
            )}
            <Err error={mapping.error} />
            <div className="modal-actions">
              <button
                className="quiet"
                type="button"
                disabled={mapping.isPending}
                onClick={() => {
                  setManualOpen(false);
                  setMappingOpen(false);
                }}
              >
                取消
              </button>
              <button
                className="primary"
                disabled={mapping.isPending || (!manualOpen && !choices.length)}
              >
                {mapping.isPending ? <Spinner /> : null}保存映射
              </button>
            </div>
          </form>
        </Modal>
      )}
      {confirmDisconnect && (
        <Modal
          title="断开 GitHub？"
          description="移除本服务保存的授权和未完成授权请求。本地工作树与映射仍保留；不会在 GitHub 上撤销授权或卸载 App"
          onClose={() => setConfirmDisconnect(false)}
        >
          <Err error={disconnect.error} />
          <div className="modal-actions">
            <button className="quiet" onClick={() => setConfirmDisconnect(false)}>
              取消
            </button>
            <button
              className="primary"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              确认断开
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
