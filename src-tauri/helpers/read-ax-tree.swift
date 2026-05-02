import AppKit
import ApplicationServices
import Foundation

// Reads the macOS Accessibility Tree from any application.
// Returns structured text content — same approach Codex uses.
//
// Usage:
//   read-ax-tree                     → read focused app
//   read-ax-tree --app "Google Chrome" → read specific app
//   read-ax-tree --pid 12345         → read specific PID
//   read-ax-tree --list-windows      → list all windows with their apps

struct AXNode {
    let role: String
    let title: String
    let value: String
    let depth: Int
}

func getStringAttr(_ element: AXUIElement, _ attr: String) -> String? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
    guard result == .success, let str = value as? String, !str.isEmpty else { return nil }
    return str
}

func getChildren(_ element: AXUIElement) -> [AXUIElement] {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as String as CFString, &value)
    guard result == .success, let children = value as? [AXUIElement] else { return [] }
    return children
}

var collectedNodes: [AXNode] = []
var textParts: [String] = []
let maxDepth = 15
let maxNodes = 500

func walkTree(_ element: AXUIElement, depth: Int) {
    guard depth < maxDepth, collectedNodes.count < maxNodes else { return }

    let role = getStringAttr(element, kAXRoleAttribute as String) ?? ""
    let title = getStringAttr(element, kAXTitleAttribute as String) ?? ""
    let value = getStringAttr(element, kAXValueAttribute as String) ?? ""
    let desc = getStringAttr(element, kAXDescriptionAttribute as String) ?? ""
    let roleDesc = getStringAttr(element, kAXRoleDescriptionAttribute as String) ?? ""

    let skipRoles: Set<String> = [
        "AXScrollBar", "AXSplitter", "AXGrowArea", "AXRuler",
        "AXUnknown", "AXImage", "AXProgressIndicator",
    ]
    if skipRoles.contains(role) { return }

    let hasContent = !title.isEmpty || !value.isEmpty || !desc.isEmpty
    let isContainer = ["AXGroup", "AXList", "AXScrollArea", "AXSplitGroup",
                       "AXTabGroup", "AXToolbar", "AXLayoutArea",
                       "AXWindow", "AXApplication"].contains(role)

    if hasContent && !isContainer {
        let indent = String(repeating: "  ", count: depth)
        var line = "\(indent)[\(roleDesc.isEmpty ? role : roleDesc)]"
        if !title.isEmpty { line += " \(title)" }
        if !value.isEmpty {
            let trimmed = value.count > 200 ? String(value.prefix(200)) + "..." : value
            line += ": \(trimmed)"
        }
        if !desc.isEmpty && desc != title { line += " (\(desc))" }
        collectedNodes.append(AXNode(role: role, title: title, value: value, depth: depth))
        textParts.append(line)
    }

    // Recurse into text areas/fields to get their full value, but don't recurse further
    if role == "AXTextArea" || role == "AXTextField" {
        return
    }

    for child in getChildren(element) {
        walkTree(child, depth: depth + 1)
    }
}

func readApp(_ appElement: AXUIElement, appName: String) -> String {
    collectedNodes = []
    textParts = []
    textParts.append("=== \(appName) ===")

    // Get all windows
    var windowsValue: AnyObject?
    AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as String as CFString, &windowsValue)
    let windows = windowsValue as? [AXUIElement] ?? []

    if windows.isEmpty {
        // Try reading the app element directly
        walkTree(appElement, depth: 0)
    } else {
        for (i, window) in windows.prefix(3).enumerated() {
            let winTitle = getStringAttr(window, kAXTitleAttribute as String) ?? "Window \(i + 1)"
            textParts.append("\n--- \(winTitle) ---")
            walkTree(window, depth: 0)
        }
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
