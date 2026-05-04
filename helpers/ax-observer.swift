import AppKit
import ApplicationServices
import Foundation

// AXObserver — push-based accessibility notifications.
// Watches the focused app for UI changes and emits JSON events on stdout.
// The Electron main process reads stdout lines and forwards to the session.
//
// Usage:
//   ax-observer              → watch the currently focused app
//   ax-observer --pid 12345  → watch a specific PID
//
// Output (one JSON line per event):
//   {"event":"focus_changed","app":"Chrome","element":"Address and search bar","role":"AXTextField"}
//   {"event":"value_changed","app":"Chrome","element":"search field","value":"hello world"}
//   {"event":"window_created","app":"Chrome","title":"New Tab"}

var observedPid: pid_t = 0
var observer: AXObserver?

func emitEvent(_ dict: [String: String]) {
    if let data = try? JSONSerialization.data(withJSONObject: dict, options: []),
       let str = String(data: data, encoding: .utf8) {
        print(str)
        fflush(stdout)
    }
}

func getStringAttr(_ element: AXUIElement, _ attr: String) -> String? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
    guard result == .success, let str = value as? String, !str.isEmpty else { return nil }
    return str
}

let observerCallback: AXObserverCallback = { _, element, notification, _ in
    let notifStr = notification as String
    let role = getStringAttr(element, kAXRoleAttribute as String) ?? ""
    let title = getStringAttr(element, kAXTitleAttribute as String) ?? ""
    let value = getStringAttr(element, kAXValueAttribute as String) ?? ""
    let desc = getStringAttr(element, kAXDescriptionAttribute as String) ?? ""

    let label = !title.isEmpty ? title : (!desc.isEmpty ? desc : role)

    let appName = NSRunningApplication(processIdentifier: observedPid)?.localizedName ?? "Unknown"

    switch notifStr {
    case kAXFocusedUIElementChangedNotification as String:
        emitEvent([
            "event": "focus_changed",
            "app": appName,
            "element": label,
            "role": role,
        ])

    case kAXValueChangedNotification as String:
        let trimmedValue = value.count > 200 ? String(value.prefix(200)) + "..." : value
        emitEvent([
            "event": "value_changed",
            "app": appName,
            "element": label,
            "value": trimmedValue,
        ])

    case kAXWindowCreatedNotification as String:
        emitEvent([
            "event": "window_created",
            "app": appName,
            "title": title,
        ])

    case kAXUIElementDestroyedNotification as String:
        emitEvent([
            "event": "element_destroyed",
            "app": appName,
            "element": label,
        ])

    case kAXSelectedTextChangedNotification as String:
        emitEvent([
            "event": "selection_changed",
            "app": appName,
            "element": label,
        ])

    default:
        emitEvent([
            "event": notifStr,
            "app": appName,
            "element": label,
        ])
    }
}

func startObserving(pid: pid_t) {
    observedPid = pid

    var obs: AXObserver?
    let result = AXObserverCreate(pid, observerCallback, &obs)
    guard result == .success, let newObserver = obs else {
        fputs("[ax-observer] Failed to create observer for PID \(pid)\n", stderr)
        return
    }
    observer = newObserver

    let appRef = AXUIElementCreateApplication(pid)

    let notifications: [String] = [
        kAXFocusedUIElementChangedNotification as String,
        kAXValueChangedNotification as String,
        kAXWindowCreatedNotification as String,
        kAXUIElementDestroyedNotification as String,
        kAXSelectedTextChangedNotification as String,
    ]

    for notif in notifications {
        AXObserverAddNotification(newObserver, appRef, notif as CFString, nil)
    }

    CFRunLoopAddSource(
        CFRunLoopGetCurrent(),
        AXObserverGetRunLoopSource(newObserver),
        .defaultMode
    )

    let appName = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "PID \(pid)"
    fputs("[ax-observer] Watching \(appName) (PID \(pid))\n", stderr)
    emitEvent(["event": "started", "app": appName, "pid": String(pid)])
}

// Also watch for app activation changes to re-attach the observer
let workspace = NSWorkspace.shared
let nc = workspace.notificationCenter
nc.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil) { notif in
    guard let app = notif.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
    let newPid = app.processIdentifier
    if newPid != observedPid {
        // Remove old observer
        if let old = observer {
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(old), .defaultMode)
        }
        startObserving(pid: newPid)
    }
}

// Parse arguments
var targetPid: pid_t? = nil

var argIdx = 1
while argIdx < CommandLine.arguments.count {
    let arg = CommandLine.arguments[argIdx]
    if arg == "--pid", argIdx + 1 < CommandLine.arguments.count {
        argIdx += 1
        targetPid = pid_t(CommandLine.arguments[argIdx])
    }
    argIdx += 1
}

// Start observing
if let pid = targetPid {
    startObserving(pid: pid)
} else if let focused = NSWorkspace.shared.frontmostApplication {
    startObserving(pid: focused.processIdentifier)
} else {
    fputs("[ax-observer] No focused app found\n", stderr)
    exit(1)
}

// Keep the run loop going
CFRunLoopRun()
