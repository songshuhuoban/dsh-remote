# Instance connection status

The owner-scoped `GET /api/instances` and `GET /api/instances/:id/state` responses include:

- `status`: `offline`, `connecting`, `online`, or `stale`
- `online`: true only when the current connection is ready and recently observed
- `lastSeenAt`: relay timestamp of the most recent hello or Host-confirmed heartbeat; null before the first observation
- `connectedAt` and `disconnectedAt`: most recent transport lifecycle observations
- `observedAt`: when the relay produced this response
- `bootId`, `connectionEpoch`, capabilities, and the separately fenced writer lease

All timestamps are Unix milliseconds. A cached response is an observation, not a promise of continued availability. Clients should show its age and distinguish their own relay connection from the DSH instance connection.

## Liveness and command admission

The Bun connector asks the Node DSH plugin to acknowledge a private stdio heartbeat every ten seconds. It forwards a heartbeat to the relay only after the Host replies with the current connection generation and matching nonce. A responsive sidecar cannot, by itself, keep a blocked Host looking live forever.

The default stale deadline is thirty seconds. A stale connection is not online, cannot acquire or renew authority, and cannot receive new read or write commands. At sixty seconds without a heartbeat the relay closes the transport so the connector can reconnect. Existing dispatched commands still follow the indeterminate-result and reconciliation rules; a liveness timeout does not prove that an operation was never executed.

`connecting` means an authenticated WebSocket exists but the connector hello is not complete. An instance with no current socket is `offline`. Reopening a connection increments its generation; old connection frames do not restore current authority. Status changes emit owner-scoped `instance.status` events, alongside the existing online/offline lifecycle events. Normal client polling also refreshes observation timestamps.

Connection status does not mean the model is currently generating, a tool is busy, or an approval is pending. Those session states must be presented separately. An online instance also does not establish live model-provider availability.

## Evidence

`tests/instance-status.test.ts` uses a labelled synthetic connector to exercise connecting, online, heartbeat expiry, stale admission denial, recovery, disconnect timestamps and cross-user denial. The real DSH runtime suite separately exercises the Node plugin/connector path. Neither test is a native-device or live-provider acceptance claim.
