import Cocoa
import Foundation

// MARK: - Main Application Entry

let agentDir = ProcessInfo.processInfo.environment["P_CODING_AGENT_DIR"]
    ?? (FileManager.default.homeDirectoryForCurrentUser.path + "/.p/agent")
guard let _ = acquireSingleInstanceLock(agentDir: agentDir) else {
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = IndexingStatusItemManager(agentDir: agentDir)
app.run()
