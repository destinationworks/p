import Cocoa
import Foundation

// MARK: - Status Item Manager

// The menu is built only from the in-memory cache below. Disk reads, launchctl probes and
// JSON decoding happen on the utility queues and are published back to the main thread.
final class IndexingStatusItemManager: NSObject, NSMenuDelegate {
    static let serviceProbeInterval: TimeInterval = 5
    static let resourceSampleInterval: TimeInterval = 1

    let statusItem: NSStatusItem
    let agentDir: String
    let uid = getuid()
    let plistPath = servicePlistPath(home: NSHomeDirectory())
    let fileQueue = DispatchQueue(label: "p.indexing-tray.files", qos: .utility)
    let serviceQueue = DispatchQueue(label: "p.indexing-tray.service", qos: .utility)
    let actionQueue = DispatchQueue(label: "p.indexing-tray.action", qos: .userInitiated)
    // The user is watching the open menu, and a sample takes milliseconds: utility QoS left the
    // first sample waiting for seconds on a heavily loaded host.
    let resourceQueue = DispatchQueue(label: "p.indexing-tray.resources", qos: .userInitiated)

    // Main-thread-only cache.
    var files: FileSnapshot?
    var service: ServiceSnapshot?
    var pending: ServiceOperation?
    private var shownAppearance: TrayButtonAppearance?
    private var fileRefreshInFlight = false
    private var fileRefreshQueuedAgain = false
    private var serviceRefreshInFlight = false
    private var timer: Timer?
    private var fileSource: DispatchSourceFileSystemObject?
    // Resource sampling runs only while the menu is open; the generation drops samples that were
    // still in flight when the menu closed or reopened.
    private var resourceSection: ResourceMenuSection?
    private var resourceTimer: Timer?
    private var lastResourceSample: ResourceSample?
    private var resourceGeneration = 0
    private var resourceRefreshInFlight = false

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
        resourceTimer?.invalidate()
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

    func requestResourceRefresh() {
        let generation = resourceGeneration
        guard serviceRunning, let status = files?.status else {
            lastResourceSample = nil
            resourceSection?.update(usage: nil, serviceRunning: serviceRunning)
            return
        }
        if resourceRefreshInFlight { return }
        resourceRefreshInFlight = true
        let rootPid = Int32(status.pid)
        let startedAt = status.startedAt
        let previous = lastResourceSample?.rootPid == rootPid ? lastResourceSample : nil
        resourceQueue.async { [weak self] in
            let sample = sampleIndexerResources(rootPid: rootPid, statusStartedAt: startedAt, previous: previous)
            let usage = sample.map { computeResourceUsage(previous: previous, current: $0) } ?? unavailableResourceUsage
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.resourceRefreshInFlight = false
                guard generation == self.resourceGeneration else { return }
                self.lastResourceSample = sample
                self.resourceSection?.update(usage: usage, serviceRunning: self.serviceRunning)
            }
        }
    }

    // .common mode: the default-mode timer above does not fire while AppKit tracks the open menu.
    private func startResourceSampling() {
        resourceTimer?.invalidate()
        let timer = Timer(timeInterval: Self.resourceSampleInterval, repeats: true) { [weak self] _ in
            self?.requestResourceRefresh()
        }
        RunLoop.main.add(timer, forMode: .common)
        resourceTimer = timer
        requestResourceRefresh()
    }

    private func stopResourceSampling() {
        resourceTimer?.invalidate()
        resourceTimer = nil
        resourceSection = nil
        lastResourceSample = nil
        resourceGeneration += 1
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
        let appearance = trayButtonAppearance(service: serviceState, processRunning: processRunning, status: files?.status)
        let updates = trayButtonUpdates(shown: shownAppearance, next: appearance)
        if updates.image {
            button.image = createTrayIcon(isIndexing: appearance.isIndexing, isError: appearance.isError)
        }
        if updates.toolTip {
            button.toolTip = appearance.toolTip
        }
        shownAppearance = appearance
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
        stopResourceSampling()
        resourceSection = ResourceMenuSection(
            usage: nil, serviceRunning: serviceRunning, unifiedMemory: hostHasUnifiedMemory)
        let builtMenu = buildStatusMenu(
            target: self, running: serviceRunning, headline: headline, plan: plan,
            currentStatus: files?.status, currentConfig: files?.config, resourceItem: resourceSection?.item)
        for item in builtMenu.items {
            builtMenu.removeItem(item)
            menu.addItem(item)
        }
        requestFileRefresh()
        requestServiceRefresh(force: true)
        startResourceSampling()
    }

    func menuDidClose(_ menu: NSMenu) {
        stopResourceSampling()
    }
}
