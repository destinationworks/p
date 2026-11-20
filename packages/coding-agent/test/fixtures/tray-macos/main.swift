import Foundation

// Test-only driver for the pure tray logic in src/tray/macos/{service_state,status_headline,resource_usage}.swift.
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

func uint(_ value: Any?) -> UInt64? {
    return (value as? NSNumber)?.uint64Value
}

func decodeSample(_ object: Any?) -> ResourceSample? {
    guard let fields = object as? [String: Any] else { return nil }
    let processes = (fields["processes"] as? [[String: Any]] ?? []).map { process in
        ProcessSample(
            pid: Int32(process["pid"] as? Int ?? 0), startTimeUs: uint(process["startTimeUs"]) ?? 0,
            name: process["name"] as? String ?? "", arguments: process["arguments"] as? [String] ?? [],
            cpuTimeNs: uint(process["cpuTimeNs"]) ?? 0, footprintBytes: uint(process["footprintBytes"]) ?? 0,
            gpuTimeNs: uint(process["gpuTimeNs"]))
    }
    return ResourceSample(
        takenAtNs: uint(fields["takenAtNs"]) ?? 0, rootPid: Int32(fields["rootPid"] as? Int ?? 0),
        processes: processes, gpuAvailable: fields["gpuAvailable"] as? Bool ?? false,
        gpuDeviceUtilization: fields["gpuDeviceUtilization"] as? Int)
}

func encodeUsage(_ usage: ResourceUsage) -> [String: Any] {
    return [
        "processes": usage.processes.map { process -> [String: Any] in
            [
                "pid": Int(process.pid), "label": process.label, "isRoot": process.isRoot,
                "footprintBytes": process.footprintBytes, "cpuPercent": process.cpuPercent ?? NSNull(),
                "gpuPercent": process.gpuPercent ?? NSNull(), "usesGpu": process.usesGpu,
                "title": processUsageTitle(process),
            ]
        },
        "totalFootprintBytes": usage.totalFootprintBytes,
        "totalCpuPercent": usage.totalCpuPercent ?? NSNull(),
        "totalGpuPercent": usage.totalGpuPercent ?? NSNull(),
        "summary": resourceTotalsTitle(usage),
    ]
}

func handleResourceRequest(_ kind: String, _ request: [String: Any]) -> Any? {
    switch kind {
    case "resourceUsage":
        guard let current = decodeSample(request["current"]) else { return "missing current" }
        return encodeUsage(computeResourceUsage(previous: decodeSample(request["previous"]), current: current))
    case "resourceMenuContent":
        let usage = request["unavailable"] as? Bool == true
            ? unavailableResourceUsage
            : decodeSample(request["current"]).map { computeResourceUsage(previous: decodeSample(request["previous"]), current: $0) }
        let content = resourceMenuContent(
            usage: usage, serviceRunning: request["serviceRunning"] as? Bool ?? false,
            unifiedMemory: request["unifiedMemory"] as? Bool ?? false)
        return ["title": content.title, "processRows": content.processRows, "footerRows": content.footerRows]
    case "counterPercent":
        return counterPercent(
            previous: uint(request["previous"]), current: uint(request["current"]),
            elapsedNs: uint(request["elapsedNs"]) ?? 0) ?? NSNull()
    case "formatMemory":
        return formatMemory(uint(request["bytes"]) ?? 0)
    case "formatPercent":
        return formatPercent((request["value"] as? NSNumber)?.doubleValue)
    case "processLabel":
        return processLabel(name: request["name"] as? String ?? "", arguments: request["arguments"] as? [String] ?? [])
    case "clientPid":
        return acceleratorClientPid(creator: request["creator"] as? String ?? "").map { Int($0) } ?? NSNull()
    case "rootMatches":
        return rootProcessMatchesStatus(
            processStartTimeUs: uint(request["processStartTimeUs"]) ?? 0,
            statusStartedAt: request["statusStartedAt"] as? String ?? "")
    default:
        return nil
    }
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
    case "buttonAppearance":
        let appearance = trayButtonAppearance(
            service: serviceStateFromName(request["service"] as? String ?? ""),
            processRunning: request["processRunning"] as? Bool ?? false,
            status: decodeStatus(request["status"]))
        return ["isIndexing": appearance.isIndexing, "isError": appearance.isError, "toolTip": appearance.toolTip]
    case "buttonUpdates":
        let decode = { (input: Any?) -> TrayButtonAppearance? in
            guard let fields = input as? [String: Any] else { return nil }
            return trayButtonAppearance(
                service: serviceStateFromName(fields["service"] as? String ?? ""),
                processRunning: fields["processRunning"] as? Bool ?? false,
                status: decodeStatus(fields["status"]))
        }
        guard let next = decode(request["next"]) else { return "missing next" }
        let updates = trayButtonUpdates(shown: decode(request["shown"]), next: next)
        return ["image": updates.image, "toolTip": updates.toolTip]
    case "repoState":
        guard let repoJson = request["repo"],
              let data = try? JSONSerialization.data(withJSONObject: repoJson),
              let repo = try? JSONDecoder().decode(RepoStatusEntry.self, from: data) else { return "undecodable" }
        return repoStateDescription(repo, serviceRunning: request["serviceRunning"] as? Bool ?? false)
    default:
        return handleResourceRequest(kind, request) ?? "unknown request kind: \(kind)"
    }
}

let input = FileHandle.standardInput.readDataToEndOfFile()
let requests = (try? JSONSerialization.jsonObject(with: input)) as? [[String: Any]] ?? []
let results = requests.map(handle)
let output = try JSONSerialization.data(withJSONObject: results, options: [.fragmentsAllowed])
FileHandle.standardOutput.write(output)
