import Cocoa

// The "Resources:" row and its per-process submenu. The tray keeps one instance while the menu is
// open and retitles its rows on every sample. Rows are inserted or removed only when the number of
// processes changes, because restructuring an open menu makes it jump.

final class ResourceMenuSection {
    let item: NSMenuItem
    private let submenu = NSMenu()
    private let unifiedMemory: Bool
    private var processRows: [NSMenuItem] = []
    private var footerRows: [NSMenuItem] = []
    private let separator = NSMenuItem.separator()

    /// Nil when the service is not running, so the menu shows no resource row at all. Once shown,
    /// the row stays until the menu closes and reports a service that stopped meanwhile.
    init?(usage: ResourceUsage?, serviceRunning: Bool, unifiedMemory: Bool) {
        guard serviceRunning else { return nil }
        self.unifiedMemory = unifiedMemory
        item = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        submenu.autoenablesItems = false
        // The row stays enabled even before the first sample: a disabled row cannot open its submenu.
        item.submenu = submenu
        submenu.addItem(separator)
        update(usage: usage, serviceRunning: serviceRunning)
    }

    func update(usage: ResourceUsage?, serviceRunning: Bool) {
        let content = resourceMenuContent(usage: usage, serviceRunning: serviceRunning, unifiedMemory: unifiedMemory)
        let title = "  " + content.title
        if item.title != title {
            item.title = title
            item.attributedTitle = digitAlignedTitle(title)
        }
        processRows = retitle(processRows, with: content.processRows, insertingAt: 0)
        footerRows = retitle(footerRows, with: content.footerRows, insertingAt: submenu.index(of: separator) + 1)
        separator.isHidden = content.footerRows.isEmpty
    }

    /// Reuses the existing rows and only adds or removes the difference at the end of the group.
    private func retitle(_ rows: [NSMenuItem], with lines: [String], insertingAt start: Int) -> [NSMenuItem] {
        var rows = rows
        while rows.count > lines.count { submenu.removeItem(rows.removeLast()) }
        while rows.count < lines.count {
            let row = NSMenuItem(title: "", action: nil, keyEquivalent: "")
            row.isEnabled = false
            submenu.insertItem(row, at: start + rows.count)
            rows.append(row)
        }
        for (row, line) in zip(rows, lines) where row.title != line {
            row.title = line
            row.attributedTitle = digitAlignedTitle(line)
        }
        return rows
    }

    /// Tabular digits keep the row width steady while the numbers change every second.
    private func digitAlignedTitle(_ text: String) -> NSAttributedString {
        let size = NSFont.menuFont(ofSize: 0).pointSize
        return NSAttributedString(
            string: text, attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: size, weight: .regular)])
    }
}
