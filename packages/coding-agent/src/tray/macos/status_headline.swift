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

/// `RepositoryServiceStatus.state` values the daemon writes while it refreshes a repository.
let indexingRepoStates: Set<String> = ["initializing", "updating"]

func isRepoIndexing(_ repo: RepoStatusEntry) -> Bool {
    return indexingRepoStates.contains(repo.state)
}

/// Only the indexing phase reports overall progress: "preparing" can reach 100% before any chunk is
/// indexed and "finalizing" restarts at 0%, so those phases are named instead of given a percent.
func indexingProgressLabel(_ progress: RepoProgress?) -> String? {
    guard let phase = progress?.phase else { return nil }
    guard phase == "indexing" else { return phase }
    return progress?.percent.map { "\(Int($0))%" }
}

private func runningHeadline(_ status: IndexingStatusData?) -> String {
    guard let active = status?.repos.first(where: isRepoIndexing) else {
        return "Status: Ready (Idle)"
    }
    let repoName = URL(fileURLWithPath: active.path).lastPathComponent
    return "Status: Indexing \(repoName) (\(indexingProgressLabel(active.progress) ?? "in progress"))"
}

func repoStateDescription(_ repo: RepoStatusEntry, serviceRunning: Bool) -> String {
    if !serviceRunning { return "Stopped (\(repo.indexedFiles) files)" }
    if isRepoIndexing(repo) { return "Indexing" + (indexingProgressLabel(repo.progress).map { " [\($0)]" } ?? "") }
    switch repo.state {
    case "error": return "Error"
    case "queued": return "Queued"
    default: return "Ready (\(repo.indexedFiles) files)"
    }
}

/// What the menu-bar button shows.
struct TrayButtonAppearance {
    let isIndexing: Bool
    let isError: Bool
    let toolTip: String
}

func trayButtonAppearance(service: ServiceState, processRunning: Bool, status: IndexingStatusData?) -> TrayButtonAppearance {
    let serviceRunning = service != .notLoaded && processRunning
    let indexingRepo = serviceRunning ? status?.repos.first(where: isRepoIndexing) : nil
    let anyError = serviceRunning && (status?.repos.contains { $0.state == "error" } ?? false)
    let toolTip: String
    if let repo = indexingRepo {
        let label = indexingProgressLabel(repo.progress).map { " (\($0))" } ?? ""
        toolTip = "Indexing: \(URL(fileURLWithPath: repo.path).lastPathComponent)\(label)"
    } else if service == .notLoaded {
        toolTip = "P Code Indexing (Stopped)"
    } else {
        toolTip = serviceRunning ? "P Code Indexing (Idle)" : "P Code Indexing (Starting)"
    }
    return TrayButtonAppearance(
        isIndexing: indexingRepo != nil, isError: service == .notLoaded || anyError, toolTip: toolTip)
}

/// Assigning an NSStatusItem image or tooltip re-renders the item and ships a new snapshot to the
/// menu bar host even when nothing changed, so only what differs from the screen is reassigned.
func trayButtonUpdates(shown: TrayButtonAppearance?, next: TrayButtonAppearance) -> (image: Bool, toolTip: Bool) {
    guard let shown = shown else { return (true, true) }
    return (shown.isIndexing != next.isIndexing || shown.isError != next.isError, shown.toolTip != next.toolTip)
}
