import Cocoa
import Foundation

// MARK: - Main Application Entry

let agentDir = ProcessInfo.processInfo.environment["P_CODING_AGENT_DIR"]
    ?? (FileManager.default.homeDirectoryForCurrentUser.path + "/.p/agent")
let managedByLaunchd = ProcessInfo.processInfo.environment["P_INDEXING_TRAY_MANAGED"] == "1"
guard let _ = acquireSingleInstanceLock(agentDir: agentDir, replacingUnmanagedHolder: managedByLaunchd) else {
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = IndexingStatusItemManager(agentDir: agentDir)
app.run()
