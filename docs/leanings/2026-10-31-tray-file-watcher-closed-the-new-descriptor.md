# 2026-10-31 — Tray status-file watcher re-arm closed the new descriptor

- **Status:** Partial
- **Task/context:** Moving the macOS tray's status-file watcher off the main thread while making the menu non-blocking.
- **Unexpected observation or failure:** `armFileSource()` stored the descriptor in `self.fileDescriptor`, and the cancel handler closed `self.fileDescriptor` at cancel time. When a `.delete`/`.rename` event re-armed the watcher, `armFileSource()` cancelled the old source and opened a new descriptor synchronously, so the old source's asynchronous cancel handler closed the new descriptor.
- **Evidence:** Source reading of the previous `main.swift`; not reproduced at runtime (the tray was not launched). The 2-second timer masked any missed events.
- **Approaches tried:**
  - **Attempt:** Capture the descriptor in a local constant per source (`setCancelHandler { close(descriptor) }`).
    - **Outcome:** Worked by construction
    - **Why:** Each source closes only the descriptor it opened.
- **Root cause:** A cancel handler that reads shared mutable state instead of the resource it owns.
- **Resolution:** The rewritten watcher in `status_item_manager.swift` captures the descriptor locally; a source-text test pins it.
- **Verification:** `indexing-tray-menu-open-nonblocking.test.ts` asserts the capture. No live reproduction.
- **Prevention/follow-up:** None beyond the pinned test.
- **Reusable learning:** Dispatch-source cancel handlers run later; close the descriptor captured at creation, never a property that may have been reassigned.
- **References:** `packages/coding-agent/src/tray/macos/status_item_manager.swift`
