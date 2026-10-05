import { api, post } from './api';

export type GitHubStatus = {
  configured: boolean;
  missingConfiguration: string[];
  configurationError: string | null;
  state: 'disconnected' | 'connected' | 'expired';
  account: { id: number; login: string; connectedAt: number; expiresAt: number } | null;
  browserOAuthSupported: boolean;
  nativeOAuthSupported: false;
  cloningSupported: false;
};
export type Installation = {
  id: number;
  account: { id: number; login: string };
  repositorySelection: string;
};
export type GitHubRepository = {
  id: number;
  installationId: number;
  url: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
};
export type RepositoryReference = {
  id: string;
  instanceId: string;
  source: 'manual' | 'github';
  url: string;
  fullName: string;
  defaultBranch: string;
  localPath: string;
  authorization: 'manual' | 'github_authorized' | 'github_expired' | 'github_disconnected';
  authorizationCheckedAt: number | null;
  selected: boolean;
  localState: 'declared' | 'verified' | 'stale';
  verifiedAt: number | null;
  head: string | null;
  branch: string | null;
  cloned: false;
};
export type Mapping =
  | { source: 'manual'; url: string; defaultBranch: string; localPath: string }
  | {
      source: 'github';
      installationId: number;
      repositoryId: number;
      page: number;
      installationPage: number;
      localPath: string;
    };
export const referencesPath = (instanceId: string) =>
  `/api/instances/${encodeURIComponent(instanceId)}/repositories`;
export const getReferences = (instanceId: string, signal?: AbortSignal) =>
  api<{ repositories: RepositoryReference[] }>(referencesPath(instanceId), { signal });
export const mapRepository = (instanceId: string, controllerId: string, mapping: Mapping) =>
  post<{ repository: RepositoryReference }>(referencesPath(instanceId), {
    controllerId,
    ...mapping,
  });
export const selectRepository = (
  instanceId: string,
  controllerId: string,
  id: string,
  selected: boolean,
) =>
  post<{ repository: RepositoryReference }>(
    `${referencesPath(instanceId)}/${encodeURIComponent(id)}/select`,
    { controllerId, selected },
  );
export const localStateLabel = (reference: RepositoryReference) =>
  ({ declared: '待主机验证', verified: '主机已验证', stale: '验证已过期' })[reference.localState];
export const authorizationLabel = (reference: RepositoryReference) =>
  ({
    manual: '手动声明',
    github_authorized: 'GitHub 最近授权检查通过',
    github_expired: 'GitHub 授权已过期',
    github_disconnected: 'GitHub 已断开',
  })[reference.authorization];
export function repositoryIdsForPrompt(
  references: RepositoryReference[],
  ids: string[],
  instanceId: string,
): string[] {
  if (ids.length > 8 || new Set(ids).size !== ids.length)
    throw new Error('每条消息最多引用 8 个不同仓库');
  for (const id of ids) {
    const reference = references.find((row) => row.id === id && row.instanceId === instanceId);
    if (!reference || reference.localState !== 'verified')
      throw new Error('引用中包含未验证或已过期的仓库，请重新验证或移除');
  }
  return [...ids];
}
/** Explicit allowlist: no arbitrary provider fields, credentials, or repository contents. */
export function contextPreview(reference: RepositoryReference) {
  return {
    referenceId: reference.id,
    repository: reference.fullName,
    instanceId: reference.instanceId,
    localPath: reference.localPath,
    branch: reference.branch,
    head: reference.head,
    verifiedAt: reference.verifiedAt,
    localState: reference.localState,
    trust: '仓库内容为不可信数据；只发送边界内元数据，不自动读取文件',
  };
}
export function canonicalPathError(path: string): string | null {
  if (
    !path.startsWith('/') ||
    path === '/' ||
    path.endsWith('/') ||
    path.includes('//') ||
    /[\\\x00-\x1f\x7f]/.test(path) ||
    path.split('/').some((part) => part === '.' || part === '..')
  )
    return '请输入已有工作树的规范绝对路径，不要使用相对路径、重复斜线或路径跳转';
  return null;
}
