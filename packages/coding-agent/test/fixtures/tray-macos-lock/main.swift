import Foundation

// Test-only driver for src/tray/macos/single_instance_lock.swift.
// usage: <binary> <agentDir> hold | hold-ignoring-sigterm | acquire | acquire-managed

let agentDir = CommandLine.arguments[1]
let mode = CommandLine.arguments[2]

if mode.hasPrefix("hold") {
    if mode == "hold-ignoring-sigterm" { signal(SIGTERM, SIG_IGN) }
    guard acquireSingleInstanceLock(agentDir: agentDir) != nil else {
        print("denied")
        exit(1)
    }
    print("locked")
    fflush(stdout)
    sleep(60)
} else {
    let fd = acquireSingleInstanceLock(agentDir: agentDir, replacingUnmanagedHolder: mode == "acquire-managed")
    print(fd == nil ? "denied" : "acquired")
}
