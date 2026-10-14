# Workspace cleanup implementation plan

**Goal:** Reduce confirmed duplicate runtime files and give all supported launchers one workspace selection and service discovery flow.

**Architecture:** Register existing directories without moving database paths or immutable assets. Explicit workspace arguments and `SFS_WORKSPACE` override the persisted selection. Each active workspace owns one authenticated loopback HTTP listener; WebSocket and maker MCP share it, and desktop review retains its separate private IPC boundary.

**Constraints:** Preserve raw assets, candidates, approvals and historical projects. Preserve pre-existing uncommitted changes. No new dependencies. Check resolved paths and preserve unique CI evidence before retiring the merged worktree. Keep the released portable archive.

- [x] Add an ignored workspace registry and CLI list/current/add/use commands, with isolated precedence and corruption tests.
- [x] Route source/server/desktop defaults through the same resolver; start through the lock/session bootstrap with dynamic ports.
- [x] Add redacted service status, idle-only stop, and dead-owner-only descriptor cleanup commands. Remove production scripts that retain obsolete connection credentials.
- [x] Remove only verified unused interface/auth aliases, retaining GUI, pipeline, collaboration and review authority boundaries.
- [x] Preserve unique retired CI logs, remove that registered worktree and verified redundant generated binaries; record exact recovered space.
- [x] Register current and historical workspaces, update bilingual operation/API/architecture documentation and ignore generated private artifacts.
- [x] Run targeted lifecycle/security/CLI tests, typecheck and version checks, then report actual cleanup and any retained historical state.
