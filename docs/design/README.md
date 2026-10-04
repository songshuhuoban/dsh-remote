# Design and acceptance

- [Architecture](architecture.md): Node DSH adapter + managed Bun connector, Bun relay, multi-user ownership, per-instance single-writer leases, transport recovery, live approvals and bounded attachment/config surfaces
- [E2E acceptance contract](e2e-acceptance.md): required real-runtime, live-provider, browser and native-mobile gates; none are silently replaced by mocks
- [Security review](security-review.md): reproduced defects, passing bounded rechecks, shared wire validation and remaining deployment gates

The specification describes intended behavior. Test reports describe only what was actually executed. A design requirement or unit-test pass is not proof of real model-provider or native-mobile acceptance.
