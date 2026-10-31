# 2026-10-31 — NSMenu auto-enabling silently discards `isEnabled = false`

- **Status:** Resolved
- **Task/context:** Adding Stop/Start to the macOS indexing tray (`packages/coding-agent/src/tray/macos`) and disabling Restart, Reindex All, and per-repository Prioritize while the service is stopped.
- **Unexpected observation or failure:** The existing tray already set `reindexAllItem.isEnabled = running`, but an `NSMenuItem` that has a `target` and an `action` is not guaranteed to stay disabled. With `NSMenu.autoenablesItems` at its default (`true`), AppKit re-evaluates every item when the menu updates and re-enables each one whose target responds to the action.
- **Evidence:** A scratch Swift program (not part of the repo) built an `NSMenu` with one item whose target implements the action, set `isEnabled = false`, and called `menu.update()`. Before `NSApplication.shared` was initialised the item stayed disabled, which looked like proof that the setting works. After `_ = NSApplication.shared`: `autoenablesItems = true` gave `isEnabled == true`; `autoenablesItems = false` gave `isEnabled == false`.
- **Approaches tried:**
  - **Attempt:** Set `isEnabled` on items only.
    - **Outcome:** Did not work
    - **Why:** AppKit overrides it for items with a responding target once the application is running.
  - **Attempt:** Set `autoenablesItems = false` on the displayed menu and on every submenu the builder creates.
    - **Outcome:** Worked
    - **Why:** Items keep exactly the `isEnabled` the builder assigned. Items with no action already set `isEnabled = false` explicitly.
- **Root cause:** `autoenablesItems` is per `NSMenu`, so each submenu needs it too, and the menu the user sees (the status item's menu) is the one that matters even when items are built in a temporary menu and moved.
- **Resolution:** `menu_builder.swift` sets `autoenablesItems = false` on every menu it creates, and `status_item_manager.swift` sets it on the status item's menu.
- **Verification:** The scratch probe above; the tray compiles with swiftc. The menu was not launched in this session, so the visual result is unconfirmed.
- **Prevention/follow-up:** `Reindex All Repositories` was effectively always enabled before this change. A probe in a headless process only reproduces this after `NSApplication.shared` exists; do not conclude the setting is honoured from a probe without it.
- **Reusable learning:** When an AppKit menu needs disabled items that still have actions, turn off `autoenablesItems` on every menu involved, and test it with an initialised `NSApplication`.
- **References:** `packages/coding-agent/src/tray/macos/menu_builder.swift`, `packages/coding-agent/src/tray/macos/status_item_manager.swift`
