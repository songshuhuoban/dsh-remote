/** Synthetic interaction model. Never connects to DSH or persists secrets. */
export const DEADLINE_MS = 8000;
const session = (id, title, cold = false) => ({ id, title, cold, run: 'idle', draft: '', queue: [], attachment: null, approval: null, command: null, model: 'DeepSeek V4', permission: 'Read-only', messages: [], refs: [] });
const instance = (id, label, workspace, online, owner = null) => ({ id, label, workspace, connection: online ? 'online' : 'offline', writer: 'observer', owner, fence: 1, pending: null, notice: '', sessions: [session('active', '梳理远程控制的边界'), session('cold', '上次的架构讨论', true)], selected: 'active', observedAt: '14:32:08', generation: 1, localRepos: {} });
export function initialState() {
  return { auth: 'signedIn', epoch: 1, counter: 0, selected: 'mac', modal: null, page: 'conversation', theme: 'light', fault: 'normal', mobileNav: false, toast: '', notice: '', authPending: null, github: { status: 'disconnected', pending: null, repositories: [{ id: 'core', name: 'demo-team/harness-core', branch: 'main' }, { id: 'docs', name: 'demo-team/docs', branch: 'main' }, { id: 'client', name: 'demo-team/client', branch: 'develop' }] }, devices: [{ id: 'current', label: '当前浏览器', current: true }, { id: 'phone', label: 'iPhone · 示例设备', current: false }], instances: [instance('mac', '工作 Mac', '/work/dsh-remote', true), instance('linux', 'Linux 开发机', '/srv/research', true, '另一台浏览器'), instance('offline', '家中笔记本', '/home/work', false)] };
}
export const current = s => s.instances.find(i => i.id === s.selected);
export const selectedSession = s => current(s)?.sessions.find(x => x.id === current(s).selected);
export const canWrite = (s, i = current(s)) => s.auth === 'signedIn' && i?.connection === 'online' && i.writer === 'writer' && !i.pending;
const mutable = new Set(['create', 'resume', 'config', 'send', 'steer', 'queue', 'editQueue', 'deleteQueue', 'approval', 'upload', 'stop']);
const unsafeToResend = new Set(['create', 'resume', 'config', 'send', 'steer', 'queue', 'editQueue', 'deleteQueue', 'approval', 'stop']);
function invalidate(s, reason) {
  s.epoch++; s.authPending = null; s.github.pending = null; s.modal = null;
  for (const i of s.instances) { i.generation++; for (const r of Object.values(i.localRepos)) if (r.pending) { r.pending = null; r.status = 'error'; } i.pending = null; i.writer = 'observer'; if (i.owner === '当前浏览器') i.owner = null; for (const x of i.sessions) { if (x.command?.status === 'pending') x.command.status = 'indeterminate'; if (x.approval?.status === 'pending') x.approval.status = 'stale'; x.draft = ''; x.attachment = null; } }
  s.notice = reason;
}
function settle(s, i, p, outcome) {
  const x = i.sessions.find(x => x.id === p.session);
  i.pending = null;
  if (outcome !== 'ok') {
    i.notice = outcome === 'timeout' ? '等待已结束。先查询最新状态，再决定下一步' : outcome === 'cancel' ? '已停止等待；已发出的操作可能仍在执行' : '操作未完成，内容已保留。可以重试或返回';
    if (p.kind === 'acquire' || p.kind === 'takeover') i.writer = outcome === 'fail' ? 'denied' : 'observer';
    if (p.kind === 'connect' || p.kind === 'replay') i.connection = 'offline';
    if (x && unsafeToResend.has(p.kind)) { x.command = { id: p.id, kind: p.kind, status: 'indeterminate', payload: p.payload }; i.notice = '这条操作的结果尚未确认。请查询原操作，不要重复发送'; }
    if (x && p.kind === 'upload') x.attachment = { name: 'architecture.md', status: 'failed', progress: 42 };
    return;
  }
  i.notice = '';
  if (p.kind === 'acquire' || p.kind === 'takeover') { i.writer = 'writer'; i.owner = '当前浏览器'; i.fence++; s.toast = '主机已确认：你可以控制此实例'; if(p.kind==='takeover' && s.selected===i.id && s.modal?.type==='takeover') s.modal=null; }
  if (p.kind === 'connect' || p.kind === 'replay') { i.connection = 'online'; i.writer = 'observer'; i.notice = '已同步最新事件。控制权需要重新确认'; }
  if (p.kind === 'inspect') s.toast = '历史已加载，未唤醒会话';
  if (p.kind === 'create') { const n = session('session-' + p.id, p.payload.title || '新的会话'); i.sessions.unshift(n); i.selected = n.id; if(s.selected === i.id) s.modal = null; s.toast = '会话已创建'; }
  if (p.kind === 'resolve') { if (x?.command?.status === 'indeterminate') { const original = structuredClone(x.command); settle(s, i, { ...p, id: original.id, kind: original.kind, payload: original.payload }, 'ok'); i.notice = '原操作已查询确认。没有发送第二条命令'; } return; }
  if (!x) return;
  if (p.kind === 'resume') { x.cold = false; s.toast = '会话已显式恢复'; }
  if (p.kind === 'config') { x.model = p.payload.model; x.permission = p.payload.permission; if(s.selected === i.id) s.modal = null; s.toast = '配置已保存（模拟）'; }
  if (p.kind === 'send') { x.messages.push({ role: 'user', text: p.payload.text }); x.draft = ''; x.run = 'running'; x.attachment = null; }
  if (p.kind === 'steer') { x.messages.push({ role: 'system', text: '下个步骤边界采用：' + p.payload.text }); x.draft = ''; }
  if (p.kind === 'queue') { x.queue.push({ id: p.id, text: p.payload.text }); x.draft = ''; }
  if (p.kind === 'editQueue') { const q = x.queue.find(q => q.id === p.payload.id); if (q) q.text = p.payload.text; if(s.selected === i.id) s.modal = null; }
  if (p.kind === 'deleteQueue') x.queue = x.queue.filter(q => q.id !== p.payload.id);
  if (p.kind === 'stop') { x.run = 'idle'; s.toast = '当前轮次已停止'; }
  if (p.kind === 'approval' && x.approval?.status === 'pending' && x.approval.id === p.payload.approvalId) { x.approval.status = p.payload.choice === 'allow' ? 'allowed' : 'denied'; x.run = p.payload.choice === 'allow' ? 'running' : 'idle'; }
  if (p.kind === 'upload') x.attachment = { name: 'architecture.md', status: 'ready', progress: 100 };
  if (unsafeToResend.has(p.kind)) x.command = { id: p.id, kind: p.kind, status: 'confirmed', payload: p.payload };
}
export function reduce(state, event) {
  const s = structuredClone(state), i = current(s), x = selectedSession(s);
  s.toast = '';
  switch (event.type) {
    case 'GH_UNCONFIGURED': s.github.status = 'unconfigured'; s.github.pending = null; break;
    case 'GH_EMPTY': s.github.repositories = []; break;
    case 'GH_INACCESSIBLE': s.github.status = 'inaccessible'; s.github.pending = null; break;
    case 'GH_START': if (!s.github.pending) { s.github.status = 'authorizing'; s.github.pending = { id: ++s.counter, epoch: s.epoch, deadline: (event.now || 0) + DEADLINE_MS }; } break;
    case 'GH_RESULT': if (s.github.pending?.id === event.id && s.github.pending.epoch === s.epoch) { s.github.pending = null; s.github.status = event.outcome === 'ok' ? 'connected' : 'reauth'; s.toast = event.outcome === 'ok' ? '模拟 GitHub 授权已完成' : '授权未完成，可以重试或取消'; } break;
    case 'GH_CANCEL': s.github.pending = null; s.github.status = 'disconnected'; break;
    case 'GH_REVOKE': s.github.pending = null; s.github.status = 'disconnected'; s.modal = null; for (const z of s.instances) for (const r of Object.values(z.localRepos)) if (['cloning','checking'].includes(r.status)) { r.status = 'error'; r.pending = null; } s.toast = 'GitHub 授权已断开；已存在的本地工作副本没有删除'; break;
    case 'GH_EXPIRE': s.github.pending = null; s.github.status = 'reauth'; break;
    case 'BIND_REPOS': if (i && canWrite(s) && s.github.status === 'connected') { for (const id of event.ids) { const repo = s.github.repositories.find(r => r.id === id); if (repo && !i.localRepos[id]) i.localRepos[id] = { ...repo, status: 'absent', path: event.paths?.[id] || i.workspace + '/repos/' + id, pending: null }; } s.toast = '已建立此实例的仓库引用，尚未拉取文件'; } break;
    case 'CLONE_START': { const r = i?.localRepos[event.id]; if (r && canWrite(s) && s.github.status === 'connected' && !['cloning','checking'].includes(r.status)) { r.status = event.mode === 'clone' ? 'cloning' : 'checking'; r.pending = { id: ++s.counter, epoch: s.epoch, generation: i.generation, deadline: (event.now || 0) + DEADLINE_MS }; } break; }
    case 'CLONE_RESULT': { const z = s.instances.find(i => i.id === event.instance), r = z?.localRepos[event.repo]; if (r?.pending?.id === event.id && r.pending.epoch === s.epoch && r.pending.generation === z.generation && z.connection === 'online') { r.pending = null; r.status = event.outcome === 'ok' ? 'ready' : 'error'; } break; }
    case 'CLONE_CANCEL': { const r = i?.localRepos[event.id]; if (r) { r.pending = null; r.status = 'error'; } break; }
    case 'REPO_OUTDATED': if (i?.localRepos[event.id]) i.localRepos[event.id].status = 'outdated'; break;
    case 'ADD_REF': if (x && i?.localRepos[event.id]?.status === 'ready' && !x.refs.includes(event.id)) { x.refs.push(event.id); s.page = 'conversation'; } break;
    case 'REMOVE_REF': if (x) x.refs = x.refs.filter(id => id !== event.id); break;
    case 'STATUS_REFRESH': if (i) { i.observedAt = event.observedAt || '14:32:30'; i.notice = i.connection === 'online' ? '刚刚查询：主机可达' : '刚刚查询：无法确认主机在线。上次快照仍可查看'; } break;
    case 'STATUS_STALE': if (i) { i.generation++; if (i.pending) settle(s, i, i.pending, 'timeout'); for (const r of Object.values(i.localRepos)) if (r.pending) { r.pending = null; r.status = 'error'; } i.connection = 'stale'; i.writer = 'observer'; i.notice = '状态已过期；无法确认主机当前在线。先查询或重连'; } break;
    case 'FAULT': s.fault = event.value; break;
    case 'THEME': s.theme = s.theme === 'light' ? 'dark' : 'light'; break;
    case 'NAV': s.page = event.page; s.mobileNav = false; s.modal = null; break;
    case 'MOBILE_NAV': s.mobileNav = !s.mobileNav; break;
    case 'MODAL': s.modal = event.value; break;
    case 'SELECT_INSTANCE': if (s.instances.some(i => i.id === event.id)) { s.selected = event.id; s.page = 'conversation'; s.mobileNav = false; s.modal = null; } break;
    case 'SELECT_SESSION': if (i?.sessions.some(x => x.id === event.id)) { i.selected = event.id; s.page = 'conversation'; s.mobileNav = false; s.modal = null; } break;
    case 'DRAFT': if (x) x.draft = event.value; break;
    case 'SIGN_OUT': invalidate(s, '你已退出，待确认操作不会自动重发'); s.auth = 'signedOut'; break;
    case 'REVOKE': if (event.id === 'current') { invalidate(s, '当前设备已撤销，请重新登录'); s.auth = 'revoked'; } else { s.devices = s.devices.filter(d => d.id !== event.id); s.toast = '示例设备已撤销'; s.modal = null; } break;
    case 'LOGIN_START': if (s.auth !== 'signedIn' && !s.authPending) { s.auth = 'signingIn'; s.authPending = { id: ++s.counter, deadline: (event.now || 0) + DEADLINE_MS }; s.notice = ''; } break;
    case 'LOGIN_RESULT': if (s.authPending?.id === event.id) { s.authPending = null; s.auth = event.outcome === 'ok' ? 'signedIn' : 'signedOut'; s.notice = event.outcome === 'ok' ? '' : '登录未完成，可以重试或返回演示'; } break;
    case 'LOGIN_CANCEL': s.authPending = null; s.auth = 'signedOut'; s.notice = '已取消登录'; break;
    case 'REGISTER_INSTANCE': { const id = 'instance-' + ++s.counter; s.instances.push(instance(id, event.label || '新的实例', '/work/project', false)); s.selected = id; s.modal = { type: 'pair', step: 2 }; break; }
    case 'RELEASE': if (i) { if(i.pending) settle(s, i, i.pending, 'cancel'); i.writer = 'observer'; if (i.owner === '当前浏览器') i.owner = null; i.notice = '已释放控制权，可以继续只读查看'; } break;
    case 'DISCONNECT': if (i) { i.generation++; for (const r of Object.values(i.localRepos)) if (r.pending) { r.pending = null; r.status = 'error'; } if (i.pending) settle(s, i, i.pending, 'timeout'); i.connection = 'offline'; i.writer = 'observer'; for (const x of i.sessions) if (x.approval?.status === 'pending') x.approval.status = 'stale'; i.notice = '连接已断开。草稿保留，发送已暂停'; } break;
    case 'APPROVAL_EXPIRE': if (x?.approval) x.approval.status = 'stale'; break;
    case 'DEMO_APPROVAL': if (x && canWrite(s)) { x.approval = { id: 'approval-' + ++s.counter, status: 'pending' }; x.run = 'waiting'; } break;
    case 'DEMO_FINISH': if (x && x.run === 'running') { x.run = 'idle'; x.messages.push({ role: 'assistant', text: '已梳理完当前路径。控制权变更须等主机确认；结果不明的命令保留原 ID 查询，避免重复执行。\n\n这是交互原型的模拟回复，没有调用模型或运行工具。' }); } break;
    case 'REMOVE_ATTACHMENT': if (x && x.attachment?.status !== 'uploading') x.attachment = null; break;
    case 'START': {
      if (!i || s.auth !== 'signedIn' || i.pending) break;
      const kind = event.kind, payload = event.payload || {};
      if (mutable.has(kind) && (!canWrite(s) || (x?.cold && kind !== 'resume') || (x?.command?.status === 'indeterminate' && kind !== 'upload'))) { i.notice = '先恢复连接、确认控制权和原操作状态，再继续'; break; }
      if ((kind === 'acquire' || kind === 'takeover') && i.connection !== 'online') break;
      if (kind === 'acquire' && i.owner && i.owner !== '当前浏览器') { i.writer = 'denied'; i.notice = '另一台设备正在控制。请先明确请求接管'; break; }
      if (kind === 'approval' && (x?.approval?.status !== 'pending' || x.approval.id !== payload.approvalId)) { i.notice = '审批已过期，不能再提交'; break; }
      if (['send', 'steer', 'queue'].includes(kind) && !payload.text?.trim()) break;
      if (kind === 'send' && x.refs.some(id => i.localRepos[id]?.status !== 'ready')) { i.notice = '仓库引用尚未就绪，请同步或移除后发送'; break; }
      if (kind === 'send' && (x.run !== 'idle' || (x.attachment && x.attachment.status !== 'ready'))) break;
      if (['steer','queue'].includes(kind) && x.run !== 'running') break;
      const p = { id: ++s.counter, epoch: s.epoch, instance: i.id, session: i.selected, kind, payload, deadline: (event.now || 0) + DEADLINE_MS }; i.pending = p; i.notice = '';
      if (kind === 'acquire' || kind === 'takeover') i.writer = 'pendingAck';
      if (kind === 'connect' || kind === 'replay') i.connection = kind === 'connect' ? 'connecting' : 'replaying';
      if (x && kind === 'upload') x.attachment = { name: 'architecture.md', status: 'uploading', progress: 42 };
      if (x && unsafeToResend.has(kind)) x.command = { id: p.id, status: 'pending', kind, payload };
      break;
    }
    case 'RESULT': { const target = s.instances.find(i => i.id === event.instance); const p = target?.pending; if (p?.id === event.id && p.epoch === s.epoch) settle(s, target, p, event.outcome); break; }
    case 'CANCEL': { const target = s.instances.find(i => i.id === (event.instance || s.selected)); if (target?.pending) settle(s, target, target.pending, 'cancel'); s.modal = null; break; }
    case 'TICK': { if (s.authPending && event.now >= s.authPending.deadline) { s.authPending = null; s.auth = 'signedOut'; s.notice = '登录超时，请重试'; } if (s.github.pending && event.now >= s.github.pending.deadline) { s.github.pending = null; s.github.status = 'reauth'; } for (const target of s.instances) for (const r of Object.values(target.localRepos)) if (r.pending && event.now >= r.pending.deadline) { r.pending = null; r.status = 'error'; } for (const target of s.instances) if (target.pending && event.now >= target.pending.deadline) settle(s, target, target.pending, 'timeout'); break; }
  }
  return s;
}
