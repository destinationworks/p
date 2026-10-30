import Foundation

func acquireSingleInstanceLock(agentDir: String) -> Int32? {
    let lockPath = agentDir + "/indexing-tray.pid"
    let fd = open(lockPath, O_RDWR | O_CREAT, 0o644)
    if fd < 0 { return nil }
    if flock(fd, LOCK_EX | LOCK_NB) != 0 {
        close(fd)
        return nil
    }
    ftruncate(fd, 0)
    let pidStr = "\(ProcessInfo.processInfo.processIdentifier)\n"
    if let data = pidStr.data(using: .utf8) {
        _ = data.withUnsafeBytes { write(fd, $0.baseAddress, data.count) }
    }
    return fd
}
