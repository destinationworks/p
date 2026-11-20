# 2026-11-18 — Both trays wait for an "indexing" repository state the daemon never writes

- **Status:** Open
- **Task/context:** Found while investigating the macOS tray's menu latency. Not fixed in that change.
- **Unexpected observation or failure:** The macOS tray (`status_headline.swift`, `menu_builder.swift`) and the Linux tray (`indexing_tray_status.py`) treat a repository as indexing only when `state == "indexing"`. The daemon writes `RagState` values (`initializing`, `updating`, `ready`, `stale`, `partial`, ...) plus `queued` and `error`. It writes `updating` or `initializing` while progress is reported. As a result the trays never show the indexing dot, the progress tooltip, or "Status: Indexing ...", and they label an updating repository "Ready (N files)".
- **Evidence:** `packages/code-index/src/rag/types.ts` (`RagState`), `packages/coding-agent/src/core/indexing-service.ts` (`RepositoryServiceStatus.state: RagState | "queued" | "error"`), and `runtime-operations.ts`, which sets `runtime.state` to `updating` or `initializing` on progress. A live `indexing-service-status.json` showed `updating`, `queued`, `ready` and `error`, but never `indexing`.
- **Approaches tried:** None yet.
- **Root cause:** The tray contract was written against a state name that the daemon's status type does not contain. Fixtures used `"indexing"`, so the tests agreed with the trays rather than with the daemon.
- **Resolution:** Pending. Map `initializing` and `updating` (and possibly `progress.phase`) to the indexing presentation in both trays, and build fixtures from the daemon's real state values.
- **Verification:** None yet.
- **Prevention/follow-up:** Derive tray test fixtures from `RepositoryServiceStatus` state values instead of hand-written strings.
- **Reusable learning:** Status consumers must be tested against the producer's actual enum, not against fixture strings that the consumer itself invented.
- **References:** `packages/coding-agent/src/tray/macos/status_headline.swift`, `packages/code-index/indexing_tray_status.py`, `packages/code-index/src/rag/types.ts`.
