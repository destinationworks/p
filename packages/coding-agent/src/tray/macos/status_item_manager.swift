import Cocoa
import Foundation

// MARK: - Status Item Manager

// The menu is built only from the in-memory cache below. Disk reads, launchctl probes and
// JSON decoding happen on the utility queues and are published back to the main thread.
final class IndexingStatusItemManager: NSObject, NSMenuDelegate {
    static let serviceProbeInterval: TimeInterval = 5

    let statusItem: NSStatusItem
    let agentDir: String
    let uid = getuid()
    let plistPath = servicePlistPath(home: NSHomeDirectory())
    let fileQueue = DispatchQueue(label: "p.indexing-tray.files", qos: .utility)
    let serviceQueue = DispatchQueue(label: "p.indexing-tray.service", qos: .utility)
    let actionQueue = DispatchQueue(label: "p.indexing-tray.action", qos: .userInitiated)

    // Main-thread-only cache.
    var files: FileSnapshot?
    var service: ServiceSnapshot?
    var pending: ServiceOperation?
    private var fileRefreshInFlight = false
    private var fileRefreshQueuedAgain = false
    private var serviceRefreshInFlight = false
    private var timer: Timer?
    private var fileSource: DispatchSourceFileSystemObject?

    init(agentDir: String) {
        self.agentDir = agentDir
        self.statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()
        setupStatusButton()
        requestFileRefresh()
        requestServiceRefresh(force: true)
        fileQueue.async { [weak self] in self?.armFileSource() }
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.requestFileRefresh()
            self?.requestServiceRefresh(force: false)
        }
    }

    deinit {
        timer?.invalidate()
        fileSource?.cancel()
    }

    private func setupStatusButton() {
        guard let button = statusItem.button else { return }
        button.image = createTrayIcon(isIndexing: false, isError: false)
        button.imagePosition = .imageLeft
        button.toolTip = "P Code Indexing Service"
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.delegate = self
        statusItem.menu = menu
    }

    // MARK: - Background refresh (all disk I/O and subprocesses live behind these)

    func requestFileRefresh() {
        if fileRefreshInFlight {
            fileRefreshQueuedAgain = true
            return
        }
        fileRefreshInFlight = true
        let previous = files
        let dir = agentDir
        fileQueue.async { [weak self] in
            let snapshot = loadFileSnapshot(agentDir: dir, previous: previous)
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.files = snapshot
                self.fileRefreshInFlight = false
                self.applyCacheToButton()
                if self.fileRefreshQueuedAgain {
                    self.fileRefreshQueuedAgain = false
                    self.requestFileRefresh()
                }
            }
        }
    }

    func requestServiceRefresh(force: Bool) {
        if serviceRefreshInFlight || pending != nil { return }
        if !force, let probedAt = service?.probedAt, Date().timeIntervalSince(probedAt) < Self.serviceProbeInterval {
            return
        }
        serviceRefreshInFlight = true
        let uid = self.uid
        let plist = self.plistPath
        serviceQueue.async { [weak self] in
            let snapshot = ServiceControl.loadSnapshot(uid: uid, plistPath: plist)
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.serviceRefreshInFlight = false
                // An operation that started meanwhile publishes its own, newer snapshot.
                if self.pending == nil { self.service = snapshot }
                self.applyCacheToButton()
            }
        }
    }

    // Runs on fileQueue. A fresh descriptor is captured per source so a re-arm never closes the new one.
    private func armFileSource() {
        fileSource?.cancel()
        let descriptor = open(agentDir + "/indexing-service-status.json", O_EVTONLY)
        if descriptor < 0 { return }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor, eventMask: [.write, .extend, .delete, .rename], queue: fileQueue)
        source.setEventHandler { [weak self, weak source] in
            DispatchQueue.main.async { self?.requestFileRefresh() }
            if let flags = source?.data, flags.contains(.delete) || flags.contains(.rename) {
                self?.fileQueue.asyncAfter(deadline: .now() + 0.1) { self?.armFileSource() }
            }
        }
        source.setCancelHandler { close(descriptor) }
        source.resume()
        fileSource = source
    }

    // MARK: - Derived view state (pure reads of the cache)

    var serviceState: ServiceState { return service?.state ?? .unknown }
    var processRunning: Bool { return files?.processRunning ?? false }
    var serviceRunning: Bool { return serviceState != .notLoaded && processRunning }

    func cacheIsStale(now: Date) -> Bool {
        guard let oldest = [files?.loadedAt, service?.probedAt].compactMap({ $0 }).min() else { return false }
        return isCacheStale(refreshedAt: oldest, now: now)
    }

    func applyCacheToButton() {
        guard let button = statusItem.button else { return }
        let anyIndexing = serviceRunning && (files?.status?.repos.contains { $0.state == "indexing" } ?? false)
        let anyError = serviceRunning && (files?.status?.repos.contains { $0.state == "error" } ?? false)
        button.image = createTrayIcon(isIndexing: anyIndexing, isError: serviceState == .notLoaded || anyError)
        if anyIndexing {
            let repo = files?.status?.repos.first { $0.state == "indexing" }
            let pct = repo?.progress?.percent.map { " (\(Int($0))%)" } ?? ""
            button.toolTip = "Indexing: \(URL(fileURLWithPath: repo?.path ?? "").lastPathComponent)\(pct)"
        } else if serviceState == .notLoaded {
            button.toolTip = "P Code Indexing (Stopped)"
        } else {
            button.toolTip = serviceRunning ? "P Code Indexing (Idle)" : "P Code Indexing (Starting)"
        }
    }

    // MARK: - Menu Delegate

    // Cache reads only: no file, subprocess or blocking call may run here (see the menu-open test).
    func menuWillOpen(_ menu: NSMenu) {
        menu.removeAllItems()
        let now = Date()
        let plan = planServiceMenu(
            state: serviceState, plistInstalled: service?.plistInstalled ?? false, pending: pending)
        let headline = statusHeadline(StatusHeadlineInput(
            service: serviceState, processRunning: processRunning, status: files?.status,
            stale: cacheIsStale(now: now)))
        let builtMenu = buildStatusMenu(
            target: self, running: serviceRunning, headline: headline, plan: plan,
            currentStatus: files?.status, currentConfig: files?.config)
        for item in builtMenu.items {
            builtMenu.removeItem(item)
            menu.addItem(item)
        }
        requestFileRefresh()
        requestServiceRefresh(force: true)
    }
}
