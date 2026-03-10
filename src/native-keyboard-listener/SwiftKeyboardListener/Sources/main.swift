/**
 * Swift Keyboard Listener
 *
 * Uses CGEventTap to capture keyboard events at the system level,
 * allowing detection of left vs right modifier keys.
 *
 * Communicates with Node.js via stdin/stdout JSON protocol:
 * - Commands (stdin): start, stop, setShortcut
 * - Events (stdout): keydown, keyup, shortcut
 */

import Foundation
import CoreFoundation
import CoreGraphics

// MARK: - Key Code Mapping

struct KeyCodeMap {
    static let keyCodeToName: [Int64: String] = [
        // Modifier keys with side
        54: "MetaRight",    // Command Right
        55: "MetaLeft",     // Command Left
        61: "AltRight",     // Option Right
        58: "AltLeft",      // Option Left
        62: "ControlRight", // Control Right
        59: "ControlLeft",  // Control Left
        60: "ShiftRight",   // Shift Right
        56: "ShiftLeft",    // Shift Left

        // Special keys
        53: "Escape",
        48: "Tab",
        36: "Return",
        51: "Delete",
        49: "Space",

        // Arrow keys
        126: "ArrowUp",
        125: "ArrowDown",
        123: "ArrowLeft",
        124: "ArrowRight",

        // Function keys
        122: "F1",
        120: "F2",
        99:  "F3",
        118: "F4",
        96:  "F5",
        97:  "F6",
        98:  "F7",
        100: "F8",
        101: "F9",
        109: "F10",
        103: "F11",
        111: "F12",

        // Numbers
        18: "1", 19: "2", 20: "3",
        21: "4", 23: "5", 22: "6",
        26: "7", 28: "9", 25: "0",

        // Letters A-Z
        0: "A", 1: "S", 2: "D",
        3: "F", 4: "H", 5: "G",
        6: "Z", 7: "X", 8: "C",
        9: "V", 11: "B", 12: "Q",
        13: "W", 14: "E", 15: "R",
        16: "Y", 17: "T", 31: "O",
        32: "U", 34: "I", 35: "P",
        37: "L", 38: "J", 40: "K",
        45: "N", 46: "M",

        // Punctuation
        27: "-", 24: "=", 33: "[",
        30: "]", 42: "\\", 39: ";",
        41: "'", 43: ",", 47: ".",
        44: "/", 50: "`",

        // More keys
        114: "Help",
        115: "ForwardDelete",
        116: "Home",
        117: "End",
        119: "PageUp",
        121: "PageDown",
    ]

    static let keyCodeToSide: [Int64: String] = [
        54: "right",  // Command Right
        55: "left",   // Command Left
        61: "right", // Option Right
        58: "left",  // Option Left
        62: "right", // Control Right
        59: "left",  // Control Left
        60: "right", // Shift Right
        56: "left",  // Shift Left
    ]

    static func keyName(for keyCode: Int64) -> String {
        return keyCodeToName[keyCode] ?? "Unknown"
    }

    static func keySide(for keyCode: Int64) -> String {
        return keyCodeToSide[keyCode] ?? "unknown"
    }
}

// MARK: - Modifier State

class ModifierState {
    var leftCommand = false
    var rightCommand = false
    var leftOption = false
    var rightOption = false
    var leftControl = false
    var rightControl = false
    var leftShift = false
    var rightShift = false

    var currentKeys: Set<Int64> = []

    func reset() {
        leftCommand = false
        rightCommand = false
        leftOption = false
        rightOption = false
        leftControl = false
        rightControl = false
        leftShift = false
        rightShift = false
        currentKeys.removeAll()
    }

    func getModifiers() -> [String] {
        var modifiers: [String] = []

        if leftControl || rightControl {
            modifiers.append(rightControl ? "ControlRight" : "ControlLeft")
        }
        if leftOption || rightOption {
            modifiers.append(rightOption ? "AltRight" : "AltLeft")
        }
        if leftShift || rightShift {
            modifiers.append(rightShift ? "ShiftRight" : "ShiftLeft")
        }
        if leftCommand || rightCommand {
            modifiers.append(rightCommand ? "MetaRight" : "MetaLeft")
        }

        return modifiers
    }
}

// MARK: - Shortcut Configuration

struct ShortcutConfig {
    var side: String = "any"  // "left", "right", "any"
    var modifiers: [String] = []  // Base modifiers (e.g., "Alt", "Meta")
    var rawModifiers: [String] = []  // Original modifiers (e.g., "LeftOption", "RightCommand")
    var key: String? = nil

    static func parse(_ shortcut: String) -> ShortcutConfig? {
        guard !shortcut.isEmpty else { return nil }

        let parts = shortcut.split(separator: "+").map { String($0).trimmingCharacters(in: .whitespaces) }
        guard !parts.isEmpty else { return nil }

        var config = ShortcutConfig()

        for part in parts {
            if part.hasPrefix("Left") {
                config.side = "left"
                let modifier = String(part.dropFirst(4))
                config.modifiers.append(mapModifier(modifier))
                config.rawModifiers.append(part)  // Keep original name
            } else if part.hasPrefix("Right") {
                config.side = "right"
                let modifier = String(part.dropFirst(5))
                config.modifiers.append(mapModifier(modifier))
                config.rawModifiers.append(part)  // Keep original name
            } else if isModifierKey(part) {
                config.modifiers.append(mapModifier(part))
                config.rawModifiers.append(part)  // Keep original name
            } else {
                config.key = part
            }
        }

        return config
    }

    private static func mapModifier(_ name: String) -> String {
        switch name {
        case "Command", "Cmd": return "Meta"
        case "Ctrl", "Control": return "Control"
        case "Option", "Alt": return "Alt"
        case "Shift": return "Shift"
        default: return name
        }
    }

    /// Extract the base modifier name from a key name (e.g., "MetaRight" -> "Meta", "ControlLeft" -> "Control")
    static func baseModifierName(for keyName: String) -> String {
        let suffixes = ["Left", "Right"]
        for suffix in suffixes {
            if keyName.hasSuffix(suffix) {
                let base = String(keyName.dropLast(suffix.count))
                // Map back to canonical names
                switch base {
                case "Meta": return "Meta"
                case "Alt": return "Alt"
                case "Control": return "Control"
                case "Shift": return "Shift"
                default: return base
                }
            }
        }
        return keyName
    }

    private static func isModifierKey(_ key: String) -> Bool {
        let modifiers = ["Command", "Control", "Alt", "Shift", "Ctrl", "Meta", "Option"]
        return modifiers.contains(key)
    }

    func matches(keyName: String, pressedModifiers: [String], keySide: String) -> Bool {
        // Single key shortcut (modifier only)
        if key == nil && !self.modifiers.isEmpty {
            // Check keyName matches expected modifier type (e.g., "MetaRight" for "RightCommand")
            // Check the pressed modifier key matches the configured modifier type
            let configModifier = self.modifiers.first ?? ""
            let expectedBase = ShortcutConfig.baseModifierName(for: configModifier)
            let actualBase = ShortcutConfig.baseModifierName(for: keyName)
            if expectedBase != actualBase {
                return false
            }

            // Check all required modifiers are present in the pressed modifiers
            for required in self.modifiers {
                if !pressedModifiers.contains(where: { $0.hasPrefix(required) }) {
                    return false
                }
            }

            // Check side if specified
            if side != "any" {
                let keySideLower = keySide.lowercased()
                let sideMatch = (side == "left" && keySideLower == "left") ||
                               (side == "right" && keySideLower == "right")
                if !sideMatch {
                    return false
                }
            }

            return true
        }

        // Combo shortcut (modifier + key)
        if let key = key {
            // Check main key matches
            if keyName != key {
                return false
            }

            // Check all required modifiers
            for required in self.modifiers {
                if !pressedModifiers.contains(where: { $0.hasPrefix(required) }) {
                    return false
                }
            }

            // Check side for modifiers if specified
            if side != "any" {
                let sideMod = side == "left" ? "Left" : "Right"
                // 检查实际按下的修饰键中是否有匹配侧边要求的
                let hasMatchingSide = pressedModifiers.contains { modifier in
                    // 检查修饰键是否以指定侧边结尾（如 "AltLeft" 以 "Left" 结尾）
                    // 同时检查基础名称是否匹配配置的修饰键类型
                    guard modifier.hasSuffix(sideMod) else { return false }
                    let baseName = ShortcutConfig.baseModifierName(for: modifier)
                    return self.modifiers.contains(baseName)
                }
                if !hasMatchingSide {
                    return false
                }
            }

            return true
        }

        return false
    }
}

// MARK: - Event Output

func outputEvent(_ type: String, key: String, keyCode: Int64, side: String, modifiers: [String]) {
    let event: [String: Any] = [
        "type": type,
        "key": key,
        "code": key,
        "keyCode": keyCode,
        "side": side,
        "modifiers": modifiers,
        "timestamp": Int64(Date().timeIntervalSince1970 * 1000)
    ]

    if let jsonData = try? JSONSerialization.data(withJSONObject: event),
       let jsonString = String(data: jsonData, encoding: .utf8) {
        print(jsonString)
        fflush(stdout)
    }
}

func outputShortcutEvent(_ shortcut: String, id: String? = nil) {
    var event: [String: Any] = [
        "type": "shortcut",
        "shortcut": shortcut,
        "timestamp": Int64(Date().timeIntervalSince1970 * 1000)
    ]
    if let id = id {
        event["id"] = id
    }

    if let jsonData = try? JSONSerialization.data(withJSONObject: event),
       let jsonString = String(data: jsonData, encoding: .utf8) {
        print(jsonString)
        fflush(stdout)
    }
}

// MARK: - Event Tap

class KeyboardEventTap {
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private let modifierState = ModifierState()
    private var targetShortcuts: [(id: String, config: ShortcutConfig)] = []
    private var isRunning = false

    func isListenerRunning() -> Bool {
        return isRunning
    }

    func start() -> Bool {
        guard !isRunning else { return true }

        // Create event tap for key down, key up, and flags changed events
        let eventMask: CGEventMask =
            (1 << CGEventType.keyDown.rawValue) |
            (1 << CGEventType.keyUp.rawValue) |
            (1 << CGEventType.flagsChanged.rawValue)

        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: eventMask,
            callback: { (proxy, type, event, refcon) -> Unmanaged<CGEvent>? in
                guard let refcon = refcon else { return Unmanaged.passRetained(event) }
                let tap = Unmanaged<KeyboardEventTap>.fromOpaque(refcon).takeUnretainedValue()
                return tap.handleEvent(proxy: proxy, type: type, event: event)
            },
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            return false
        }

        eventTap = tap

        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        runLoopSource = source

        // Add to main run loop
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)

        isRunning = true
        return true
    }

    func stop() {
        guard isRunning else { return }

        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }

        if let source = runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .commonModes)
        }

        eventTap = nil
        runLoopSource = nil
        modifierState.reset()
        isRunning = false
    }

    func setShortcut(_ shortcut: String) {
        // 兼容旧版单快捷键
        if let config = ShortcutConfig.parse(shortcut) {
            targetShortcuts = [("shortcut", config)]
        } else {
            targetShortcuts = []
        }
    }

    func setShortcuts(_ shortcuts: [(id: String, shortcut: String)]) {
        targetShortcuts = shortcuts.compactMap { item in
            if let config = ShortcutConfig.parse(item.shortcut) {
                return (id: item.id, config: config)
            }
            return nil
        }
    }

    func getRunning() -> Bool {
        return isRunning
    }

    private func handleEvent(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap = eventTap {
                CGEvent.tapEnable(tap: tap, enable: true)
            }
            return Unmanaged.passRetained(event)
        }

        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        let flags = event.flags

        // Update modifier state for side detection
        updateModifierState(keyCode: keyCode, flags: flags, eventType: type)

        let keyName = KeyCodeMap.keyName(for: keyCode)
        let keySide = KeyCodeMap.keySide(for: keyCode)
        let modifiers = modifierState.getModifiers()

        switch type {
        case .keyDown:
            modifierState.currentKeys.insert(keyCode)

            // Check for shortcut match - 遍历所有注册的快捷键
            for (id, config) in targetShortcuts {
                if config.matches(keyName: keyName, pressedModifiers: modifiers, keySide: keySide) {
                    let shortcutString: String
                    if config.key != nil {
                        shortcutString = "\(config.rawModifiers.joined(separator: "+"))+\(config.key!)"
                    } else {
                        shortcutString = config.rawModifiers.first ?? ""
                    }
                    outputShortcutEvent(shortcutString, id: id)
                    break // 匹配到一个就停止
                }
            }

            outputEvent("keydown", key: keyName, keyCode: keyCode, side: keySide, modifiers: modifiers)

        case .keyUp:
            modifierState.currentKeys.remove(keyCode)
            outputEvent("keyup", key: keyName, keyCode: keyCode, side: keySide, modifiers: modifiers)

        case .flagsChanged:
            // Handle modifier-only key releases
            handleFlagsChanged(keyCode: keyCode, flags: flags)

            // Check for shortcut match on modifier key press (via flagsChanged)
            // Only for single-key shortcuts (config.key == nil)
            // Note: must get modifiers AFTER handleFlagsChanged updates the state
            let currentModifiers = modifierState.getModifiers()
            for (id, config) in targetShortcuts {
                if config.key == nil {
                    if config.matches(keyName: keyName, pressedModifiers: currentModifiers, keySide: keySide) {
                        let shortcutString = config.rawModifiers.first ?? ""
                        outputShortcutEvent(shortcutString, id: id)
                        break
                    }
                }
            }

        default:
            break
        }

        return Unmanaged.passRetained(event)
    }

    private func updateModifierState(keyCode: Int64, flags: CGEventFlags, eventType: CGEventType) {
        let isKeyDown = (eventType == .keyDown)

        switch keyCode {
        case 55: modifierState.leftCommand = isKeyDown
        case 54: modifierState.rightCommand = isKeyDown
        case 58: modifierState.leftOption = isKeyDown
        case 61: modifierState.rightOption = isKeyDown
        case 59: modifierState.leftControl = isKeyDown
        case 62: modifierState.rightControl = isKeyDown
        case 56: modifierState.leftShift = isKeyDown
        case 60: modifierState.rightShift = isKeyDown
        default: break
        }
    }

    private func handleFlagsChanged(keyCode: Int64, flags: CGEventFlags) {
        let cmdPressed = flags.contains(.maskCommand)
        let optPressed = flags.contains(.maskAlternate)
        let ctrlPressed = flags.contains(.maskControl)
        let shiftPressed = flags.contains(.maskShift)

        // Check for modifier key releases (flagsChanged is fired when modifier is pressed/released alone)
        switch keyCode {
        case 55: // Left Command
            if !cmdPressed && modifierState.leftCommand {
                modifierState.leftCommand = false
                modifierState.currentKeys.remove(55)
                outputEvent("keyup", key: "MetaLeft", keyCode: 55, side: "left", modifiers: modifierState.getModifiers())
            } else if cmdPressed {
                modifierState.leftCommand = true
                modifierState.currentKeys.insert(55)
                outputEvent("keydown", key: "MetaLeft", keyCode: 55, side: "left", modifiers: modifierState.getModifiers())
            }
        case 54: // Right Command
            if !cmdPressed && modifierState.rightCommand {
                modifierState.rightCommand = false
                modifierState.currentKeys.remove(54)
                outputEvent("keyup", key: "MetaRight", keyCode: 54, side: "right", modifiers: modifierState.getModifiers())
            } else if cmdPressed {
                modifierState.rightCommand = true
                modifierState.currentKeys.insert(54)
                outputEvent("keydown", key: "MetaRight", keyCode: 54, side: "right", modifiers: modifierState.getModifiers())
            }
        case 58: // Left Option
            if !optPressed && modifierState.leftOption {
                modifierState.leftOption = false
                modifierState.currentKeys.remove(58)
                outputEvent("keyup", key: "AltLeft", keyCode: 58, side: "left", modifiers: modifierState.getModifiers())
            } else if optPressed {
                modifierState.leftOption = true
                modifierState.currentKeys.insert(58)
                outputEvent("keydown", key: "AltLeft", keyCode: 58, side: "left", modifiers: modifierState.getModifiers())
            }
        case 61: // Right Option
            if !optPressed && modifierState.rightOption {
                modifierState.rightOption = false
                modifierState.currentKeys.remove(61)
                outputEvent("keyup", key: "AltRight", keyCode: 61, side: "right", modifiers: modifierState.getModifiers())
            } else if optPressed {
                modifierState.rightOption = true
                modifierState.currentKeys.insert(61)
                outputEvent("keydown", key: "AltRight", keyCode: 61, side: "right", modifiers: modifierState.getModifiers())
            }
        case 59: // Left Control
            if !ctrlPressed && modifierState.leftControl {
                modifierState.leftControl = false
                modifierState.currentKeys.remove(59)
                outputEvent("keyup", key: "ControlLeft", keyCode: 59, side: "left", modifiers: modifierState.getModifiers())
            } else if ctrlPressed {
                modifierState.leftControl = true
                modifierState.currentKeys.insert(59)
                outputEvent("keydown", key: "ControlLeft", keyCode: 59, side: "left", modifiers: modifierState.getModifiers())
            }
        case 62: // Right Control
            if !ctrlPressed && modifierState.rightControl {
                modifierState.rightControl = false
                modifierState.currentKeys.remove(62)
                outputEvent("keyup", key: "ControlRight", keyCode: 62, side: "right", modifiers: modifierState.getModifiers())
            } else if ctrlPressed {
                modifierState.rightControl = true
                modifierState.currentKeys.insert(62)
                outputEvent("keydown", key: "ControlRight", keyCode: 62, side: "right", modifiers: modifierState.getModifiers())
            }
        case 56: // Left Shift
            if !shiftPressed && modifierState.leftShift {
                modifierState.leftShift = false
                modifierState.currentKeys.remove(56)
                outputEvent("keyup", key: "ShiftLeft", keyCode: 56, side: "left", modifiers: modifierState.getModifiers())
            } else if shiftPressed {
                modifierState.leftShift = true
                modifierState.currentKeys.insert(56)
                outputEvent("keydown", key: "ShiftLeft", keyCode: 56, side: "left", modifiers: modifierState.getModifiers())
            }
        case 60: // Right Shift
            if !shiftPressed && modifierState.rightShift {
                modifierState.rightShift = false
                modifierState.currentKeys.remove(60)
                outputEvent("keyup", key: "ShiftRight", keyCode: 60, side: "right", modifiers: modifierState.getModifiers())
            } else if shiftPressed {
                modifierState.rightShift = true
                modifierState.currentKeys.insert(60)
                outputEvent("keydown", key: "ShiftRight", keyCode: 60, side: "right", modifiers: modifierState.getModifiers())
            }
        default:
            break
        }
    }
}

// MARK: - Command Processing

let eventTap = KeyboardEventTap()

func processCommand(_ command: [String: Any]) {
    guard let cmd = command["command"] as? String else { return }

    switch cmd {
    case "start":
        let success = eventTap.start()
        let response: [String: Any] = ["status": success ? "ok" : "error"]
        if let jsonData = try? JSONSerialization.data(withJSONObject: response),
           let jsonString = String(data: jsonData, encoding: .utf8) {
            print(jsonString)
            fflush(stdout)
        }

    case "stop":
        eventTap.stop()
        let response: [String: Any] = ["status": "ok"]
        if let jsonData = try? JSONSerialization.data(withJSONObject: response),
           let jsonString = String(data: jsonData, encoding: .utf8) {
            print(jsonString)
            fflush(stdout)
        }

    case "setShortcut":
        if let shortcut = command["shortcut"] as? String {
            eventTap.setShortcut(shortcut)
            let response: [String: Any] = ["status": "ok"]
            if let jsonData = try? JSONSerialization.data(withJSONObject: response),
               let jsonString = String(data: jsonData, encoding: .utf8) {
                print(jsonString)
                fflush(stdout)
            }
        }

    case "setShortcuts":
        if let shortcutsArray = command["shortcuts"] as? [[String: String]] {
            let shortcuts: [(id: String, shortcut: String)] = shortcutsArray.compactMap { dict in
                guard let id = dict["id"], let shortcut = dict["shortcut"] else { return nil }
                return (id: id, shortcut: shortcut)
            }
            eventTap.setShortcuts(shortcuts)
            let response: [String: Any] = ["status": "ok"]
            if let jsonData = try? JSONSerialization.data(withJSONObject: response),
               let jsonString = String(data: jsonData, encoding: .utf8) {
                print(jsonString)
                fflush(stdout)
            }
        }

    default:
        let response: [String: Any] = ["status": "unknown_command"]
        if let jsonData = try? JSONSerialization.data(withJSONObject: response),
           let jsonString = String(data: jsonData, encoding: .utf8) {
            print(jsonString)
            fflush(stdout)
        }
    }
}

// MARK: - Main Loop

// Set up stdin reading using dispatch source
let stdin = FileHandle.standardInput
let fd = STDIN_FILENO

var inputBuffer = ""

// Create a dispatch source for stdin
let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: DispatchQueue.global(qos: .userInteractive))

source.setEventHandler {
    let data = stdin.availableData
    guard !data.isEmpty else {
        // EOF
        source.cancel()
        return
    }

    if let inputString = String(data: data, encoding: .utf8) {
        inputBuffer += inputString

        // Process complete lines
        while let newlineRange = inputBuffer.range(of: "\n") {
            let line = String(inputBuffer[..<newlineRange.lowerBound])
            inputBuffer = String(inputBuffer[newlineRange.upperBound...])

            guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }

            if let data = line.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                processCommand(json)
            }
        }
    }
}

source.setCancelHandler {
    CFRunLoopStop(CFRunLoopGetMain())
}

source.resume()

// Keep the main run loop running
CFRunLoopRun()
