import Foundation
import IOKit

// Per-process GPU time from the GPU driver's IORegistry entries, the source Activity Monitor's GPU
// column uses. Each accelerator user client carries "IOUserClientCreator" ("pid N, Name") and an
// "AppUsage" array whose entries hold "accumulatedGPUTime" in nanoseconds. These keys are not
// public API: when no client exposes "AppUsage" the probe reports the GPU as unavailable.
// Blocking IORegistry reads; call only from a background queue.

struct GpuUsageSnapshot {
    let timeNsByPid: [Int32: UInt64]
    let available: Bool
    let deviceUtilization: Int?
}

private func registryProperty(_ entry: io_registry_entry_t, _ key: String) -> Any? {
    return IORegistryEntryCreateCFProperty(entry, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
}

func probeGpuUsage() -> GpuUsageSnapshot {
    var timeNsByPid: [Int32: UInt64] = [:]
    var available = false
    var deviceUtilization: Int?
    var accelerators: io_iterator_t = 0
    // IOServiceGetMatchingServices consumes the matching dictionary.
    guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOAccelerator"), &accelerators)
        == KERN_SUCCESS else {
        return GpuUsageSnapshot(timeNsByPid: [:], available: false, deviceUtilization: nil)
    }
    defer { IOObjectRelease(accelerators) }

    var accelerator = IOIteratorNext(accelerators)
    while accelerator != 0 {
        if let stats = registryProperty(accelerator, "PerformanceStatistics") as? [String: Any],
           let utilization = (stats["Device Utilization %"] as? NSNumber)?.intValue {
            deviceUtilization = max(deviceUtilization ?? 0, utilization)
        }
        var clients: io_iterator_t = 0
        if IORegistryEntryCreateIterator(accelerator, kIOServicePlane, IOOptionBits(kIORegistryIterateRecursively), &clients)
            == KERN_SUCCESS {
            var client = IOIteratorNext(clients)
            while client != 0 {
                if let usage = registryProperty(client, "AppUsage") as? [[String: Any]] {
                    available = true
                    if let creator = registryProperty(client, "IOUserClientCreator") as? String,
                       let pid = acceleratorClientPid(creator: creator) {
                        let total = usage.reduce(UInt64(0)) {
                            $0 &+ ((($1["accumulatedGPUTime"] as? NSNumber)?.uint64Value) ?? 0)
                        }
                        timeNsByPid[pid, default: 0] &+= total
                    }
                }
                IOObjectRelease(client)
                client = IOIteratorNext(clients)
            }
            IOObjectRelease(clients)
        }
        IOObjectRelease(accelerator)
        accelerator = IOIteratorNext(accelerators)
    }
    return GpuUsageSnapshot(timeNsByPid: timeNsByPid, available: available, deviceUtilization: deviceUtilization)
}
