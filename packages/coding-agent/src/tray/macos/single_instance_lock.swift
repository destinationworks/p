import Darwin
import Foundation

/// Holds `<agentDir>/indexing-tray.pid` for the life of the process. The launchd-managed tray
/// (`replacingUnmanagedHolder`) takes the lock over from a `p-indexing-tray` that is not managed,
/// such as a tray an older daemon spawned as its child: launchd runs at most one instance of the
/// job, so any other holder is a leftover that would keep the throttled tray on screen.
func acquireSingleInstanceLock(agentDir: String, replacingUnmanagedHolder: Bool = false) -> Int32? {
    let lockPath = agentDir + "/indexing-tray.pid"
    let fd = open(lockPath, O_RDWR | O_CREAT, 0o644)
    if fd < 0 { return nil }
    if flock(fd, LOCK_EX | LOCK_NB) != 0 {
        guard replacingUnmanagedHolder, terminateTrayHolder(lockPath: lockPath), waitForLock(fd) else {
            close(fd)
            return nil
        }
    }
    ftruncate(fd, 0)
    let pidStr = "\(ProcessInfo.processInfo.processIdentifier)\n"
    if let data = pidStr.data(using: .utf8) {
        _ = data.withUnsafeBytes { write(fd, $0.baseAddress, data.count) }
    }
    return fd
}

/// Sends SIGTERM to the pid recorded in the lock file, but only if it is another `p-indexing-tray`.
private func terminateTrayHolder(lockPath: String) -> Bool {
    guard let text = try? String(contentsOfFile: lockPath, encoding: .utf8),
          let pid = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)),
          pid > 0, pid != getpid(), executableName(of: pid) == "p-indexing-tray" else { return false }
    return kill(pid, SIGTERM) == 0
}

private func executableName(of pid: pid_t) -> String? {
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
    return URL(fileURLWithPath: String(cString: buffer)).lastPathComponent
}

/// A holder that ignores SIGTERM (it is stopping the service) keeps the lock; give up after 2 s.
private func waitForLock(_ fd: Int32) -> Bool {
    for _ in 0..<40 {
        if flock(fd, LOCK_EX | LOCK_NB) == 0 { return true }
        usleep(50_000)
    }
    return false
}
