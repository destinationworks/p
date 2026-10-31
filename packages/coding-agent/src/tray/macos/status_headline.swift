import Foundation

// Pure status-line decisions, computed from cached state only.

/// Cached state older than this is shown as-is and labelled "(refreshing...)".
let cacheStaleAfterSeconds: TimeInterval = 10

func isCacheStale(refreshedAt: Date, now: Date, limit: TimeInterval = cacheStaleAfterSeconds) -> Bool {
    return now.timeIntervalSince(refreshedAt) > limit
}

struct StatusHeadlineInput {
    let service: ServiceState
    let processRunning: Bool
    let status: IndexingStatusData?
    let stale: Bool
}

func statusHeadline(_ input: StatusHeadlineInput) -> String {
    let base: String
    switch input.service {
    case .notLoaded:
        base = "Status: Stopped"
    case .loaded where !input.processRunning:
        base = "Status: Starting..."
    case .unknown where !input.processRunning:
        base = "Status: Checking..."
    default:
        base = runningHeadline(input.status)
    }
    return input.stale ? base + " (refreshing...)" : base
}

private func runningHeadline(_ status: IndexingStatusData?) -> String {
    guard let active = status?.repos.first(where: { $0.state == "indexing" }) else {
        return "Status: Ready (Idle)"
    }
    let repoName = URL(fileURLWithPath: active.path).lastPathComponent
    let pct = active.progress?.percent.map { "\(Int($0))%" } ?? "in progress"
    return "Status: Indexing \(repoName) (\(pct))"
}

func repoStateDescription(_ repo: RepoStatusEntry, serviceRunning: Bool) -> String {
    if !serviceRunning { return "Stopped (\(repo.indexedFiles) files)" }
    switch repo.state {
    case "indexing":
        let pct = repo.progress?.percent.map { " [\(Int($0))%]" } ?? ""
        return "Indexing\(pct)"
    case "error": return "Error"
    case "queued": return "Queued"
    default: return "Ready (\(repo.indexedFiles) files)"
    }
}
