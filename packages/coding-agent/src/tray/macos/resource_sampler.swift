import Darwin
import Foundation

// Blocking libproc/sysctl/IORegistry reads of the indexer's process tree (the daemon and every
// process it spawned: Qdrant, the embedding server and their helpers). Call only from a
// background queue. Children that outlive their parent are re-parented to launchd and leave the tree.

#if arch(arm64)
let hostHasUnifiedMemory = true
#else
let hostHasUnifiedMemory = false
#endif

/// Upper bound on the processes walked, so a runaway fork loop cannot stall the sampler.
private let maxSampledProcesses = 256

private let machTimebase: mach_timebase_info_data_t = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return info
}()

/// rusage CPU times are Mach absolute-time ticks, which are not nanoseconds on Apple silicon (125/3).
private func machTicksToNanoseconds(_ ticks: UInt64) -> UInt64 {
    guard machTimebase.denom != 0 else { return ticks }
    let (product, overflow) = ticks.multipliedReportingOverflow(by: UInt64(machTimebase.numer))
    if !overflow { return product / UInt64(machTimebase.denom) }
    return UInt64(Double(ticks) * Double(machTimebase.numer) / Double(machTimebase.denom))
}

/// proc_listchildpids takes the buffer size in bytes but returns a pid count.
private func childPids(of pid: pid_t) -> [pid_t] {
    var capacity = Int(max(proc_listchildpids(pid, nil, 0), 0)) + 8
    while true {
        var buffer = [pid_t](repeating: 0, count: capacity)
        let count = buffer.withUnsafeMutableBufferPointer {
            proc_listchildpids(pid, $0.baseAddress, Int32($0.count * MemoryLayout<pid_t>.stride))
        }
        if count < 0 { return [] }
        if Int(count) < capacity || capacity >= maxSampledProcesses {
            return buffer.prefix(min(Int(count), capacity)).filter { $0 > 0 }
        }
        capacity *= 2
    }
}

private func processTree(root: pid_t) -> [pid_t] {
    var seen: Set<pid_t> = [root]
    var ordered: [pid_t] = [root]
    var index = 0
    while index < ordered.count && ordered.count < maxSampledProcesses {
        for child in childPids(of: ordered[index]) where !seen.contains(child) {
            seen.insert(child)
            ordered.append(child)
        }
        index += 1
    }
    return Array(ordered.prefix(maxSampledProcesses))
}

private func startTimeUs(_ pid: pid_t) -> UInt64? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
    return info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec
}

private func processName(_ pid: pid_t) -> String {
    var buffer = [CChar](repeating: 0, count: 256)
    guard proc_name(pid, &buffer, UInt32(buffer.count)) > 0 else { return "" }
    return String(cString: buffer)
}

/// The first two argv entries from KERN_PROCARGS2: int32 argc, the executable path, NUL padding,
/// then argc NUL-terminated arguments. Only argv[0] and argv[1] are kept (enough for a label).
private func leadingArguments(_ pid: pid_t) -> [String] {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = 0
    guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return [] }
    var buffer = [UInt8](repeating: 0, count: size)
    guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return [] }
    let argc = buffer.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
    var index = MemoryLayout<Int32>.size
    while index < size && buffer[index] != 0 { index += 1 }
    while index < size && buffer[index] == 0 { index += 1 }
    var arguments: [String] = []
    while index < size && arguments.count < min(Int(max(argc, 0)), 2) {
        let start = index
        while index < size && buffer[index] != 0 { index += 1 }
        arguments.append(String(decoding: buffer[start..<index], as: UTF8.self))
        index += 1
    }
    return arguments
}

private func rusage(_ pid: pid_t) -> rusage_info_v4? {
    var info = rusage_info_v4()
    let result = withUnsafeMutablePointer(to: &info) { pointer in
        pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
    }
    return result == 0 ? info : nil
}

/// One sample of the daemon's tree, or nil when `rootPid` is gone or is not the daemon that wrote
/// the status file. Names and arguments are reused from `previous` for processes it already saw.
func sampleIndexerResources(rootPid: Int32, statusStartedAt: String, previous: ResourceSample?) -> ResourceSample? {
    guard let rootStart = startTimeUs(rootPid),
          rootProcessMatchesStatus(processStartTimeUs: rootStart, statusStartedAt: statusStartedAt) else { return nil }
    var known: [Int32: ProcessSample] = [:]
    for process in previous?.processes ?? [] { known[process.pid] = process }

    let gpu = probeGpuUsage()
    let takenAtNs = DispatchTime.now().uptimeNanoseconds
    var processes: [ProcessSample] = []
    for pid in processTree(root: rootPid) {
        guard let start = startTimeUs(pid), let usage = rusage(pid) else { continue }
        let reused = known[pid].flatMap { $0.startTimeUs == start ? $0 : nil }
        processes.append(ProcessSample(
            pid: pid,
            startTimeUs: start,
            name: reused?.name ?? processName(pid),
            arguments: reused?.arguments ?? leadingArguments(pid),
            cpuTimeNs: machTicksToNanoseconds(usage.ri_user_time) &+ machTicksToNanoseconds(usage.ri_system_time),
            footprintBytes: usage.ri_phys_footprint,
            gpuTimeNs: gpu.available ? (gpu.timeNsByPid[pid] ?? 0) : nil))
    }
    return ResourceSample(
        takenAtNs: takenAtNs, rootPid: rootPid, processes: processes, gpuAvailable: gpu.available,
        gpuDeviceUtilization: gpu.deviceUtilization)
}
