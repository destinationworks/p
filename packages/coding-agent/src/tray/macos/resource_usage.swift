import Foundation

// Pure resource-usage math and labels for the indexer's process tree. Foundation only, no I/O,
// so the unit harness can compile and exercise it; resource_sampler.swift produces the samples.

/// One process of the indexer tree at one instant. Times are cumulative nanoseconds.
struct ProcessSample {
    let pid: Int32
    /// Start time in microseconds since the Unix epoch. Together with `pid` it identifies the
    /// process across samples, so a reused pid is never diffed against its predecessor's counters.
    let startTimeUs: UInt64
    let name: String
    let arguments: [String]
    let cpuTimeNs: UInt64
    let footprintBytes: UInt64
    /// Summed GPU time of the accelerator clients this pid opened; nil when unknown. The driver
    /// names clients by pid only, so this counter cannot be tied to a start time.
    let gpuTimeNs: UInt64?
}

struct ResourceSample {
    /// Monotonic clock (not wall time) so a clock change never skews the rates.
    let takenAtNs: UInt64
    let rootPid: Int32
    let processes: [ProcessSample]
    /// False when the GPU driver exposes no per-process GPU time; no GPU figure is shown then.
    let gpuAvailable: Bool
    /// Whole-device utilization across every app, as the GPU driver reports it.
    let gpuDeviceUtilization: Int?
}

struct ProcessUsage {
    let pid: Int32
    let label: String
    let isRoot: Bool
    let footprintBytes: UInt64
    /// Percent of one CPU core (Activity Monitor convention); nil until two samples exist.
    let cpuPercent: Double?
    let gpuPercent: Double?
    /// The process has used the GPU at some point; only such rows show a GPU figure.
    let usesGpu: Bool
}

struct ResourceUsage {
    let processes: [ProcessUsage]
    let totalFootprintBytes: UInt64
    let totalCpuPercent: Double?
    let totalGpuPercent: Double?
    let gpuAvailable: Bool
    let gpuDeviceUtilization: Int?
}

private struct ProcessKey: Hashable {
    let pid: Int32
    let startTimeUs: UInt64
}

/// Rate of a cumulative counter as a percent of the elapsed time. A counter that went backwards
/// (a GPU client closed, a process was replaced) or no elapsed time yields nil, never a negative
/// or infinite rate; the next sample starts from the new baseline.
func counterPercent(previous: UInt64?, current: UInt64?, elapsedNs: UInt64) -> Double? {
    guard let previous = previous, let current = current, elapsedNs > 0, current >= previous else { return nil }
    return Double(current - previous) / Double(elapsedNs) * 100
}

func computeResourceUsage(previous: ResourceSample?, current: ResourceSample) -> ResourceUsage {
    var before: [ProcessKey: ProcessSample] = [:]
    var elapsedNs: UInt64 = 0
    if let previous = previous, current.takenAtNs > previous.takenAtNs {
        elapsedNs = current.takenAtNs - previous.takenAtNs
        for process in previous.processes {
            before[ProcessKey(pid: process.pid, startTimeUs: process.startTimeUs)] = process
        }
    }
    let processes = current.processes.map { process -> ProcessUsage in
        let prior = before[ProcessKey(pid: process.pid, startTimeUs: process.startTimeUs)]
        // Both counters are read a few milliseconds apart from the timestamp, so a fully busy GPU
        // can compute marginally above 100%; one device cannot be busier than that.
        let gpu = current.gpuAvailable
            ? counterPercent(previous: prior?.gpuTimeNs, current: process.gpuTimeNs, elapsedNs: elapsedNs)
            : nil
        return ProcessUsage(
            pid: process.pid,
            label: processLabel(name: process.name, arguments: process.arguments),
            isRoot: process.pid == current.rootPid,
            footprintBytes: process.footprintBytes,
            cpuPercent: counterPercent(previous: prior?.cpuTimeNs, current: process.cpuTimeNs, elapsedNs: elapsedNs),
            gpuPercent: gpu.map { min($0, 100) },
            usesGpu: current.gpuAvailable && (process.gpuTimeNs ?? 0) > 0)
    }
    return ResourceUsage(
        processes: processes.sorted(by: displaysBefore),
        totalFootprintBytes: processes.reduce(0) { $0 + $1.footprintBytes },
        totalCpuPercent: sumOfKnown(processes.map { $0.cpuPercent }),
        totalGpuPercent: sumOfKnown(processes.map { $0.gpuPercent }).map { min($0, 100) },
        gpuAvailable: current.gpuAvailable,
        gpuDeviceUtilization: current.gpuDeviceUtilization)
}

private func sumOfKnown(_ values: [Double?]) -> Double? {
    let known = values.compactMap { $0 }
    return known.isEmpty ? nil : known.reduce(0, +)
}

/// The daemon first, then the heaviest processes.
private func displaysBefore(_ left: ProcessUsage, _ right: ProcessUsage) -> Bool {
    if left.isRoot != right.isRoot { return left.isRoot }
    if left.footprintBytes != right.footprintBytes { return left.footprintBytes > right.footprintBytes }
    return left.pid < right.pid
}

/// Interpreter processes all share a name ("Python", "node"), so the script they run is appended.
func processLabel(name: String, arguments: [String]) -> String {
    let displayName = name.isEmpty ? "process" : name
    guard arguments.count > 1 else { return displayName }
    let script = arguments[1]
    guard [".py", ".js", ".mjs", ".cjs", ".ts"].contains(where: { script.hasSuffix($0) }) else { return displayName }
    return displayName + " · " + URL(fileURLWithPath: script).lastPathComponent
}

/// Accelerator user clients name their owner as "pid 43876, Python".
func acceleratorClientPid(creator: String) -> Int32? {
    guard creator.hasPrefix("pid ") else { return nil }
    let digits = creator.dropFirst(4).prefix { $0.isASCII && $0.isNumber }
    return Int32(digits)
}

/// Guards against a stale status file whose pid now belongs to an unrelated process: the daemon
/// writes `startedAt` after it started, so its process cannot have started noticeably later.
func rootProcessMatchesStatus(processStartTimeUs: UInt64, statusStartedAt: String) -> Bool {
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let startedAt = withFraction.date(from: statusStartedAt) ?? ISO8601DateFormatter().date(from: statusStartedAt)
    else { return true }
    let processStart = Double(processStartTimeUs) / 1_000_000
    return processStart <= startedAt.timeIntervalSince1970 + 2
}

// MARK: - Formatting (POSIX number formatting, so labels do not depend on the user's locale)

func formatPercent(_ value: Double?) -> String {
    guard let value = value else { return "…" }
    // One decimal for small values; 9.95 and up would print as "10.0%", so they switch to integers.
    return value < 9.95 ? String(format: "%.1f%%", value) : String(format: "%.0f%%", value)
}

/// Binary units with the labels Activity Monitor uses.
func formatMemory(_ bytes: UInt64) -> String {
    let value = Double(bytes)
    if value >= 1_073_741_824 { return String(format: "%.1f GB", value / 1_073_741_824) }
    if value >= 1_048_576 { return String(format: "%.0f MB", value / 1_048_576) }
    return String(format: "%.0f KB", value / 1024)
}

private func usageParts(cpu: Double?, footprint: UInt64, gpu: Double?, showGpu: Bool) -> String {
    var parts = ["CPU " + formatPercent(cpu), "Memory " + formatMemory(footprint)]
    if showGpu { parts.append("GPU " + formatPercent(gpu)) }
    return parts.joined(separator: " · ")
}

/// What the menu shows when the status file's pid is gone or belongs to another process.
let unavailableResourceUsage = ResourceUsage(
    processes: [], totalFootprintBytes: 0, totalCpuPercent: nil, totalGpuPercent: nil, gpuAvailable: false,
    gpuDeviceUtilization: nil)

/// The summed figures of the whole tree, shown on the "Resources:" row.
func resourceTotalsTitle(_ usage: ResourceUsage) -> String {
    return "Resources: " + usageParts(
        cpu: usage.totalCpuPercent, footprint: usage.totalFootprintBytes, gpu: usage.totalGpuPercent,
        showGpu: usage.gpuAvailable)
}

/// GPU is listed only for processes that have used it, so the rows stay short and a GPU figure does
/// not appear and vanish as the embedding server idles between batches.
func processUsageTitle(_ process: ProcessUsage) -> String {
    return "\(process.label) (\(process.pid)) — " + usageParts(
        cpu: process.cpuPercent, footprint: process.footprintBytes, gpu: process.gpuPercent, showGpu: process.usesGpu)
}

/// Everything the "Resources:" row shows: its title, one row per process, and the explanatory rows
/// after a separator (none when empty).
struct ResourceMenuContent: Equatable {
    let title: String
    let processRows: [String]
    let footerRows: [String]
}

func resourceMenuContent(usage: ResourceUsage?, serviceRunning: Bool, unifiedMemory: Bool) -> ResourceMenuContent {
    guard serviceRunning else {
        return ResourceMenuContent(
            title: "Resources: unavailable (service stopped)", processRows: ["The indexing service is not running."],
            footerRows: [])
    }
    guard let usage = usage else {
        return ResourceMenuContent(title: "Resources: measuring...", processRows: ["Measuring..."], footerRows: [])
    }
    guard !usage.processes.isEmpty else {
        return ResourceMenuContent(
            title: "Resources: unavailable (daemon process not found)",
            processRows: ["The status file names a process that is not the running daemon."], footerRows: [])
    }
    return ResourceMenuContent(
        title: resourceTotalsTitle(usage),
        processRows: usage.processes.map(processUsageTitle),
        footerRows: resourceFooterLines(usage, unifiedMemory: unifiedMemory))
}

/// Fixed explanatory rows of the per-process submenu, after the process rows. On unified memory
/// (Apple silicon) Metal buffers are part of each process's footprint, so GPU memory is included.
func resourceFooterLines(_ usage: ResourceUsage, unifiedMemory: Bool) -> [String] {
    var lines: [String] = []
    if let device = usage.gpuDeviceUtilization {
        lines.append("Whole GPU (all apps): \(device)%")
    }
    lines.append("100% CPU = one core. Memory = physical footprint, as in Activity Monitor"
        + (unifiedMemory ? "," : "."))
    if unifiedMemory { lines.append("which includes GPU (Metal) buffers in unified memory.") }
    return lines
}
