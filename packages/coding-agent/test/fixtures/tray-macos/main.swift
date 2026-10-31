import Foundation

// Test-only driver for the pure tray decision logic in src/tray/macos/{service_state,status_headline}.swift.
// Reads a JSON array of requests on stdin and writes a JSON array of results on stdout.

func serviceStateFromName(_ name: String) -> ServiceState {
    switch name {
    case "loaded": return .loaded
    case "notLoaded": return .notLoaded
    default: return .unknown
    }
}

func serviceStateName(_ state: ServiceState) -> String {
    switch state {
    case .loaded: return "loaded"
    case .notLoaded: return "notLoaded"
    case .unknown: return "unknown"
    }
}

func decodeStatus(_ object: Any?) -> IndexingStatusData? {
    guard let object = object, !(object is NSNull),
          let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
    return try? JSONDecoder().decode(IndexingStatusData.self, from: data)
}

func handle(_ request: [String: Any]) -> Any {
    let kind = request["kind"] as? String ?? ""
    switch kind {
    case "plan":
        let pending = (request["pending"] as? String).flatMap { ServiceOperation(rawValue: $0) }
        let plan = planServiceMenu(
            state: serviceStateFromName(request["state"] as? String ?? ""),
            plistInstalled: request["plistInstalled"] as? Bool ?? false,
            pending: pending)
        return [
            "toggleTitle": plan.toggleTitle,
            "toggleEnabled": plan.toggleEnabled,
            "toggleOperation": plan.toggleOperation?.rawValue ?? NSNull(),
            "controlsEnabled": plan.controlsEnabled,
        ]
    case "args":
        let operation = ServiceOperation(rawValue: request["operation"] as? String ?? "") ?? .stop
        return launchctlArguments(
            for: operation, uid: UInt32(request["uid"] as? Int ?? 0), plistPath: request["plistPath"] as? String ?? "")
    case "printArgs":
        return launchctlPrintArguments(uid: UInt32(request["uid"] as? Int ?? 0))
    case "plistPath":
        return servicePlistPath(home: request["home"] as? String ?? "")
    case "probe":
        let code = (request["exitCode"] as? Int).map { Int32($0) }
        return serviceStateName(serviceState(fromProbeExitCode: code))
    case "headline":
        return statusHeadline(StatusHeadlineInput(
            service: serviceStateFromName(request["service"] as? String ?? ""),
            processRunning: request["processRunning"] as? Bool ?? false,
            status: decodeStatus(request["status"]),
            stale: request["stale"] as? Bool ?? false))
    case "stale":
        let now = Date(timeIntervalSince1970: 1_000_000)
        let refreshed = now.addingTimeInterval(-(request["ageSeconds"] as? Double ?? 0))
        return isCacheStale(refreshedAt: refreshed, now: now)
    case "failure":
        let operation = ServiceOperation(rawValue: request["operation"] as? String ?? "") ?? .stop
        let code = (request["exitCode"] as? Int).map { Int32($0) }
        return serviceFailureMessage(
            operation: operation, exitCode: code, stderr: request["stderr"] as? String ?? "",
            timedOut: request["timedOut"] as? Bool ?? false)
    case "repoState":
        guard let repoJson = request["repo"],
              let data = try? JSONSerialization.data(withJSONObject: repoJson),
              let repo = try? JSONDecoder().decode(RepoStatusEntry.self, from: data) else { return "undecodable" }
        return repoStateDescription(repo, serviceRunning: request["serviceRunning"] as? Bool ?? false)
    default:
        return "unknown request kind: \(kind)"
    }
}

let input = FileHandle.standardInput.readDataToEndOfFile()
let requests = (try? JSONSerialization.jsonObject(with: input)) as? [[String: Any]] ?? []
let results = requests.map(handle)
let output = try JSONSerialization.data(withJSONObject: results, options: [.fragmentsAllowed])
FileHandle.standardOutput.write(output)
