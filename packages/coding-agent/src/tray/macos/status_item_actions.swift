import Cocoa
import Foundation

// MARK: - Action Handlers

extension IndexingStatusItemManager {
    @objc func revealInFinder(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        NSWorkspace.shared.selectFile(path, inFileViewerRootedAtPath: "")
    }

    @objc func openInTerminal(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        let script = "tell application \"Terminal\" to do script \"cd " + path.replacingOccurrences(of: "\"", with: "\\\"") + "\""
        if let appleScript = NSAppleScript(source: script) {
            var error: NSDictionary?
            appleScript.executeAndReturnError(&error)
        }
    }

    @objc func prioritizeRepo(_ sender: NSMenuItem) {
        guard let targetPath = sender.representedObject as? String else { return }
        let registryFile = agentDir + "/indexed-repos.json"
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: registryFile)),
              var json = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any],
              var repos = json["repos"] as? [[String: Any]] else { return }

        let now = ISO8601DateFormatter().string(from: Date())
        let reqId = UUID().uuidString
        for idx in 0..<repos.count {
            if (repos[idx]["path"] as? String) == targetPath {
                repos[idx]["priorityRequest"] = ["id": reqId, "requestedAt": now]
                break
            }
        }
        json["repos"] = repos
        if let updatedData = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted]) {
            let tempUrl = URL(fileURLWithPath: "\(registryFile).\(ProcessInfo.processInfo.processIdentifier).tmp")
            try? updatedData.write(to: tempUrl)
            try? FileManager.default.removeItem(at: URL(fileURLWithPath: registryFile))
            try? FileManager.default.moveItem(at: tempUrl, to: URL(fileURLWithPath: registryFile))
        }
    }

    @objc func reindexAll() {
        guard let repos = files?.status?.repos else { return }
        for repo in repos {
            let item = NSMenuItem()
            item.representedObject = repo.path
            prioritizeRepo(item)
        }
    }

    @objc func openLogs() {
        let logPath = agentDir + "/indexing-service/logs/service.log"
        NSWorkspace.shared.open(URL(fileURLWithPath: logPath))
    }

    @objc func openConfig() {
        let configPath = agentDir + "/code-rag.json"
        NSWorkspace.shared.open(URL(fileURLWithPath: configPath))
    }

    /// Stop / Start / Restart. The operation is carried by the clicked item, so a state change
    /// between menu open and click can never turn "Stop" into "Start".
    @objc func performServiceOperation(_ sender: NSMenuItem) {
        guard pending == nil,
              let raw = sender.representedObject as? String,
              let operation = ServiceOperation(rawValue: raw) else { return }
        pending = operation
        applyCacheToButton()
        let uid = self.uid
        let plist = self.plistPath
        actionQueue.async { [weak self] in
            let result = ServiceControl.perform(operation, uid: uid, plistPath: plist)
            let snapshot = ServiceControl.loadSnapshot(uid: uid, plistPath: plist)
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.pending = nil
                self.service = snapshot
                self.applyCacheToButton()
                self.requestFileRefresh()
                if !result.ok { self.presentFailure(result.message) }
            }
        }
    }

    private func presentFailure(_ message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "P Code Indexing"
        alert.informativeText = message
        alert.runModal()
    }

    @objc func disableTrayIcon() {
        let configPath = agentDir + "/code-rag.json"
        if let configData = try? Data(contentsOf: URL(fileURLWithPath: configPath)),
           var json = (try? JSONSerialization.jsonObject(with: configData, options: [])) as? [String: Any] {
            json["enableTray"] = false
            if let updatedData = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted]) {
                try? updatedData.write(to: URL(fileURLWithPath: configPath))
            }
        }
        NSApplication.shared.terminate(nil)
    }

    @objc func quitApp() {
        NSApplication.shared.terminate(nil)
    }
}
