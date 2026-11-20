import Cocoa

// Test-only driver for ResourceMenuSection (src/tray/macos/resource_menu_section.swift).
// Reads {"unifiedMemory": Bool, "initial": Step, "updates": [Step]} on stdin, applies the steps and
// prints the submenu after each one. Each NSMenuItem gets a stable id, so the test can tell a
// retitled row from a replaced one. Step: {"serviceRunning": Bool, "pids": [Int]?, "memoryMb": Int?,
// "unavailable": Bool?}; without "pids" the step has no sample yet.

func usage(from step: [String: Any]) -> ResourceUsage? {
    if step["unavailable"] as? Bool == true { return unavailableResourceUsage }
    guard let pids = step["pids"] as? [Int] else { return nil }
    let memory = UInt64(step["memoryMb"] as? Int ?? 1) * 1_048_576
    let processes = pids.map { pid in
        ProcessSample(
            pid: Int32(pid), startTimeUs: 1, name: "node", arguments: [], cpuTimeNs: 0, footprintBytes: memory,
            gpuTimeNs: nil)
    }
    let sample = ResourceSample(
        takenAtNs: 1, rootPid: Int32(pids.first ?? 0), processes: processes, gpuAvailable: false,
        gpuDeviceUtilization: 42)
    return computeResourceUsage(previous: nil, current: sample)
}

var ids: [ObjectIdentifier: Int] = [:]
func stableId(_ item: NSMenuItem) -> Int {
    let key = ObjectIdentifier(item)
    if let id = ids[key] { return id }
    ids[key] = ids.count
    return ids.count - 1
}

func snapshot(_ section: ResourceMenuSection) -> [String: Any] {
    let rows = (section.item.submenu?.items ?? []).map { row -> [String: Any] in
        [
            "id": stableId(row), "title": row.attributedTitle?.string ?? row.title, "separator": row.isSeparatorItem,
            "hidden": row.isHidden, "enabled": row.isEnabled,
        ]
    }
    return ["id": stableId(section.item), "title": section.item.title, "enabled": section.item.isEnabled, "rows": rows]
}

let input = FileHandle.standardInput.readDataToEndOfFile()
let request = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any] ?? [:]
let initial = request["initial"] as? [String: Any] ?? [:]
var output: [String: Any] = ["created": false, "snapshots": []]
if let section = ResourceMenuSection(
    usage: usage(from: initial), serviceRunning: initial["serviceRunning"] as? Bool ?? false,
    unifiedMemory: request["unifiedMemory"] as? Bool ?? false) {
    var snapshots = [snapshot(section)]
    for step in request["updates"] as? [[String: Any]] ?? [] {
        section.update(usage: usage(from: step), serviceRunning: step["serviceRunning"] as? Bool ?? false)
        snapshots.append(snapshot(section))
    }
    output = ["created": true, "snapshots": snapshots]
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output))
