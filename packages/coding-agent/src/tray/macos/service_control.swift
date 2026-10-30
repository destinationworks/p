import Foundation

// launchctl access. Every call here can block (process spawn, wait for exit), so callers
// must run it on a background queue, never from menuWillOpen or the main thread.

struct LaunchctlResult {
    /// nil when launchctl could not be spawned or had to be killed after the timeout.
    let exitCode: Int32?
    let stderr: String
    let timedOut: Bool
}

struct ServiceActionResult {
    let ok: Bool
    let message: String
}

struct ServiceSnapshot {
    let state: ServiceState
    let plistInstalled: Bool
    let probedAt: Date
}

enum ServiceControl {
    static let launchctlPath = "/bin/launchctl"
    static let probeTimeout: TimeInterval = 2
    static let stopTimeout: TimeInterval = 30
    static let startTimeout: TimeInterval = 10
    static let removalPollTimeout: TimeInterval = 10

    static func run(_ arguments: [String], timeout: TimeInterval) -> LaunchctlResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launchctlPath)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        let errorPipe = Pipe()
        process.standardError = errorPipe
        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in exited.signal() }
        do {
            try process.run()
        } catch {
            return LaunchctlResult(exitCode: nil, stderr: "", timedOut: false)
        }
        if exited.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            if exited.wait(timeout: .now() + 0.5) == .timedOut {
                // SIGTERM may be ignored (inherited from stop()); SIGKILL cannot be.
                kill(process.processIdentifier, SIGKILL)
                _ = exited.wait(timeout: .now() + 1)
            }
            return LaunchctlResult(exitCode: nil, stderr: "", timedOut: true)
        }
        let data = errorPipe.fileHandleForReading.readDataToEndOfFile()
        return LaunchctlResult(
            exitCode: process.terminationStatus, stderr: String(decoding: data, as: UTF8.self), timedOut: false)
    }

    static func probe(uid: UInt32) -> ServiceState {
        let result = run(launchctlPrintArguments(uid: uid), timeout: probeTimeout)
        return serviceState(fromProbeExitCode: result.exitCode)
    }

    static func loadSnapshot(uid: UInt32, plistPath: String) -> ServiceSnapshot {
        return ServiceSnapshot(
            state: probe(uid: uid),
            plistInstalled: FileManager.default.fileExists(atPath: plistPath),
            probedAt: Date())
    }

    static func perform(_ operation: ServiceOperation, uid: UInt32, plistPath: String) -> ServiceActionResult {
        let arguments = launchctlArguments(for: operation, uid: uid, plistPath: plistPath)
        let timeout = operation == .stop ? stopTimeout : startTimeout
        let result: LaunchctlResult
        if operation == .stop {
            result = stopKeepingTrayAlive(arguments, timeout: timeout, uid: uid)
        } else {
            result = run(arguments, timeout: timeout)
        }
        if result.exitCode == 0 { return ServiceActionResult(ok: true, message: "") }
        let message = serviceFailureMessage(
            operation: operation, exitCode: result.exitCode, stderr: result.stderr, timedOut: result.timedOut)
        return ServiceActionResult(ok: false, message: message)
    }

    /// The daemon owns this tray process and sends it SIGTERM while shutting down. Ignore
    /// SIGTERM for the duration of the bootout so the tray survives to offer "Start".
    private static func stopKeepingTrayAlive(_ arguments: [String], timeout: TimeInterval, uid: UInt32) -> LaunchctlResult {
        signal(SIGTERM, SIG_IGN)
        defer { signal(SIGTERM, SIG_DFL) }
        let result = run(arguments, timeout: timeout)
        if result.exitCode == 0 { waitForRemoval(uid: uid) }
        return result
    }

    /// bootout can return before launchd has dropped the job; a following bootstrap would race it.
    private static func waitForRemoval(uid: UInt32) {
        let deadline = Date().addingTimeInterval(removalPollTimeout)
        while Date() < deadline {
            if probe(uid: uid) != .loaded { return }
            Thread.sleep(forTimeInterval: 0.2)
        }
    }
}
