#!/usr/bin/env swift
// native-input.swift — CGEvent-based mouse/keyboard control for any macOS app.
// Used by Samuel's Computer interface to interact with the desktop natively.
//
// Usage:
//   swift native-input.swift click <x> <y> [button]
//   swift native-input.swift double_click <x> <y>
//   swift native-input.swift move <x> <y>
//   swift native-input.swift type <text>
//   swift native-input.swift keypress <key1> [key2] ...
//   swift native-input.swift scroll <x> <y> <scroll_x> <scroll_y>
//   swift native-input.swift drag <x1> <y1> <x2> <y2> [more x,y pairs...]

import Foundation
import CoreGraphics
import Carbon

// MARK: - Key code mapping

let keyCodeMap: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
    "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22,
    "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
    "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37,
    "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
    "n": 45, "m": 46, ".": 47, "`": 50, " ": 49,

    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51,
    "backspace": 51, "escape": 53, "esc": 53,
    "command": 55, "cmd": 55, "meta": 55, "super": 55,
    "shift": 56, "capslock": 57, "option": 58, "alt": 58,
    "control": 59, "ctrl": 59,
    "right_shift": 60, "right_option": 61, "right_control": 62,
    "fn": 63,

    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "f13": 105, "f14": 107, "f15": 113,

    "up": 126, "down": 125, "left": 123, "right": 124,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "forward_delete": 117,

    "volume_up": 72, "volume_down": 73, "mute": 74,
]

// Modifier keys that map to CGEventFlags
let modifierFlags: [String: CGEventFlags] = [
    "command": .maskCommand, "cmd": .maskCommand, "meta": .maskCommand, "super": .maskCommand,
    "shift": .maskShift,
    "option": .maskAlternate, "alt": .maskAlternate,
    "control": .maskControl, "ctrl": .maskControl,
    "fn": .maskSecondaryFn,
]

func keyCode(for key: String) -> CGKeyCode? {
    return keyCodeMap[key.lowercased()]
}

// MARK: - Mouse actions

func click(x: Double, y: Double, button: String = "left") {
    let point = CGPoint(x: x, y: y)

    let (downType, upType): (CGEventType, CGEventType)
    let mouseButton: CGMouseButton

    switch button {
    case "right":
        downType = .rightMouseDown
        upType = .rightMouseUp
        mouseButton = .right
    default:
        downType = .leftMouseDown
        upType = .leftMouseUp
        mouseButton = .left
    }

    guard let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: mouseButton),
          let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: mouseButton)
    else {
        fputs("ERROR: Failed to create mouse event\n", stderr)
        return
    }

    down.post(tap: .cghidEventTap)
    usleep(50_000)
    up.post(tap: .cghidEventTap)
    usleep(50_000)
}

func doubleClick(x: Double, y: Double) {
    let point = CGPoint(x: x, y: y)

    guard let down1 = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
          let up1 = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left),
          let down2 = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
          let up2 = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
    else {
        fputs("ERROR: Failed to create double-click event\n", stderr)
        return
    }

    down1.setIntegerValueField(.mouseEventClickState, value: 1)
    up1.setIntegerValueField(.mouseEventClickState, value: 1)
    down2.setIntegerValueField(.mouseEventClickState, value: 2)
    up2.setIntegerValueField(.mouseEventClickState, value: 2)

    down1.post(tap: .cghidEventTap)
    usleep(30_000)
    up1.post(tap: .cghidEventTap)
    usleep(80_000)
    down2.post(tap: .cghidEventTap)
    usleep(30_000)
    up2.post(tap: .cghidEventTap)
    usleep(50_000)
}

func moveMouse(x: Double, y: Double) {
    let point = CGPoint(x: x, y: y)
    guard let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
        fputs("ERROR: Failed to create move event\n", stderr)
        return
    }
    event.post(tap: .cghidEventTap)
    usleep(30_000)
}

func scroll(x: Double, y: Double, scrollX: Int32, scrollY: Int32) {
    // Move cursor to position first
    moveMouse(x: x, y: y)
    usleep(50_000)

    // CGEvent scroll (positive scrollY = scroll up in CGEvent convention)
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: scrollY, wheel2: scrollX, wheel3: 0) else {
        fputs("ERROR: Failed to create scroll event\n", stderr)
        return
    }
    event.post(tap: CGEventTapLocation.cghidEventTap)
    usleep(50_000)
}

func drag(path: [(Double, Double)]) {
    guard path.count >= 2 else {
        fputs("ERROR: Drag needs at least 2 points\n", stderr)
        return
    }

    let start = CGPoint(x: path[0].0, y: path[0].1)

    // Mouse down at start
    guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left) else {
        fputs("ERROR: Failed to create drag-down event\n", stderr)
        return
    }
    down.post(tap: .cghidEventTap)
    usleep(50_000)

    // Move through intermediate points
    for i in 1..<path.count {
        let point = CGPoint(x: path[i].0, y: path[i].1)
        guard let drag = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left) else { continue }
        drag.post(tap: .cghidEventTap)
        usleep(20_000)
    }

    // Mouse up at end
    let end = CGPoint(x: path.last!.0, y: path.last!.1)
    guard let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left) else {
        return
    }
    up.post(tap: .cghidEventTap)
    usleep(50_000)
}

// MARK: - Keyboard actions

func typeText(_ text: String) {
    // Use CGEvent key-down/key-up for each character via the Unicode input method
    for char in text {
        let utf16 = Array(String(char).utf16)
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) else { continue }
        event.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        event.post(tap: .cghidEventTap)

        guard let upEvent = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { continue }
        upEvent.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        upEvent.post(tap: .cghidEventTap)
        usleep(20_000)
    }
}

func keypress(keys: [String]) {
    // Parse modifier+key combos like ["cmd", "c"] or just ["enter"]
    var flags: CGEventFlags = []
    var regularKeys: [String] = []

    for key in keys {
        let lower = key.lowercased()
        if let flag = modifierFlags[lower] {
            flags.insert(flag)
        } else {
            regularKeys.append(lower)
        }
    }

    if regularKeys.isEmpty && !flags.isEmpty {
        // Just modifiers pressed (e.g. shift alone) — press and release
        if let code = keyCodeMap[keys.last!.lowercased()] {
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { return }
            down.post(tap: .cghidEventTap)
            usleep(50_000)
            up.post(tap: .cghidEventTap)
            usleep(30_000)
        }
        return
    }

    // For each regular key, press with modifiers held
    for key in regularKeys {
        guard let code = keyCode(for: key) else {
            fputs("WARNING: Unknown key '\(key)'\n", stderr)
            continue
        }

        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { continue }

        down.flags = flags
        up.flags = flags

        down.post(tap: .cghidEventTap)
        usleep(50_000)
        up.post(tap: .cghidEventTap)
        usleep(30_000)
    }
}

// MARK: - Main

let args = CommandLine.arguments
guard args.count >= 2 else {
    fputs("Usage: native-input.swift <action> [params...]\n", stderr)
    exit(1)
}

let action = args[1]

switch action {
case "click":
    guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else {
        fputs("Usage: click <x> <y> [button]\n", stderr)
        exit(1)
    }
    let button = args.count > 4 ? args[4] : "left"
    click(x: x, y: y, button: button)
    print("OK")

case "double_click":
    guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else {
        fputs("Usage: double_click <x> <y>\n", stderr)
        exit(1)
    }
    doubleClick(x: x, y: y)
    print("OK")

case "move":
    guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else {
        fputs("Usage: move <x> <y>\n", stderr)
        exit(1)
    }
    moveMouse(x: x, y: y)
    print("OK")

case "scroll":
    guard args.count >= 6,
          let x = Double(args[2]), let y = Double(args[3]),
          let sx = Int32(args[4]), let sy = Int32(args[5]) else {
        fputs("Usage: scroll <x> <y> <scroll_x> <scroll_y>\n", stderr)
        exit(1)
    }
    scroll(x: x, y: y, scrollX: sx, scrollY: sy)
    print("OK")

case "type":
    guard args.count >= 3 else {
        fputs("Usage: type <text>\n", stderr)
        exit(1)
    }
    let text = args[2...].joined(separator: " ")
    typeText(text)
    print("OK")

case "keypress":
    guard args.count >= 3 else {
        fputs("Usage: keypress <key1> [key2] ...\n", stderr)
        exit(1)
    }
    let keys = Array(args[2...])
    keypress(keys: keys)
    print("OK")

case "drag":
    guard args.count >= 6 else {
        fputs("Usage: drag <x1> <y1> <x2> <y2> [more pairs...]\n", stderr)
        exit(1)
    }
    var path: [(Double, Double)] = []
    var i = 2
    while i + 1 < args.count {
        if let x = Double(args[i]), let y = Double(args[i + 1]) {
            path.append((x, y))
        }
        i += 2
    }
    drag(path: path)
    print("OK")

default:
    fputs("Unknown action: \(action)\n", stderr)
    exit(1)
}
