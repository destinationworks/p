import Foundation

// Disk-backed state for the menu. Loading blocks on file I/O, so it only runs on a
// background queue; the menu itself is built from the last published snapshot.

struct FileSnapshot {
    let status: IndexingStatusData?
    let config: CodeRagConfig?
    let processRunning: Bool
    let loadedAt: Date
}

func loadFileSnapshot(agentDir: String, previous: FileSnapshot?) -> FileSnapshot {
    let status = (try? Data(contentsOf: URL(fileURLWithPath: agentDir + "/indexing-service-status.json")))
        .flatMap { try? JSONDecoder().decode(IndexingStatusData.self, from: $0) } ?? previous?.status
    let config = (try? Data(contentsOf: URL(fileURLWithPath: agentDir + "/code-rag.json")))
        .flatMap { try? JSONDecoder().decode(CodeRagConfig.self, from: $0) } ?? previous?.config
    return FileSnapshot(
        status: status, config: config, processRunning: isDaemonProcessRunning(status), loadedAt: Date())
}

private func isDaemonProcessRunning(_ status: IndexingStatusData?) -> Bool {
    guard let pid = status?.pid, status?.running == true else { return false }
    return kill(pid_t(pid), 0) == 0 || errno == EPERM
}
