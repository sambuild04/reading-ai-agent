import AppKit
import ApplicationServices
import Foundation

// Reads the macOS Accessibility Tree from any application.
// Codex-inspired optimizations: BFS with depth/element/time caps, role pruning.
//
// Usage:
//   read-ax-tree                     → read focused app
//   read-ax-tree --app "Google Chrome" → read specific app
//   read-ax-tree --pid 12345         → read specific PID
//   read-ax-tree --list-windows      → list all windows with their apps
//   read-ax-tree --json              → output as JSON array of {role, text, x, y, w, h}

struct AXNode {
    let role: String
    let text: String
    let x: Double
    let y: Double
    let w: Double
    let h: Double
    let depth: Int
}

// Traversal caps — mirrors Codex's approach to keep token costs manageable
let MAX_DEPTH = 100
let MAX_ELEMENTS = 2000
let TIMEOUT_SECONDS: TimeInterval = 5.0

// Non-interactable roles pruned by default (Codex prunes 14 such roles)
// NOTE: AXUnknown and AXRow are NOT pruned — WeChat uses them for message content.
let SKIP_ROLES: Set<String> = [
    "AXScrollBar", "AXSplitter", "AXGrowArea", "AXRuler",
    "AXImage", "AXProgressIndicator",
    "AXMatte", "AXValueIndicator", "AXRelevanceIndicator",
    "AXBusyIndicator", "AXIncrementor", "AXColumn",
]

// Container roles — only recurse into children, don't emit as content.
// AXRow, AXCell are NOT containers here because WeChat puts message text in their titles.
let CONTAINER_ROLES: Set<String> = [
    "AXGroup", "AXList", "AXScrollArea", "AXSplitGroup",
    "AXTabGroup", "AXToolbar", "AXLayoutArea",
    "AXWindow", "AXApplication", "AXOutline",
    "AXTable", "AXBrowser", "AXSheet", "AXDrawer",
]

func getStringAttr(_ element: AXUIElement, _ attr: String) -> String? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
    guard result == .success, let str = value as? String, !str.isEmpty else { return nil }
    return str
}

func getPosition(_ element: AXUIElement) -> (Double, Double)? {
    var posValue: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, kAXPositionAttribute as String as CFString, &posValue)
    guard result == .success else { return nil }
    var point = CGPoint.zero
    if AXValueGetValue(posValue as! AXValue, .cgPoint, &point) {
        return (Double(point.x), Double(point.y))
    }
    return nil
}

func getSize(_ element: AXUIElement) -> (Double, Double)? {
    var sizeValue: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, kAXSizeAttribute as String as CFString, &sizeValue)
    guard result == .success else { return nil }
    var size = CGSize.zero
    if AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) {
        return (Double(size.width), Double(size.height))
    }
    return nil
}

func getChildren(_ element: AXUIElement) -> [AXUIElement] {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as String as CFString, &value)
    guard result == .success, let children = value as? [AXUIElement] else { return [] }
    return children
}

var collectedNodes: [AXNode] = []
var textParts: [String] = []
var startTime: Date = Date()
var jsonMode = false

func isTimedOut() -> Bool {
    return Date().timeIntervalSince(startTime) >= TIMEOUT_SECONDS
}

func walkTree(_ element: AXUIElement, depth: Int) {
    guard depth < MAX_DEPTH,
          collectedNodes.count < MAX_ELEMENTS,
          !isTimedOut() else { return }

    let role = getStringAttr(element, kAXRoleAttribute as String) ?? ""

    if SKIP_ROLES.contains(role) { return }

    let title = getStringAttr(element, kAXTitleAttribute as String) ?? ""
    let value = getStringAttr(element, kAXValueAttribute as String) ?? ""
    let desc = getStringAttr(element, kAXDescriptionAttribute as String) ?? ""
    let roleDesc = getStringAttr(element, kAXRoleDescriptionAttribute as String) ?? ""

    let hasContent = !title.isEmpty || !value.isEmpty || !desc.isEmpty
    let isContainer = CONTAINER_ROLES.contains(role)

    if hasContent && !isContainer {
        let pos = getPosition(element) ?? (0, 0)
        let sz = getSize(element) ?? (0, 0)

        let node = AXNode(
            role: roleDesc.isEmpty ? role : roleDesc,
            text: !title.isEmpty ? title : (!desc.isEmpty ? desc : ""),
            x: pos.0, y: pos.1,
            w: sz.0, h: sz.1,
            depth: depth
        )
        collectedNodes.append(node)

        if !jsonMode {
            let indent = String(repeating: "  ", count: depth)
            var line = "\(indent)[\(node.role)]"
            if !title.isEmpty { line += " \(title)" }
            if !value.isEmpty {
                let trimmed = value.count > 200 ? String(value.prefix(200)) + "..." : value
                line += ": \(trimmed)"
            }
            if !desc.isEmpty && desc != title { line += " (\(desc))" }
            textParts.append(line)
        }
    }

    // Don't recurse into text areas/fields — their value is already captured
    if role == "AXTextArea" || role == "AXTextField" {
        return
    }

    for child in getChildren(element) {
        if collectedNodes.count >= MAX_ELEMENTS || isTimedOut() { break }
        walkTree(child, depth: depth + 1)
    }
}

func readApp(_ appElement: AXUIElement, appName: String) -> String {
    collectedNodes = []
    textParts = []
    startTime = Date()

    if !jsonMode {
        textParts.append("=== \(appName) ===")
    }

    var windowsValue: AnyObject?
    AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as String as CFString, &windowsValue)
    let windows = windowsValue as? [AXUIElement] ?? []

    if windows.isEmpty {
        walkTree(appElement, depth: 0)
    } else {
        for (i, window) in windows.prefix(5).enumerated() {
            if isTimedOut() { break }
            let winTitle = getStringAttr(window, kAXTitleAttribute as String) ?? "Window \(i + 1)"
            if !jsonMode {
                textParts.append("\n--- \(winTitle) ---")
            }
            walkTree(window, depth: 0)
        }
    }

    let elapsed = Date().timeIntervalSince(startTime)
    let truncated = collectedNodes.count >= MAX_ELEMENTS || elapsed >= TIMEOUT_SECONDS

    if jsonMode {
        var jsonArray: [[String: Any]] = []
        for node in collectedNodes {
            jsonArray.append([
                "role": node.role,
                "text": node.text,
                "x": Int(node.x),
                "y": Int(node.y),
                "w": Int(node.w),
                "h": Int(node.h),
            ])
        }
        let meta: [String: Any] = [
            "app": appName,
            "elements": collectedNodes.count,
            "elapsed_ms": Int(elapsed * 1000),
            "truncated": truncated,
        ]
        let output: [String: Any] = ["meta": meta, "nodes": jsonArray]
        if let data = try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]),
           let str = String(data: data, encoding: .utf8) {
            return str
        }
        return "{\"error\": \"JSON serialization failed\"}"
    }

    if truncated {
        textParts.append("\n[truncated: \(collectedNodes.count) elements in \(Int(elapsed * 1000))ms]")
    }

    return textParts.joined(separator: "\n")
}

func findAppByName(_ name: String) -> (pid_t, String)? {
    let workspace = NSWorkspace.shared
    for app in workspace.runningApplications {
        guard let appName = app.localizedName else { continue }
        if appName.localizedCaseInsensitiveContains(name) {
            return (app.processIdentifier, appName)
        }
    }
    return nil
}

func listWindows() -> String {
    let workspace = NSWorkspace.shared
    var lines: [String] = []
    for app in workspace.runningApplications {
        guard app.activationPolicy == .regular, let name = app.localizedName else { continue }
        let pid = app.processIdentifier
        let appRef = AXUIElementCreateApplication(pid)
        var windowsValue: AnyObject?
        AXUIElementCopyAttributeValue(appRef, kAXWindowsAttribute as String as CFString, &windowsValue)
        let windows = windowsValue as? [AXUIElement] ?? []
        for window in windows {
            let title = getStringAttr(window, kAXTitleAttribute as String) ?? "(untitled)"
            lines.append("\(name): \(title)")
        }
    }
    return lines.isEmpty ? "No windows found" : lines.joined(separator: "\n")
}

func getFocusedApp() -> (pid_t, String)? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    return (app.processIdentifier, app.localizedName ?? "Unknown")
}

// Check accessibility permission
let trusted = AXIsProcessTrustedWithOptions(
    [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): false] as CFDictionary
)
if !trusted {
    fputs("[ax-tree] WARNING: Accessibility permission not granted. Enable in System Settings → Privacy → Accessibility\n", stderr)
}

// Parse arguments
var targetApp: String? = nil
var targetPid: pid_t? = nil
var doListWindows = false

var argIdx = 1
while argIdx < CommandLine.arguments.count {
    let arg = CommandLine.arguments[argIdx]
    if arg == "--app", argIdx + 1 < CommandLine.arguments.count {
        argIdx += 1
        targetApp = CommandLine.arguments[argIdx]
    } else if arg == "--pid", argIdx + 1 < CommandLine.arguments.count {
        argIdx += 1
        targetPid = pid_t(CommandLine.arguments[argIdx]) ?? nil
    } else if arg == "--list-windows" {
        doListWindows = true
    } else if arg == "--json" {
        jsonMode = true
    }
    argIdx += 1
}

if doListWindows {
    print(listWindows())
    exit(0)
}

var pid: pid_t
var appName: String

if let tp = targetPid {
    pid = tp
    appName = NSRunningApplication(processIdentifier: tp)?.localizedName ?? "PID \(tp)"
} else if let ta = targetApp {
    guard let found = findAppByName(ta) else {
        fputs("[ax-tree] App not found: \(ta)\n", stderr)
        exit(1)
    }
    pid = found.0
    appName = found.1
} else {
    guard let focused = getFocusedApp() else {
        fputs("[ax-tree] No focused app\n", stderr)
        exit(1)
    }
    pid = focused.0
    appName = focused.1
}

let appRef = AXUIElementCreateApplication(pid)
let output = readApp(appRef, appName: appName)
print(output)
