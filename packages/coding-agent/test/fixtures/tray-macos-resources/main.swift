import Foundation

// Test-only driver for the real resource sampler (resource_sampler.swift + gpu_usage_probe.swift).
// Usage: tray-resources <root-pid> <status-startedAt> <interval-ms>
// Takes two samples of the process tree under <root-pid> and prints the computed usage as JSON
// (or JSON null when the sampler rejects the root).

let arguments = CommandLine.arguments
guard arguments.count == 4, let rootPid = Int32(arguments[1]), let intervalMs = UInt32(arguments[3]) else {
    FileHandle.standardError.write("usage: tray-resources <root-pid> <startedAt> <interval-ms>\n".data(using: .utf8)!)
    exit(2)
}
let startedAt = arguments[2]

func encode(_ value: Any) -> Data {
    return (try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])) ?? Data("null".utf8)
}

guard let first = sampleIndexerResources(rootPid: rootPid, statusStartedAt: startedAt, previous: nil) else {
    FileHandle.standardOutput.write(encode(NSNull()))
    exit(0)
}
usleep(intervalMs * 1000)
guard let second = sampleIndexerResources(rootPid: rootPid, statusStartedAt: startedAt, previous: first) else {
    FileHandle.standardOutput.write(encode("root vanished between samples"))
    exit(1)
}
let usage = computeResourceUsage(previous: first, current: second)
let cumulativeCpu = Dictionary(uniqueKeysWithValues: second.processes.map { ($0.pid, $0.cpuTimeNs) })
let result: [String: Any] = [
    "gpuAvailable": usage.gpuAvailable,
    "gpuDeviceUtilization": usage.gpuDeviceUtilization ?? NSNull(),
    "totalCpuPercent": usage.totalCpuPercent ?? NSNull(),
    "totalFootprintBytes": usage.totalFootprintBytes,
    "processes": usage.processes.map { process -> [String: Any] in
        [
            "pid": Int(process.pid), "label": process.label, "isRoot": process.isRoot,
            "footprintBytes": process.footprintBytes, "cpuPercent": process.cpuPercent ?? NSNull(),
            "gpuPercent": process.gpuPercent ?? NSNull(), "cpuTimeNs": cumulativeCpu[process.pid] ?? 0,
        ]
    },
]
FileHandle.standardOutput.write(encode(result))
