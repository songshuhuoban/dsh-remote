# Source-verified DSH integration

Inspected official repository: https://github.com/deepseek-ai/deepseek-harness at `5badb15009ae1756c3afe0ae0cef1faafc290ccc`, version `0.2.1-alpha.1`. Official architecture and seven-part Cordis tutorial were read before implementation. Public APIs are pre-stable; keep the adapter version pinned and rerun integration on upgrades.

| Capability | Actual upstream symbols | Adapter behavior / restrictions |
| --- | --- | --- |
| List sessions | `packages/api/session-controller/src/index.ts: SessionController.list`; `list.ts: ApiSessionList.list`; `sessionQuery.listSessions` | Independent of active UI; combines live and persisted. Upstream excludes cold no-cwd records; connector filters canonical allowed workspace roots |
| Detail/history | `SessionController.inspect`, `page`, `projections` | Non-activating inspection and bounded canonical page. No imaginary getSession API |
| Create/resume | `SessionController.create`, `resolveAgent`; `core/agent: AgentRegistry.create/resume` | Caller-supplied IDs make creation retry-safe; persisted writer-lock contention returns error. Remote create uses allowed cwd; workspaceId not exposed in v1 |
| Background sessions | `ctx.agents` registry and per-Agent driver | Multiple independent Agents; client switching does not cancel other work. Subagent ownership restrictions are retained |
| Ordinary message | `SessionController.prompt` → `agent.followup` | mode `queue`; durable pending inbox then a separate turn. requestId dedup checks pending and committed messages |
| Steering | `prompt(mode:'steer')` → `agent.steer` → `send(next-step,true)` | Nearest later step boundary; never described as interrupting current generation. After active cancellation it becomes next-turn work |
| Pending queue | `SessionController.updateQueue`; `core/agent-loop/src/inbox.ts` | Edit text only, remove, move next-turn item to steering while running. Durable `agent/inbox/spliced` |
| Cancel | `SessionController.cancel` | Calls `agent.cancel({kind:'user'},{keepInbox:true})`; live ordinary Agent required |
| Model configuration | `SessionController.selectModel`; `agent.ts: selectForNextRequest`; `core/agent/src/model-selection.ts` | Durable `model/selection`, applied at next assembly. Also saves default model in background |
| Permission configuration | `interaction/permission-presets`; `/permission` via `ctx.commands.execute` | Positive allowlist, expected revision; refuses command error. No raw sandbox/profile API exposed |
| Agent preset | `ctx.agentPresets.select` | Allowed configured IDs only; upstream rejects after first turn |
| Events/reconnect | `session/event`, `agent/status`, `agent/assistant-stream`; SessionController history | Plugin forwards global permitted events. Relay cursors are distinct from per-session seq. Tokens are transient; settled assistant streams durable |
| Native follow | `history.ts: SessionHistoryController.follow` | Not used for passive viewers: ordinary cold prepared sessions are promoted after opening snapshot. Native follow takes no afterSeq argument |
| Approvals | `interaction/user-approval/src/index.ts: ApprovalService.request`; `approval/request` waterfall | Return allowed-once/rejected/cancelled/unavailable through original promise. Audit ID is not a response API; connector mints boot-bound live authority. Abort discards late answer |
| Attachments | `ctx.fileUploads.upload`; `ctx.attachments.admitPromptContent`; `SessionController.attachment` | Same-Agent staged file receipts, image admission, referenced-session image reads. No arbitrary paths or arbitrary URL fetch |

No DSH core patch is required. This is an additive Cordis bundle loaded into Node. Bun owns connector transport and relay; treating the full DSH runtime as Bun-compatible would be an unverified claim.

Source checks uncovered details that must stay in the product contract: `follow()` can activate a cold Agent; `selectModel()` affects defaults; pending approval events have no durable audit ID; driver idle is not completion of one specific message; per-session requests need their own idempotency reservation; multiple sessions can run concurrently while mutation order is per session.

Upstream real-API E2E requires an authorized provider key. Upstream supports keyless real-composition tests through `dsh-llm-mock-server` and `dsh-llm-replay`; neither proves live-provider compatibility. Our checked-in runtime evidence explicitly names the substituted boundary and source-only omissions.
