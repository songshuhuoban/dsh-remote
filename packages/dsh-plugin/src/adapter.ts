import { randomUUID, createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import { inspectRepository, repositoryPromptContext } from './repositories.ts';
import type { RepositoryContext } from '../../protocol/src/index.ts';
import { validateCommand } from '../../protocol/src/validation.ts';
import type {
  Agent,
  ApprovalOutcome,
  ApprovalRequest,
  DshHostContext,
  Json,
  Session,
  SessionEvent,
} from './host.ts';

export const CAPABILITIES = [
  'repository.inspect',
  'session.list',
  'session.read',
  'session.page',
  'session.projections',
  'session.create',
  'session.prompt',
  'session.cancel',
  'session.resume',
  'session.queue.update',
  'model.select',
  'attachment.upload',
  'attachment.read',
  'approval.respond',
  'settings.describe',
  'settings.update',
  'capabilities',
];
export interface AdapterPolicy {
  allowedWorkspaceRoots: string[];
  allowedPermissionPresets?: string[];
  allowedAgentPresets?: string[];
  approvalTimeoutMs?: number;
}
export interface HostEvent {
  id: string;
  kind: string;
  sessionId?: string;
  payload: Json;
}
export class AdapterError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function json(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AdapterError('invalid_arguments', 'Arguments must be an object');
  return value as Record<string, unknown>;
}
function text(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim() || v.length > 4096)
    throw new AdapterError('invalid_arguments', `${key} must be a non-empty string`);
  return v;
}
function only(args: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Object.keys(args))
    if (!keys.includes(key))
      throw new AdapterError('invalid_arguments', `Unsupported argument ${key}`);
}

/** Real DSH adapter. Cold observations never call follow() or resolveAgent(). */
export class DshAdapter {
  private readonly pending = new Map<
    string,
    {
      request: ApprovalRequest;
      resolve: (outcome: ApprovalOutcome) => void;
      removeAbort: () => void;
      presentationHash: string;
    }
  >();
  private readonly serial = new Map<string, Promise<unknown>>();
  private readonly disposers: Array<() => void> = [];
  private available = false;
  private closed = false;
  readonly bootId = randomUUID();
  constructor(
    private readonly ctx: DshHostContext,
    private readonly emit: (event: HostEvent) => void,
    private readonly policy: AdapterPolicy,
  ) {
    if (!policy.allowedWorkspaceRoots.length)
      throw new AdapterError('configuration', 'At least one allowed workspace root is required');
    this.policy = {
      ...policy,
      allowedWorkspaceRoots: policy.allowedWorkspaceRoots.map((root) => realpathSync(root)),
    };
    this.disposers.push(
      ctx.on(
        'session/event',
        (session: Session, event: SessionEvent) =>
          this.permitted(session.header.cwd) &&
          this.publish({
            id: `session:${session.id}:${event.seq}`,
            sessionId: session.id,
            kind: 'session.event',
            payload: json(event),
          }),
        { global: true },
      ),
    );
    this.disposers.push(
      ctx.on(
        'agent/status',
        ({ agent, status }: { agent: Agent; status: string }) =>
          this.permitted(agent.session.header.cwd) &&
          this.publish({
            id: randomUUID(),
            sessionId: agent.id,
            kind: 'session.status',
            payload: json({ sessionId: agent.id, status, running: status === 'running' }),
          }),
        { global: true },
      ),
    );
    this.disposers.push(
      ctx.on(
        'agent/assistant-stream',
        ({ agent, frame }: { agent: Agent; frame: unknown }) =>
          this.permitted(agent.session.header.cwd) &&
          this.publish({
            id: randomUUID(),
            sessionId: agent.id,
            kind: 'assistant.stream',
            payload: json(frame),
          }),
        { global: true },
      ),
    );
    this.disposers.push(
      ctx.on(
        'session/created',
        (session: Session) =>
          this.permitted(session.header.cwd) &&
          this.publish({
            id: randomUUID(),
            sessionId: session.id,
            kind: 'session.added',
            payload: json({ sessionId: session.id, header: session.header }),
          }),
        { global: true },
      ),
    );
    this.disposers.push(
      ctx.on(
        'session/disposed',
        (session: Session) =>
          this.permitted(session.header.cwd) &&
          this.publish({
            id: randomUUID(),
            sessionId: session.id,
            kind: 'session.removed',
            payload: json({ sessionId: session.id }),
          }),
        { global: true },
      ),
    );
    this.disposers.push(
      ctx.on(
        'approval/request',
        (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => this.approve(req, next),
        { global: true, prepend: true },
      ),
    );
  }
  private permitted(cwd: unknown): boolean {
    if (typeof cwd !== 'string') return false;
    try {
      const target = realpathSync(cwd);
      return this.policy.allowedWorkspaceRoots.some((root) => {
        const tail = relative(root, target);
        return (
          tail === '' ||
          (!tail.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) &&
            tail !== '..' &&
            !isAbsolute(tail))
        );
      });
    } catch {
      return false;
    }
  }
  private async checkSession(id: string): Promise<void> {
    const inspection = await this.ctx.sessionController.inspect(id);
    if (!this.permitted(inspection.meta.cwd))
      throw new AdapterError(
        'workspace_forbidden',
        'Session workspace is outside configured roots',
      );
  }
  private publish(event: HostEvent): void {
    if (!this.closed) this.emit(event);
  }
  setAvailable(available: boolean): void {
    this.available = available;
    if (available) this.replayApprovals();
  }
  replayApprovals(): void {
    for (const [approvalId, { request }] of this.pending) this.publishApproval(approvalId, request);
  }
  private approvalView(approvalId: string, request: ApprovalRequest): Json {
    return json({
      approvalId,
      bootId: this.bootId,
      sessionId: request.agent.id,
      toolName: request.toolName,
      callId: request.callId,
      reason: request.reason,
      presentationHash: this.pending.get(approvalId)?.presentationHash,
    });
  }
  private publishApproval(approvalId: string, request: ApprovalRequest): void {
    this.publish({
      id: `approval:${approvalId}:pending`,
      kind: 'approval.requested',
      sessionId: request.agent.id,
      payload: this.approvalView(approvalId, request),
    });
  }
  private approve(
    request: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    if (!this.available || this.closed || !this.permitted(request.agent.session.header.cwd))
      return next();
    if (request.signal?.aborted) return Promise.resolve('cancelled');
    const approvalId = randomUUID();
    const presentationHash = createHash('sha256')
      .update(
        JSON.stringify({
          bootId: this.bootId,
          sessionId: request.agent.id,
          toolName: request.toolName,
          callId: request.callId ?? null,
          reason: request.reason ?? null,
        }),
      )
      .digest('hex');
    return new Promise((resolve) => {
      const settle = (outcome: ApprovalOutcome) => {
        const entry = this.pending.get(approvalId);
        if (!entry) return;
        this.pending.delete(approvalId);
        entry.removeAbort();
        this.publish({
          id: `approval:${approvalId}:settled`,
          kind: 'approval.settled',
          sessionId: request.agent.id,
          payload: json({ approvalId, sessionId: request.agent.id, outcome }),
        });
        resolve(outcome);
      };
      const abort = () => settle('cancelled');
      const timeout = setTimeout(
        () => settle('unavailable'),
        this.policy.approvalTimeoutMs ?? 600000,
      );
      this.pending.set(approvalId, {
        request,
        presentationHash,
        resolve: settle,
        removeAbort: () => {
          clearTimeout(timeout);
          request.signal?.removeEventListener('abort', abort);
        },
      });
      request.signal?.addEventListener('abort', abort, { once: true });
      this.publishApproval(approvalId, request);
    });
  }
  async execute(action: string, raw: unknown, guard: () => void = () => {}): Promise<Json> {
    if (this.closed) throw new AdapterError('host_unavailable', 'DSH plugin has stopped');
    const args = record(raw);
    const invalid = validateCommand(action, args);
    if (invalid) throw new AdapterError('invalid_arguments', invalid);
    // Human approval must bypass the turn's command queue to avoid deadlock.
    if (action === 'approval.respond') {
      guard();
      return this.respond(args);
    }
    const mutations = [
      'repository.inspect',
      'session.create',
      'session.prompt',
      'session.cancel',
      'session.resume',
      'session.queue.update',
      'model.select',
      'attachment.upload',
      'settings.update',
    ];
    if (!mutations.includes(action)) return json(await this.dispatch(action, args, guard));
    const key =
      typeof args.sessionId === 'string'
        ? args.sessionId
        : typeof args.cwd === 'string'
          ? `create:${args.cwd}`
          : 'create';
    const op = (this.serial.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        guard();
        return this.dispatch(action, args, guard);
      });
    this.serial.set(key, op);
    try {
      return json(await op);
    } finally {
      if (this.serial.get(key) === op) this.serial.delete(key);
    }
  }
  private respond(args: Record<string, unknown>): Json {
    only(args, ['approvalId', 'outcome', 'bootId', 'sessionId', 'presentationHash']);
    text(args, 'bootId');
    text(args, 'sessionId');
    text(args, 'presentationHash');
    const approvalId = text(args, 'approvalId');
    if (args.bootId !== this.bootId)
      throw new AdapterError('approval_stale', 'Approval belongs to an earlier DSH process');
    const pending = this.pending.get(approvalId);
    if (!pending || pending.request.signal?.aborted)
      throw new AdapterError('approval_stale', 'Approval is no longer pending');
    if (
      args.sessionId !== pending.request.agent.id ||
      args.presentationHash !== pending.presentationHash
    )
      throw new AdapterError('approval_mismatch', 'Approval is for another session');
    if (args.outcome !== 'allowed-once' && args.outcome !== 'rejected')
      throw new AdapterError('invalid_arguments', 'Only allowed-once and rejected are accepted');
    pending.resolve(args.outcome);
    return { accepted: true };
  }
  private async agent(id: string): Promise<Agent> {
    const result = await this.ctx.sessionController.resolveAgent(id);
    if (result.error) throw result.error;
    return result.agent!;
  }
  private async dispatch(
    action: string,
    args: Record<string, unknown>,
    guard: () => void,
  ): Promise<unknown> {
    const signal = new AbortController().signal;
    const controller = this.ctx.sessionController;
    if (typeof args.sessionId === 'string' && action !== 'session.create')
      await this.checkSession(args.sessionId);
    if (action === 'session.page') {
      const address = record(args.address);
      await this.checkSession(
        text(address, address.kind === 'subagent' ? 'childSessionId' : 'sessionId'),
      );
      if (address.kind === 'subagent') await this.checkSession(text(address, 'parentSessionId'));
    }
    guard();
    switch (action) {
      case 'repository.inspect': {
        const result = await inspectRepository(
          text(args, 'path'),
          text(args, 'expectedRemoteUrl'),
          this.policy.allowedWorkspaceRoots,
        );
        guard();
        return result;
      }
      case 'capabilities':
        return {
          upstreamVersion: '0.2.1-alpha.1',
          upstreamCommit: '5badb15009ae1756c3afe0ae0cef1faafc290ccc',
          hostRuntime: 'node',
          connectorRuntime: 'bun',
          capabilities: CAPABILITIES,
          steering: 'next-step-boundary',
          coldReadActivates: false,
          modelSelectAlsoUpdatesDefault: true,
        };
      case 'session.list': {
        only(args, []);
        const value = (await controller.list({}, signal)) as { items: Array<{ cwd?: string }> };
        return { items: value.items.filter((item) => this.permitted(item.cwd)) };
      }
      case 'session.read': {
        only(args, ['sessionId']);
        const id = text(args, 'sessionId');
        const inspection = await controller.inspect(id, signal);
        const cursor = inspection.events.at(-1)?.seq ?? -1;
        const page = (await controller.page(
          { address: { kind: 'session', sessionId: id }, throughSeq: cursor, maxMessages: 100 },
          signal,
        )) as { records: Array<{ event: SessionEvent }>; hasMore: boolean };
        return {
          header: inspection.meta,
          events: page.records.map((record) => record.event),
          cursor,
          hasMore: page.hasMore,
          pendingApprovals: [...this.pending.entries()]
            .filter(([, entry]) => entry.request.agent.id === id)
            .map(([approvalId, entry]) => this.approvalView(approvalId, entry.request)),
          projections: await controller.projections({ sessionId: id }, signal),
          agentAvailable: !!this.ctx.agents.get(id),
          running: this.ctx.agents.get(id)?.status === 'running',
        };
      }
      case 'session.page':
        only(args, ['address', 'throughSeq', 'beforeSeq', 'maxMessages', 'turnWindow']);
        return controller.page(args, signal);
      case 'session.projections':
        only(args, ['sessionId']);
        return controller.projections({ sessionId: text(args, 'sessionId') }, signal);
      case 'session.create': {
        only(args, ['sessionId', 'cwd', 'workspaceId', 'agentPreset']);
        if (args.workspaceId !== undefined)
          throw new AdapterError(
            'unsupported',
            'Use an explicitly allowed cwd for remote session creation',
          );
        const cwd = args.cwd ?? this.policy.allowedWorkspaceRoots[0];
        if (!this.permitted(cwd))
          throw new AdapterError(
            'workspace_forbidden',
            'Requested workspace is outside configured roots',
          );
        if (
          args.agentPreset !== undefined &&
          !(this.policy.allowedAgentPresets ?? []).includes(String(args.agentPreset))
        )
          throw new AdapterError('preset_forbidden', 'Agent preset is not remotely selectable');
        guard();
        return controller.create({ ...args, cwd: realpathSync(cwd as string) });
      }
      case 'session.resume': {
        only(args, ['sessionId']);
        guard();
        const agent = await this.agent(text(args, 'sessionId'));
        return { sessionId: agent.id, agentAvailable: true, running: agent.status === 'running' };
      }
      case 'session.prompt': {
        only(args, [
          'sessionId',
          'requestId',
          'mode',
          'content',
          'clientTimeZone',
          'repositoryContext',
        ]);
        text(args, 'sessionId');
        text(args, 'requestId');
        if (args.mode !== 'queue' && args.mode !== 'steer')
          throw new AdapterError('invalid_arguments', 'mode must be queue or steer');
        if (!Array.isArray(args.content))
          throw new AdapterError('invalid_arguments', 'content must be an array');
        const { repositoryContext, ...request } = args;
        if (repositoryContext !== undefined) {
          const context = await repositoryPromptContext(
            repositoryContext as RepositoryContext[],
            this.policy.allowedWorkspaceRoots,
          );
          const content = (args.content as Array<Record<string, unknown>>).map((part) => ({
            ...part,
          }));
          let lastText = -1;
          for (let i = content.length - 1; i >= 0; i--) {
            if (content[i]!.type === 'text') {
              lastText = i;
              break;
            }
          }
          if (lastText >= 0)
            content[lastText] = {
              ...content[lastText],
              text: String(content[lastText]!.text) + context,
            };
          else content.push({ type: 'text', text: context });
          request.content = content;
        }
        guard();
        return controller.prompt(request, signal);
      }
      case 'session.cancel':
        only(args, ['sessionId']);
        return controller.cancel({ sessionId: text(args, 'sessionId') });
      case 'session.queue.update':
        only(args, ['sessionId', 'itemId', 'action']);
        text(args, 'sessionId');
        text(args, 'itemId');
        return controller.updateQueue(args);
      case 'model.select':
        only(args, ['sessionId', 'provider', 'model', 'reasoningEffort']);
        text(args, 'sessionId');
        text(args, 'provider');
        text(args, 'model');
        return controller.selectModel(args);
      case 'attachment.read':
        only(args, ['sessionId', 'attachmentId']);
        return controller.attachment({
          sessionId: text(args, 'sessionId'),
          attachmentId: text(args, 'attachmentId'),
        });
      case 'attachment.upload': {
        only(args, ['sessionId', 'data', 'name']);
        const id = text(args, 'sessionId');
        if (typeof args.data !== 'string' || args.data.length > 6 * 1024 * 1024)
          throw new AdapterError(
            'invalid_arguments',
            'base64 upload is required and limited to 6 MiB encoded',
          );
        if (args.name !== undefined && typeof args.name !== 'string')
          throw new AdapterError('invalid_arguments', 'name must be a string');
        guard();
        const agent = await this.agent(id);
        guard();
        return this.ctx.fileUploads.upload(
          agent,
          { data: args.data, ...(args.name === undefined ? {} : { name: args.name as string }) },
          signal,
        );
      }
      case 'settings.describe': {
        only(args, ['sessionId']);
        if (args.sessionId === undefined)
          return {
            modelCatalog: await controller.modelCatalog(),
            allowedPermissionPresets: this.policy.allowedPermissionPresets ?? [
              'workspace-write',
              'read-only',
            ],
            allowedAgentPresets: this.policy.allowedAgentPresets ?? [],
          };
        const id = text(args, 'sessionId');
        const permission = this.ctx.get('permissionPresets') as DshHostContext['permissionPresets'];
        const presets = this.ctx.get('agentPresets') as DshHostContext['agentPresets'];
        return {
          sessionId: id,
          projections: await controller.projections({ sessionId: id }, signal),
          modelCatalog: await controller.modelCatalog(),
          permissionCatalog: permission?.catalog() ?? null,
          presetCatalog: presets ? await presets.list() : null,
          allowedPermissionPresets: this.policy.allowedPermissionPresets ?? [
            'workspace-write',
            'read-only',
          ],
          allowedAgentPresets: this.policy.allowedAgentPresets ?? [],
        };
      }
      case 'settings.update': {
        only(args, ['sessionId', 'permissionPreset', 'agentPreset', 'expectedRevision']);
        const id = text(args, 'sessionId');
        const revision = (await controller.projections({ sessionId: id }, signal)) as {
          asOfSeq: number;
        } | null;
        if (
          !Number.isSafeInteger(args.expectedRevision) ||
          args.expectedRevision !== revision?.asOfSeq
        )
          throw new AdapterError(
            'settings_conflict',
            'Session changed; refresh settings before submitting',
          );
        guard();
        const agent = await this.agent(id);
        guard();
        if (args.permissionPreset === undefined && args.agentPreset === undefined)
          throw new AdapterError('invalid_arguments', 'Select permissionPreset or agentPreset');
        if (args.permissionPreset !== undefined && args.agentPreset !== undefined)
          throw new AdapterError(
            'invalid_arguments',
            'Submit one setting per command to avoid partial updates',
          );
        if (args.permissionPreset !== undefined) {
          const preset = text(args, 'permissionPreset');
          if (
            !(this.policy.allowedPermissionPresets ?? ['workspace-write', 'read-only']).includes(
              preset,
            )
          )
            throw new AdapterError(
              'preset_forbidden',
              'Permission preset is not remotely selectable',
            );
          if (!/^[a-z][a-z0-9-]*$/.test(preset))
            throw new AdapterError('invalid_arguments', 'Invalid permission preset');
          const commands = this.ctx.get('commands') as DshHostContext['commands'];
          if (!commands) throw new AdapterError('unsupported', 'Commands service is not mounted');
          guard();
          const executed = (await commands.execute(agent, `/permission ${preset}`, [], signal)) as
            { result?: { kind: string; text?: string } } | undefined;
          if (!executed || executed.result?.kind !== 'success')
            throw new AdapterError(
              'settings_rejected',
              executed?.result?.text ?? 'Permission command unavailable',
            );
          return executed;
        }
        const presets = this.ctx.get('agentPresets') as DshHostContext['agentPresets'];
        if (!presets) throw new AdapterError('unsupported', 'Agent presets are not mounted');
        const preset = text(args, 'agentPreset');
        if (!(this.policy.allowedAgentPresets ?? []).includes(preset))
          throw new AdapterError('preset_forbidden', 'Agent preset is not remotely selectable');
        guard();
        return { agentPreset: await presets.select(agent, preset) };
      }
      default:
        throw new AdapterError('unsupported', `Unsupported action ${action}`);
    }
  }
  dispose(): void {
    if (this.closed) return;
    for (const dispose of this.disposers) dispose();
    for (const pending of [...this.pending.values()]) pending.resolve('unavailable');
    this.closed = true;
    this.available = false;
  }
}
