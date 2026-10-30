import Foundation

// Pure decision logic for the service toggle. Foundation only, no I/O, so it can be
// compiled and exercised by the unit harness without AppKit or launchd.

let indexingServiceLabel = "com.dst.p.code-index"

enum ServiceState: Equatable {
    /// Not probed yet, or launchctl did not answer in time.
    case unknown
    case loaded
    case notLoaded
}

enum ServiceOperation: String {
    case stop
    case start
    case restart
}

struct ServiceMenuPlan: Equatable {
    let toggleTitle: String
    let toggleEnabled: Bool
    /// Operation the toggle item runs; nil when the item is informational only.
    let toggleOperation: ServiceOperation?
    /// Restart, Reindex All and per-repository Prioritize.
    let controlsEnabled: Bool
}

func servicePlistPath(home: String) -> String {
    return home + "/Library/LaunchAgents/" + indexingServiceLabel + ".plist"
}

func launchctlPrintArguments(uid: UInt32) -> [String] {
    return ["print", "gui/\(uid)/" + indexingServiceLabel]
}

func launchctlArguments(for operation: ServiceOperation, uid: UInt32, plistPath: String) -> [String] {
    switch operation {
    case .stop:
        // bootout (not kill) so KeepAlive does not respawn the daemon.
        return ["bootout", "gui/\(uid)/" + indexingServiceLabel]
    case .start:
        return ["bootstrap", "gui/\(uid)", plistPath]
    case .restart:
        return ["kickstart", "-k", "gui/\(uid)/" + indexingServiceLabel]
    }
}

/// `launchctl print` exits 0 for a loaded job and non-zero (113) for an unknown one.
/// A nil exit code means launchctl could not be run or did not answer in time.
func serviceState(fromProbeExitCode exitCode: Int32?) -> ServiceState {
    guard let exitCode = exitCode else { return .unknown }
    return exitCode == 0 ? .loaded : .notLoaded
}

func planServiceMenu(state: ServiceState, plistInstalled: Bool, pending: ServiceOperation?) -> ServiceMenuPlan {
    if let pending = pending {
        let title: String
        switch pending {
        case .stop: title = "Stopping Indexing Service..."
        case .start: title = "Starting Indexing Service..."
        case .restart: title = "Restarting Indexing Service..."
        }
        return ServiceMenuPlan(toggleTitle: title, toggleEnabled: false, toggleOperation: nil, controlsEnabled: false)
    }
    switch state {
    case .loaded:
        return ServiceMenuPlan(
            toggleTitle: "Stop Indexing Service", toggleEnabled: true, toggleOperation: .stop, controlsEnabled: true)
    case .notLoaded where plistInstalled:
        return ServiceMenuPlan(
            toggleTitle: "Start Indexing Service", toggleEnabled: true, toggleOperation: .start, controlsEnabled: false)
    case .notLoaded:
        return ServiceMenuPlan(
            toggleTitle: "Start Indexing Service (not installed)", toggleEnabled: false, toggleOperation: nil,
            controlsEnabled: false)
    case .unknown:
        return ServiceMenuPlan(
            toggleTitle: "Checking Indexing Service...", toggleEnabled: false, toggleOperation: nil,
            controlsEnabled: false)
    }
}

func serviceFailureMessage(operation: ServiceOperation, exitCode: Int32?, stderr: String, timedOut: Bool) -> String {
    let verb: String
    switch operation {
    case .stop: verb = "stop"
    case .start: verb = "start"
    case .restart: verb = "restart"
    }
    let trimmed = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
    if timedOut { return "Could not \(verb) the indexing service: launchctl did not finish in time." }
    if exitCode == nil { return "Could not \(verb) the indexing service: launchctl could not be run." }
    let detail = trimmed.isEmpty ? "launchctl exited with status \(exitCode!)." : trimmed
    return "Could not \(verb) the indexing service: \(detail)"
}
