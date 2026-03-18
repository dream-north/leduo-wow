import Foundation
import CoreFoundation
import CoreGraphics
import AppKit
import WebKit

// MARK: - JSON Output

func outputJSON(_ object: [String: Any]) {
    guard let jsonData = try? JSONSerialization.data(withJSONObject: object),
          let jsonString = String(data: jsonData, encoding: .utf8) else {
        return
    }

    print(jsonString)
    fflush(stdout)
}

func outputStatus(_ status: String) {
    outputJSON(["status": status])
}

func outputOverlayError(_ message: String) {
    outputJSON([
        "type": "overlayError",
        "message": message,
        "timestamp": Int64(Date().timeIntervalSince1970 * 1000)
    ])
}

// MARK: - Key Code Mapping

struct KeyCodeMap {
    static let keyCodeToName: [Int64: String] = [
        54: "MetaRight",
        55: "MetaLeft",
        61: "AltRight",
        58: "AltLeft",
        62: "ControlRight",
        59: "ControlLeft",
        60: "ShiftRight",
        56: "ShiftLeft",
        53: "Escape",
        48: "Tab",
        36: "Return",
        51: "Delete",
        49: "Space",
        126: "ArrowUp",
        125: "ArrowDown",
        123: "ArrowLeft",
        124: "ArrowRight",
        122: "F1",
        120: "F2",
        99: "F3",
        118: "F4",
        96: "F5",
        97: "F6",
        98: "F7",
        100: "F8",
        101: "F9",
        109: "F10",
        103: "F11",
        111: "F12",
        18: "1", 19: "2", 20: "3",
        21: "4", 23: "5", 22: "6",
        26: "7", 28: "9", 25: "0",
        0: "A", 1: "S", 2: "D",
        3: "F", 4: "H", 5: "G",
        6: "Z", 7: "X", 8: "C",
        9: "V", 11: "B", 12: "Q",
        13: "W", 14: "E", 15: "R",
        16: "Y", 17: "T", 31: "O",
        32: "U", 34: "I", 35: "P",
        37: "L", 38: "J", 40: "K",
        45: "N", 46: "M",
        27: "-", 24: "=", 33: "[",
        30: "]", 42: "\\", 39: ";",
        41: "'", 43: ",", 47: ".",
        44: "/", 50: "`",
        114: "Help",
        115: "ForwardDelete",
        116: "Home",
        117: "End",
        119: "PageUp",
        121: "PageDown",
    ]

    static let keyCodeToSide: [Int64: String] = [
        54: "right",
        55: "left",
        61: "right",
        58: "left",
        62: "right",
        59: "left",
        60: "right",
        56: "left",
    ]

    static func keyName(for keyCode: Int64) -> String {
        keyCodeToName[keyCode] ?? "Unknown"
    }

    static func keySide(for keyCode: Int64) -> String {
        keyCodeToSide[keyCode] ?? "unknown"
    }
}

// MARK: - Modifier State

final class ModifierState {
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

// MARK: - Shortcut Parsing

struct ShortcutConfig {
    var side: String = "any"
    var modifiers: [String] = []
    var rawModifiers: [String] = []
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
                config.rawModifiers.append(part)
            } else if part.hasPrefix("Right") {
                config.side = "right"
                let modifier = String(part.dropFirst(5))
                config.modifiers.append(mapModifier(modifier))
                config.rawModifiers.append(part)
            } else if isModifierKey(part) {
                config.modifiers.append(mapModifier(part))
                config.rawModifiers.append(part)
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

    static func baseModifierName(for keyName: String) -> String {
        let suffixes = ["Left", "Right"]
        for suffix in suffixes where keyName.hasSuffix(suffix) {
            let base = String(keyName.dropLast(suffix.count))
            switch base {
            case "Meta": return "Meta"
            case "Alt": return "Alt"
            case "Control": return "Control"
            case "Shift": return "Shift"
            default: return base
            }
        }
        return keyName
    }

    private static func isModifierKey(_ key: String) -> Bool {
        ["Command", "Control", "Alt", "Shift", "Ctrl", "Meta", "Option"].contains(key)
    }

    func matches(keyName: String, pressedModifiers: [String], keySide: String) -> Bool {
        if key == nil && !modifiers.isEmpty {
            let configModifier = modifiers.first ?? ""
            let expectedBase = ShortcutConfig.baseModifierName(for: configModifier)
            let actualBase = ShortcutConfig.baseModifierName(for: keyName)
            if expectedBase != actualBase {
                return false
            }

            for required in modifiers {
                if !pressedModifiers.contains(where: { $0.hasPrefix(required) }) {
                    return false
                }
            }

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

        if let key = key {
            if keyName != key {
                return false
            }

            for required in modifiers {
                if !pressedModifiers.contains(where: { $0.hasPrefix(required) }) {
                    return false
                }
            }

            if side != "any" {
                let sideMod = side == "left" ? "Left" : "Right"
                let hasMatchingSide = pressedModifiers.contains { modifier in
                    guard modifier.hasSuffix(sideMod) else { return false }
                    let baseName = ShortcutConfig.baseModifierName(for: modifier)
                    return modifiers.contains(baseName)
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

// MARK: - Keyboard Events

func outputEvent(_ type: String, key: String, keyCode: Int64, side: String, modifiers: [String]) {
    outputJSON([
        "type": type,
        "key": key,
        "code": key,
        "keyCode": keyCode,
        "side": side,
        "modifiers": modifiers,
        "timestamp": Int64(Date().timeIntervalSince1970 * 1000)
    ])
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
    outputJSON(event)
}

// MARK: - Keyboard Event Tap

final class KeyboardEventTap {
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private let modifierState = ModifierState()
    private var targetShortcuts: [(id: String, config: ShortcutConfig)] = []
    private var isRunning = false

    func start() -> Bool {
        guard !isRunning else { return true }

        let eventMask: CGEventMask =
            (1 << CGEventType.keyDown.rawValue) |
            (1 << CGEventType.keyUp.rawValue) |
            (1 << CGEventType.flagsChanged.rawValue)

        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: eventMask,
            callback: { proxy, type, event, refcon in
                guard let refcon else { return Unmanaged.passRetained(event) }
                let tap = Unmanaged<KeyboardEventTap>.fromOpaque(refcon).takeUnretainedValue()
                return tap.handleEvent(proxy: proxy, type: type, event: event)
            },
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            return false
        }

        eventTap = tap
        runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)

        if let runLoopSource {
            CFRunLoopAddSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        }
        CGEvent.tapEnable(tap: tap, enable: true)
        isRunning = true
        return true
    }

    func stop() {
        guard isRunning else { return }

        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }
        if let runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        }

        eventTap = nil
        runLoopSource = nil
        modifierState.reset()
        isRunning = false
    }

    func setShortcut(_ shortcut: String) {
        if let config = ShortcutConfig.parse(shortcut) {
            targetShortcuts = [("shortcut", config)]
        } else {
            targetShortcuts = []
        }
    }

    func setShortcuts(_ shortcuts: [(id: String, shortcut: String)]) {
        targetShortcuts = shortcuts.compactMap { item in
            guard let config = ShortcutConfig.parse(item.shortcut) else { return nil }
            return (id: item.id, config: config)
        }
    }

    private func handleEvent(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let eventTap {
                CGEvent.tapEnable(tap: eventTap, enable: true)
            }
            return Unmanaged.passRetained(event)
        }

        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        let flags = event.flags

        updateModifierState(keyCode: keyCode, eventType: type)

        let keyName = KeyCodeMap.keyName(for: keyCode)
        let keySide = KeyCodeMap.keySide(for: keyCode)
        let modifiers = modifierState.getModifiers()

        switch type {
        case .keyDown:
            modifierState.currentKeys.insert(keyCode)
            for (id, config) in targetShortcuts {
                if config.matches(keyName: keyName, pressedModifiers: modifiers, keySide: keySide) {
                    let shortcutString = config.key != nil
                        ? "\(config.rawModifiers.joined(separator: "+"))+\(config.key!)"
                        : (config.rawModifiers.first ?? "")
                    outputShortcutEvent(shortcutString, id: id)
                    break
                }
            }
            outputEvent("keydown", key: keyName, keyCode: keyCode, side: keySide, modifiers: modifiers)

        case .keyUp:
            modifierState.currentKeys.remove(keyCode)
            outputEvent("keyup", key: keyName, keyCode: keyCode, side: keySide, modifiers: modifiers)

        case .flagsChanged:
            handleFlagsChanged(keyCode: keyCode, flags: flags)
            let currentModifiers = modifierState.getModifiers()
            for (id, config) in targetShortcuts where config.key == nil {
                if config.matches(keyName: keyName, pressedModifiers: currentModifiers, keySide: keySide) {
                    let shortcutString = config.rawModifiers.first ?? ""
                    outputShortcutEvent(shortcutString, id: id)
                    break
                }
            }

        default:
            break
        }

        return Unmanaged.passRetained(event)
    }

    private func updateModifierState(keyCode: Int64, eventType: CGEventType) {
        let isKeyDown = eventType == .keyDown

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

        switch keyCode {
        case 55:
            handleModifierToggle(isPressed: cmdPressed, wasPressed: modifierState.leftCommand, keyCode: 55, key: "MetaLeft", side: "left") {
                modifierState.leftCommand = $0
            }
        case 54:
            handleModifierToggle(isPressed: cmdPressed, wasPressed: modifierState.rightCommand, keyCode: 54, key: "MetaRight", side: "right") {
                modifierState.rightCommand = $0
            }
        case 58:
            handleModifierToggle(isPressed: optPressed, wasPressed: modifierState.leftOption, keyCode: 58, key: "AltLeft", side: "left") {
                modifierState.leftOption = $0
            }
        case 61:
            handleModifierToggle(isPressed: optPressed, wasPressed: modifierState.rightOption, keyCode: 61, key: "AltRight", side: "right") {
                modifierState.rightOption = $0
            }
        case 59:
            handleModifierToggle(isPressed: ctrlPressed, wasPressed: modifierState.leftControl, keyCode: 59, key: "ControlLeft", side: "left") {
                modifierState.leftControl = $0
            }
        case 62:
            handleModifierToggle(isPressed: ctrlPressed, wasPressed: modifierState.rightControl, keyCode: 62, key: "ControlRight", side: "right") {
                modifierState.rightControl = $0
            }
        case 56:
            handleModifierToggle(isPressed: shiftPressed, wasPressed: modifierState.leftShift, keyCode: 56, key: "ShiftLeft", side: "left") {
                modifierState.leftShift = $0
            }
        case 60:
            handleModifierToggle(isPressed: shiftPressed, wasPressed: modifierState.rightShift, keyCode: 60, key: "ShiftRight", side: "right") {
                modifierState.rightShift = $0
            }
        default:
            break
        }
    }

    private func handleModifierToggle(
        isPressed: Bool,
        wasPressed: Bool,
        keyCode: Int64,
        key: String,
        side: String,
        update: (Bool) -> Void
    ) {
        if !isPressed && wasPressed {
            update(false)
            modifierState.currentKeys.remove(keyCode)
            outputEvent("keyup", key: key, keyCode: keyCode, side: side, modifiers: modifierState.getModifiers())
        } else if isPressed {
            update(true)
            modifierState.currentKeys.insert(keyCode)
            outputEvent("keydown", key: key, keyCode: keyCode, side: side, modifiers: modifierState.getModifiers())
        }
    }
}

// MARK: - Overlay Theme

enum OverlayVisualMode: String {
    case recording
    case processing
    case success
    case error
}

enum OverlayVoiceMode: String {
    case transcription
    case assistant
}

struct OverlayTheme {
    static let transcriptionAccent = NSColor(calibratedRed: 0.01, green: 0.52, blue: 0.78, alpha: 1)
    static let assistantAccent = NSColor(calibratedRed: 0.05, green: 0.63, blue: 0.49, alpha: 1)
    static let success = NSColor(calibratedRed: 0.09, green: 0.64, blue: 0.34, alpha: 1)
    static let danger = NSColor(calibratedRed: 0.86, green: 0.18, blue: 0.17, alpha: 1)
    static let ink = NSColor(calibratedRed: 0.03, green: 0.06, blue: 0.13, alpha: 1)
    static let muted = NSColor(calibratedRed: 0.39, green: 0.45, blue: 0.55, alpha: 1)
    static let cardBorder = NSColor(calibratedRed: 0.84, green: 0.89, blue: 0.96, alpha: 0.88)
    static let hudFill = NSColor(calibratedRed: 0.97, green: 0.98, blue: 1.0, alpha: 0.84)
    static let resultFill = NSColor(calibratedRed: 0.98, green: 0.99, blue: 1.0, alpha: 1.0)
}

func activeScreen() -> NSScreen? {
    let mouseLocation = NSEvent.mouseLocation
    return NSScreen.screens.first(where: { NSMouseInRect(mouseLocation, $0.frame, false) }) ?? NSScreen.main ?? NSScreen.screens.first
}

final class OverlayPanel: NSPanel {
    private let focusablePanel: Bool

    init(focusable: Bool) {
        self.focusablePanel = focusable
        let styleMask: NSWindow.StyleMask = focusable
            ? [.borderless, .fullSizeContentView, .resizable]
            : [.borderless, .nonactivatingPanel]
        super.init(contentRect: .zero, styleMask: styleMask, backing: .buffered, defer: false)
    }

    override var canBecomeKey: Bool {
        focusablePanel
    }

    override var canBecomeMain: Bool {
        focusablePanel
    }
}

final class DraggableTitleBarView: NSView {
    private var initialLocation: NSPoint = .zero
    private var initialOrigin: NSPoint = .zero

    override var mouseDownCanMoveWindow: Bool {
        false
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }

    override func mouseDown(with event: NSEvent) {
        guard let window = window else { return }
        initialLocation = NSEvent.mouseLocation
        initialOrigin = window.frame.origin
    }

    override func mouseDragged(with event: NSEvent) {
        guard let window = window else { return }
        let currentLocation = NSEvent.mouseLocation
        let deltaX = currentLocation.x - initialLocation.x
        let deltaY = currentLocation.y - initialLocation.y
        window.setFrameOrigin(NSPoint(x: initialOrigin.x + deltaX, y: initialOrigin.y + deltaY))
    }
}

final class PanelActionButton: NSButton {
    enum VisualStyle {
        case filled
        case outline
    }

    var visualStyle: VisualStyle = .filled {
        didSet {
            applyAppearance(animated: false)
        }
    }

    private var hoverTrackingArea: NSTrackingArea?
    private var isHovered = false

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverTrackingArea {
            removeTrackingArea(hoverTrackingArea)
        }

        let trackingArea = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(trackingArea)
        hoverTrackingArea = trackingArea
    }

    override func mouseEntered(with event: NSEvent) {
        super.mouseEntered(with: event)
        NSCursor.pointingHand.push()
        setHovered(true)
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        NSCursor.pop()
        setHovered(false)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        applyAppearance(animated: false)
    }

    private func setHovered(_ hovered: Bool) {
        guard isHovered != hovered else { return }
        isHovered = hovered
        applyAppearance(animated: true)
    }

    private func applyAppearance(animated: Bool) {
        guard let layer else { return }

        let backgroundColor: NSColor
        let borderColor: NSColor
        let textColor: NSColor
        let scale: CGFloat

        switch visualStyle {
        case .filled:
            backgroundColor = isHovered
                ? OverlayTheme.assistantAccent.blended(withFraction: 0.14, of: .black) ?? OverlayTheme.assistantAccent
                : OverlayTheme.assistantAccent
            borderColor = .clear
            textColor = .white
            scale = isHovered ? 1.03 : 1.0
        case .outline:
            backgroundColor = isHovered
                ? OverlayTheme.assistantAccent.withAlphaComponent(0.12)
                : NSColor(calibratedWhite: 1, alpha: 0.84)
            borderColor = isHovered
                ? OverlayTheme.assistantAccent.withAlphaComponent(0.34)
                : NSColor(calibratedWhite: 0.72, alpha: 0.35)
            textColor = isHovered ? OverlayTheme.assistantAccent : OverlayTheme.ink
            scale = isHovered ? 1.02 : 1.0
        }

        let updates = {
            layer.backgroundColor = backgroundColor.cgColor
            layer.borderColor = borderColor.cgColor
            layer.transform = CATransform3DMakeScale(scale, scale, 1)
            self.contentTintColor = textColor
        }

        if animated {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.16
                context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                self.animator().alphaValue = 1
                updates()
            }
        } else {
            updates()
        }
    }
}

final class ResultStatBadgeView: NSView {
    private let iconView = NSImageView()
    private let valueLabel = NSTextField(labelWithString: "")
    private var hoverTrackingArea: NSTrackingArea?
    private let detail: String
    var onHoverChange: ((Bool, String, NSRect) -> Void)?

    init(symbolName: String, value: String, detail: String) {
        self.detail = detail
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 12
        layer?.cornerCurve = .continuous
        layer?.backgroundColor = NSColor(calibratedWhite: 0.96, alpha: 0.9).cgColor

        iconView.image = symbolImage(symbolName, pointSize: 11, weight: .semibold)
        iconView.contentTintColor = OverlayTheme.assistantAccent
        iconView.translatesAutoresizingMaskIntoConstraints = false

        valueLabel.stringValue = value
        valueLabel.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        valueLabel.textColor = OverlayTheme.ink
        valueLabel.translatesAutoresizingMaskIntoConstraints = false

        addSubview(iconView)
        addSubview(valueLabel)

        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 24),
            iconView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 9),
            iconView.centerYAnchor.constraint(equalTo: centerYAnchor),
            iconView.widthAnchor.constraint(equalToConstant: 12),
            iconView.heightAnchor.constraint(equalToConstant: 12),
            valueLabel.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: 5),
            valueLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            valueLabel.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverTrackingArea {
            removeTrackingArea(hoverTrackingArea)
        }

        let trackingArea = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(trackingArea)
        hoverTrackingArea = trackingArea
    }

    override func mouseEntered(with event: NSEvent) {
        super.mouseEntered(with: event)
        layer?.backgroundColor = OverlayTheme.assistantAccent.withAlphaComponent(0.14).cgColor
        onHoverChange?(true, detail, bounds)
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        layer?.backgroundColor = NSColor(calibratedWhite: 0.96, alpha: 0.9).cgColor
        onHoverChange?(false, detail, bounds)
    }
}

func makePanel(level: NSWindow.Level, focusable: Bool) -> NSPanel {
    let panel = OverlayPanel(focusable: focusable)
    panel.level = level
    panel.isFloatingPanel = true
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.titleVisibility = .hidden
    panel.titlebarAppearsTransparent = true
    return panel
}

func symbolImage(_ name: String, pointSize: CGFloat, weight: NSFont.Weight = .semibold) -> NSImage? {
    let configuration = NSImage.SymbolConfiguration(pointSize: pointSize, weight: weight)
    return NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(configuration)
}

// MARK: - Recording HUD

final class RecordingHUDPanelController {
    private let panel: NSPanel
    private let rootView = NSView()
    private let cardView = NSVisualEffectView()
    private let glowView = NSView()
    private let iconView = NSImageView()
    private let captionLabel = NSTextField(labelWithString: "语音识别")
    private let textLabel = NSTextField(labelWithString: "正在聆听...")
    private let badgeLabel = NSTextField(labelWithString: "")

    private let minWidth: CGFloat = 312
    private let maxWidth: CGFloat = 520
    private let height: CGFloat = 102
    private let outerInset: CGFloat = 10
    private var currentWidth: CGFloat = 312

    init() {
        panel = makePanel(level: .screenSaver, focusable: false)
        panel.ignoresMouseEvents = true
        panel.hasShadow = true
        panel.contentView = rootView
        configureViews()
        panel.orderOut(nil)
    }

    private func configureViews() {
        rootView.wantsLayer = true
        rootView.layer?.backgroundColor = NSColor.clear.cgColor

        cardView.material = .popover
        cardView.blendingMode = .withinWindow
        cardView.state = .active
        cardView.wantsLayer = true
        cardView.layer?.cornerRadius = 20
        cardView.layer?.masksToBounds = true
        cardView.layer?.borderWidth = 1
        cardView.layer?.borderColor = OverlayTheme.cardBorder.cgColor
        cardView.layer?.backgroundColor = OverlayTheme.hudFill.cgColor
        cardView.layer?.cornerCurve = .continuous

        glowView.wantsLayer = true
        glowView.layer?.cornerRadius = 18
        glowView.layer?.cornerCurve = .continuous
        glowView.layer?.opacity = 0.12

        iconView.contentTintColor = OverlayTheme.transcriptionAccent

        captionLabel.font = NSFont.systemFont(ofSize: 11, weight: .bold)
        captionLabel.textColor = OverlayTheme.transcriptionAccent

        textLabel.font = NSFont.systemFont(ofSize: 16, weight: .bold)
        textLabel.textColor = OverlayTheme.ink
        textLabel.maximumNumberOfLines = 2
        textLabel.lineBreakMode = .byTruncatingTail

        badgeLabel.font = NSFont.systemFont(ofSize: 11, weight: .bold)
        badgeLabel.textColor = OverlayTheme.transcriptionAccent
        badgeLabel.alignment = .right

        for view in [cardView, glowView, iconView, captionLabel, textLabel, badgeLabel] {
            view.translatesAutoresizingMaskIntoConstraints = false
        }

        rootView.addSubview(cardView)
        cardView.addSubview(glowView)
        cardView.addSubview(iconView)
        cardView.addSubview(captionLabel)
        cardView.addSubview(textLabel)
        cardView.addSubview(badgeLabel)

        NSLayoutConstraint.activate([
            cardView.leadingAnchor.constraint(equalTo: rootView.leadingAnchor, constant: outerInset),
            cardView.trailingAnchor.constraint(equalTo: rootView.trailingAnchor, constant: -outerInset),
            cardView.topAnchor.constraint(equalTo: rootView.topAnchor, constant: outerInset),
            cardView.bottomAnchor.constraint(equalTo: rootView.bottomAnchor, constant: -outerInset),

            glowView.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 16),
            glowView.centerYAnchor.constraint(equalTo: cardView.centerYAnchor),
            glowView.widthAnchor.constraint(equalToConstant: 60),
            glowView.heightAnchor.constraint(equalToConstant: 60),

            iconView.centerXAnchor.constraint(equalTo: glowView.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: glowView.centerYAnchor),
            iconView.widthAnchor.constraint(equalToConstant: 28),
            iconView.heightAnchor.constraint(equalToConstant: 28),

            captionLabel.leadingAnchor.constraint(equalTo: glowView.trailingAnchor, constant: 16),
            captionLabel.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 17),

            textLabel.leadingAnchor.constraint(equalTo: captionLabel.leadingAnchor),
            textLabel.topAnchor.constraint(equalTo: captionLabel.bottomAnchor, constant: 5),
            textLabel.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -20),

            badgeLabel.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -20),
            badgeLabel.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 17),
            badgeLabel.leadingAnchor.constraint(greaterThanOrEqualTo: captionLabel.trailingAnchor, constant: 12)
        ])
    }

    func show(text: String, mode: OverlayVisualMode, voiceMode: OverlayVoiceMode, screenshotActive: Bool) {
        update(text: text, mode: mode, voiceMode: voiceMode, screenshotActive: screenshotActive)
        positionOnActiveScreen()
        panel.orderFrontRegardless()
    }

    func update(text: String, mode: OverlayVisualMode, voiceMode: OverlayVoiceMode, screenshotActive: Bool) {
        captionLabel.stringValue = voiceMode == .assistant ? "语音助手" : "语音识别"
        textLabel.stringValue = text
        badgeLabel.stringValue = screenshotActive ? "截图上下文已启用" : ""
        updatePanelSize(for: text)
        iconView.image = symbolImage(
            voiceMode == .assistant ? "sparkles" : "waveform.circle.fill",
            pointSize: 24
        )

        let accent: NSColor
        switch mode {
        case .recording:
            accent = baseAccent(for: voiceMode)
            applyPulse()
        case .processing:
            accent = baseAccent(for: voiceMode).withAlphaComponent(0.88)
            applyPulse(duration: 1.1)
        case .success:
            accent = OverlayTheme.success
            clearAnimations()
        case .error:
            accent = OverlayTheme.danger
            clearAnimations()
        }

        glowView.layer?.backgroundColor = accent.cgColor
        iconView.contentTintColor = accent
        captionLabel.textColor = accent
        badgeLabel.textColor = accent
        textLabel.textColor = OverlayTheme.ink
    }

    func hide() {
        clearAnimations()
        panel.orderOut(nil)
    }

    private func positionOnActiveScreen() {
        guard let screen = activeScreen() else { return }
        let frame = screen.visibleFrame
        let origin = NSPoint(
            x: round(frame.midX - currentWidth / 2),
            y: frame.minY + 64
        )
        panel.setFrame(NSRect(origin: origin, size: NSSize(width: currentWidth, height: height)), display: true)
    }

    private func updatePanelSize(for text: String) {
        let displayText = text.isEmpty ? "正在聆听..." : text
        let measured = NSString(string: displayText).size(withAttributes: [
            .font: textLabel.font ?? NSFont.systemFont(ofSize: 17, weight: .semibold)
        ]).width
        currentWidth = min(max(minWidth, ceil(measured) + 150), maxWidth)
    }

    private func baseAccent(for voiceMode: OverlayVoiceMode) -> NSColor {
        voiceMode == .assistant ? OverlayTheme.assistantAccent : OverlayTheme.transcriptionAccent
    }

    private func applyPulse(duration: CFTimeInterval = 0.85) {
        clearAnimations()
        let animation = CABasicAnimation(keyPath: "opacity")
        animation.fromValue = 0.12
        animation.toValue = 0.26
        animation.duration = duration
        animation.autoreverses = true
        animation.repeatCount = .infinity
        glowView.layer?.add(animation, forKey: "pulse")
    }

    private func clearAnimations() {
        glowView.layer?.removeAnimation(forKey: "pulse")
    }
}

// MARK: - Result Window

final class AssistantResultPanelController: NSObject, WKNavigationDelegate {
    private let panel: NSPanel
    private let rootView = NSView()
    private let surfaceView = NSView()
    private let titleBar = DraggableTitleBarView()
    private let metaStatsStackView = NSStackView()
    private let statDetailView = NSVisualEffectView()
    private let statDetailLabel = NSTextField(wrappingLabelWithString: "")
    private let eyebrowLabel = NSTextField(labelWithString: "语音助手")
    private let titleLabel = NSTextField(labelWithString: "回答结果")
    private let copyButton = PanelActionButton(title: "复制", target: nil, action: nil)
    private let closeButton = PanelActionButton(title: "关闭", target: nil, action: nil)
    private let webView: WKWebView
    private let defaultWidth: CGFloat = 620
    private let defaultHeight: CGFloat = 468
    private let minWidth: CGFloat = 520
    private let minHeight: CGFloat = 360
    private let outerInset: CGFloat = 8
    private var currentMarkdown = ""
    private var currentDisplayMarkdown = ""
    private var currentSources: [[String: Any]] = []
    private var currentReasoningMarkdown = ""
    private var currentReasoningCollapsed = false
    private var currentCodeMarkdown = ""
    private var currentCodeCollapsed = true
    private var metaStatsHeightConstraint: NSLayoutConstraint?
    private var statDetailHeightConstraint: NSLayoutConstraint?
    private var copyResetWorkItem: DispatchWorkItem?
    private var keyMonitor: Any?
    private var isInitialPageLoaded = false
    private var pendingUpdateWorkItem: DispatchWorkItem?
    private var streamingGeneration: UInt64 = 0

    override init() {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(false, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: .zero, configuration: config)
        panel = makePanel(level: .screenSaver, focusable: true)
        super.init()
        panel.contentView = rootView
        panel.minSize = NSSize(width: minWidth, height: minHeight)
        configureViews()
        installKeyMonitor()
        panel.orderOut(nil)
    }

    deinit {
        if let keyMonitor {
            NSEvent.removeMonitor(keyMonitor)
        }
    }

    private func configureViews() {
        panel.ignoresMouseEvents = false
        panel.isMovable = true
        panel.isMovableByWindowBackground = false
        panel.hasShadow = false
        rootView.wantsLayer = true
        rootView.layer?.backgroundColor = NSColor.clear.cgColor

        surfaceView.wantsLayer = true
        surfaceView.layer?.cornerRadius = 22
        surfaceView.layer?.masksToBounds = true
        surfaceView.layer?.backgroundColor = OverlayTheme.resultFill.cgColor
        surfaceView.layer?.borderWidth = 1
        surfaceView.layer?.borderColor = OverlayTheme.cardBorder.cgColor
        surfaceView.layer?.cornerCurve = .continuous

        eyebrowLabel.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        eyebrowLabel.textColor = OverlayTheme.assistantAccent
        eyebrowLabel.alignment = .left

        titleLabel.font = NSFont.systemFont(ofSize: 22, weight: .bold)
        titleLabel.textColor = OverlayTheme.ink

        metaStatsStackView.orientation = .horizontal
        metaStatsStackView.alignment = .centerY
        metaStatsStackView.spacing = 8
        metaStatsStackView.edgeInsets = NSEdgeInsets(top: 0, left: 22, bottom: 0, right: 22)
        metaStatsStackView.translatesAutoresizingMaskIntoConstraints = false

        statDetailView.material = .hudWindow
        statDetailView.blendingMode = .withinWindow
        statDetailView.state = .active
        statDetailView.wantsLayer = true
        statDetailView.isHidden = true
        statDetailView.layer?.cornerRadius = 14
        statDetailView.layer?.cornerCurve = .continuous
        statDetailView.layer?.borderWidth = 1
        statDetailView.layer?.borderColor = OverlayTheme.cardBorder.cgColor
        statDetailView.translatesAutoresizingMaskIntoConstraints = false

        statDetailLabel.font = NSFont.systemFont(ofSize: 12, weight: .regular)
        statDetailLabel.textColor = OverlayTheme.ink
        statDetailLabel.maximumNumberOfLines = 6
        statDetailLabel.lineBreakMode = .byTruncatingTail
        statDetailLabel.translatesAutoresizingMaskIntoConstraints = false

        styleButton(copyButton, filled: true)
        styleButton(closeButton, filled: false)
        copyButton.target = self
        closeButton.target = self
        copyButton.action = #selector(handleCopy)
        closeButton.action = #selector(handleClose)

        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsBackForwardNavigationGestures = false
        webView.translatesAutoresizingMaskIntoConstraints = false

        for view in [surfaceView, titleBar, metaStatsStackView, statDetailView, statDetailLabel, eyebrowLabel, titleLabel, copyButton, closeButton, webView] {
            view.translatesAutoresizingMaskIntoConstraints = false
        }

        rootView.addSubview(surfaceView)
        surfaceView.addSubview(titleBar)
        surfaceView.addSubview(metaStatsStackView)
        surfaceView.addSubview(statDetailView)
        statDetailView.addSubview(statDetailLabel)
        titleBar.addSubview(eyebrowLabel)
        titleBar.addSubview(titleLabel)
        titleBar.addSubview(copyButton)
        titleBar.addSubview(closeButton)
        surfaceView.addSubview(webView)

        metaStatsHeightConstraint = metaStatsStackView.heightAnchor.constraint(equalToConstant: 0)
        metaStatsHeightConstraint?.isActive = true
        statDetailHeightConstraint = statDetailView.heightAnchor.constraint(equalToConstant: 0)
        statDetailHeightConstraint?.isActive = true

        NSLayoutConstraint.activate([
            surfaceView.leadingAnchor.constraint(equalTo: rootView.leadingAnchor, constant: outerInset),
            surfaceView.trailingAnchor.constraint(equalTo: rootView.trailingAnchor, constant: -outerInset),
            surfaceView.topAnchor.constraint(equalTo: rootView.topAnchor, constant: outerInset),
            surfaceView.bottomAnchor.constraint(equalTo: rootView.bottomAnchor, constant: -outerInset),

            titleBar.leadingAnchor.constraint(equalTo: surfaceView.leadingAnchor),
            titleBar.trailingAnchor.constraint(equalTo: surfaceView.trailingAnchor),
            titleBar.topAnchor.constraint(equalTo: surfaceView.topAnchor),
            titleBar.heightAnchor.constraint(equalToConstant: 88),

            metaStatsStackView.leadingAnchor.constraint(equalTo: surfaceView.leadingAnchor),
            metaStatsStackView.trailingAnchor.constraint(lessThanOrEqualTo: surfaceView.trailingAnchor, constant: -18),
            metaStatsStackView.topAnchor.constraint(equalTo: titleBar.bottomAnchor, constant: 2),

            statDetailView.leadingAnchor.constraint(equalTo: surfaceView.leadingAnchor, constant: 22),
            statDetailView.trailingAnchor.constraint(lessThanOrEqualTo: surfaceView.trailingAnchor, constant: -22),
            statDetailView.topAnchor.constraint(equalTo: metaStatsStackView.bottomAnchor, constant: 6),

            statDetailLabel.leadingAnchor.constraint(equalTo: statDetailView.leadingAnchor, constant: 12),
            statDetailLabel.trailingAnchor.constraint(equalTo: statDetailView.trailingAnchor, constant: -12),
            statDetailLabel.topAnchor.constraint(equalTo: statDetailView.topAnchor, constant: 10),
            statDetailLabel.bottomAnchor.constraint(equalTo: statDetailView.bottomAnchor, constant: -10),

            eyebrowLabel.leadingAnchor.constraint(equalTo: titleBar.leadingAnchor, constant: 22),
            eyebrowLabel.topAnchor.constraint(equalTo: titleBar.topAnchor, constant: 18),

            titleLabel.leadingAnchor.constraint(equalTo: eyebrowLabel.leadingAnchor),
            titleLabel.topAnchor.constraint(equalTo: eyebrowLabel.bottomAnchor, constant: 4),

            closeButton.trailingAnchor.constraint(equalTo: titleBar.trailingAnchor, constant: -22),
            closeButton.centerYAnchor.constraint(equalTo: titleBar.centerYAnchor, constant: 2),
            closeButton.widthAnchor.constraint(equalToConstant: 90),
            closeButton.heightAnchor.constraint(equalToConstant: 42),

            copyButton.trailingAnchor.constraint(equalTo: closeButton.leadingAnchor, constant: -12),
            copyButton.centerYAnchor.constraint(equalTo: closeButton.centerYAnchor),
            copyButton.widthAnchor.constraint(equalToConstant: 104),
            copyButton.heightAnchor.constraint(equalToConstant: 42),

            webView.leadingAnchor.constraint(equalTo: surfaceView.leadingAnchor, constant: 18),
            webView.trailingAnchor.constraint(equalTo: surfaceView.trailingAnchor, constant: -18),
            webView.topAnchor.constraint(equalTo: statDetailView.bottomAnchor, constant: 8),
            webView.bottomAnchor.constraint(equalTo: surfaceView.bottomAnchor, constant: -18)
        ])
    }

    private func styleButton(_ button: NSButton, filled: Bool) {
        button.isBordered = false
        button.wantsLayer = true
        button.layer?.cornerRadius = 21
        button.layer?.cornerCurve = .continuous
        button.layer?.borderWidth = filled ? 0 : 1
        button.font = NSFont.systemFont(ofSize: 15, weight: .semibold)
        if let actionButton = button as? PanelActionButton {
            actionButton.visualStyle = filled ? .filled : .outline
        }
    }

    func show(
        markdown: String,
        position: [String: Any]? = nil,
        size: [String: Any]? = nil,
        detailsMarkdown: String? = nil,
        stats: [[String: String]] = [],
        sources: [[String: Any]] = [],
        reasoningMarkdown: String? = nil,
        reasoningCollapsed: Bool = false,
        codeMarkdown: String? = nil,
        codeCollapsed: Bool = true
    ) {
        currentMarkdown = markdown
        currentSources = sources
        currentReasoningMarkdown = reasoningMarkdown ?? ""
        currentReasoningCollapsed = reasoningCollapsed
        currentCodeMarkdown = codeMarkdown ?? ""
        currentCodeCollapsed = codeCollapsed
        currentDisplayMarkdown = [markdown, detailsMarkdown]
            .compactMap { value in
                guard let value, !value.isEmpty else { return nil }
                return value
            }
            .joined(separator: "\n\n")
        let wasVisible = panel.isVisible
        copyResetWorkItem?.cancel()
        copyButton.title = "复制"
        updateStats(stats)

        if isInitialPageLoaded {
            scheduleIncrementalUpdate()
        } else {
            loadMarkdown(currentDisplayMarkdown)
        }

        if !wasVisible {
            applyPanelSize(savedSize: size)
            positionPanel(savedPosition: position)
            panel.orderFrontRegardless()
        }
    }

    func hide() {
        pendingUpdateWorkItem?.cancel()
        pendingUpdateWorkItem = nil
        streamingGeneration &+= 1
        isInitialPageLoaded = false
        copyResetWorkItem?.cancel()
        panel.orderOut(nil)
    }

    private func positionOnActiveScreen() {
        guard let screen = activeScreen() else { return }
        let frame = screen.visibleFrame
        let origin = NSPoint(
            x: round(frame.midX - panel.frame.width / 2),
            y: round(frame.midY - panel.frame.height / 2)
        )
        panel.setFrame(NSRect(origin: origin, size: panel.frame.size), display: true)
    }

    private func applyPanelSize(savedSize: [String: Any]?) {
        let width = max(minWidth, CGFloat(savedSize?["width"] as? Double ?? Double(defaultWidth)))
        let height = max(minHeight, CGFloat(savedSize?["height"] as? Double ?? Double(defaultHeight)))
        panel.setContentSize(NSSize(width: width, height: height))
    }

    private func positionPanel(savedPosition: [String: Any]?) {
        if let savedPosition,
           let x = savedPosition["x"] as? Double,
           let y = savedPosition["y"] as? Double {
            let frame = NSRect(x: x, y: y, width: panel.frame.width, height: panel.frame.height)
            let isVisibleOnAnyScreen = NSScreen.screens.contains { screen in
                screen.visibleFrame.intersects(frame)
            }
            if isVisibleOnAnyScreen {
                panel.setFrame(frame, display: true)
                return
            }
        }

        positionOnActiveScreen()
    }

    private func loadMarkdown(_ markdown: String) {
        let html = MarkdownTemplateRenderer.render(
            markdown,
            sources: currentSources,
            reasoningMarkdown: currentReasoningMarkdown,
            reasoningCollapsed: currentReasoningCollapsed,
            codeMarkdown: currentCodeMarkdown,
            codeCollapsed: currentCodeCollapsed
        )
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func scheduleIncrementalUpdate() {
        pendingUpdateWorkItem?.cancel()
        let generation = streamingGeneration
        let workItem = DispatchWorkItem { [weak self] in
            guard let self, self.streamingGeneration == generation else { return }
            let bodyHTML = MarkdownTemplateRenderer.renderBody(
                self.currentDisplayMarkdown,
                sources: self.currentSources,
                reasoningMarkdown: self.currentReasoningMarkdown,
                reasoningCollapsed: self.currentReasoningCollapsed,
                codeMarkdown: self.currentCodeMarkdown,
                codeCollapsed: self.currentCodeCollapsed
            )
            let escaped = MarkdownTemplateRenderer.escapeForJSString(bodyHTML)
            self.webView.evaluateJavaScript("document.body.innerHTML='\(escaped)'")
        }
        pendingUpdateWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: workItem)
    }

    private func updateStats(_ stats: [[String: String]]) {
        metaStatsStackView.arrangedSubviews.forEach { view in
            metaStatsStackView.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        showStatDetail(nil)

        guard !stats.isEmpty else {
            metaStatsHeightConstraint?.constant = 0
            return
        }

        for stat in stats {
            guard let kind = stat["kind"],
                  let value = stat["value"],
                  let detail = stat["detail"] else { continue }
            let badge = ResultStatBadgeView(
                symbolName: symbolName(for: kind),
                value: value,
                detail: detail
            )
            badge.onHoverChange = { [weak self] isHovering, detailText, _ in
                guard let self else { return }
                self.showStatDetail(isHovering ? detailText : nil)
            }
            metaStatsStackView.addArrangedSubview(badge)
        }

        metaStatsHeightConstraint?.constant = metaStatsStackView.arrangedSubviews.isEmpty ? 0 : 24
    }

    private func symbolName(for kind: String) -> String {
        switch kind {
        case "tokens-total":
            return "circle.hexagongrid.fill"
        case "tokens-thinking":
            return "brain.head.profile"
        case "code-interpreter":
            return "terminal"
        case "web-search":
            return "globe"
        case "web-extractor":
            return "doc.text.magnifyingglass"
        default:
            return "info.circle"
        }
    }

    private func showStatDetail(_ detail: String?) {
        guard let detail, !detail.isEmpty else {
            statDetailLabel.stringValue = ""
            statDetailHeightConstraint?.constant = 0
            statDetailView.isHidden = true
            return
        }

        statDetailLabel.stringValue = detail
        statDetailView.isHidden = false
        let measured = NSString(string: detail).boundingRect(
            with: NSSize(width: 340, height: CGFloat.greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: statDetailLabel.font ?? NSFont.systemFont(ofSize: 12)],
            context: nil
        )
        statDetailHeightConstraint?.constant = min(max(ceil(measured.height) + 20, 38), 140)
    }

    @objc private func handleCopy() {
        copyCurrentSelectionOrMarkdown()
    }

    @objc private func handleClose() {
        let origin = panel.frame.origin
        outputJSON([
            "type": "overlayResultClosed",
            "position": [
                "x": origin.x,
                "y": origin.y
            ],
            "size": [
                "width": panel.frame.width,
                "height": panel.frame.height
            ]
        ])
        hide()
    }

    private func copyCurrentSelectionOrMarkdown() {
        webView.evaluateJavaScript("window.getSelection().toString()") { [weak self] result, _ in
            let selectedText = (result as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let textToCopy = selectedText.isEmpty ? self?.currentMarkdown ?? "" : selectedText
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(textToCopy, forType: .string)
            self?.flashCopyFeedback()
        }
    }

    private func flashCopyFeedback() {
        copyButton.title = "已复制"
        copyResetWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.copyButton.title = "复制"
        }
        copyResetWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.3, execute: workItem)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isInitialPageLoaded = true
        panel.makeFirstResponder(webView)
        webView.evaluateJavaScript("""
          document.body.tabIndex = 0;
          document.body.focus();
        """)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }

        if let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }

        decisionHandler(.allow)
    }

    private func installKeyMonitor() {
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self,
                  self.panel.isVisible,
                  event.modifierFlags.contains(.command),
                  event.charactersIgnoringModifiers?.lowercased() == "c" else {
                return event
            }

            self.copyCurrentSelectionOrMarkdown()
            return nil
        }
    }
}

// MARK: - Markdown Rendering

enum MarkdownTemplateRenderer {
    // Pre-compiled regex patterns to avoid expensive ICU compilation on every call
    private static let orderedListRegex = try! NSRegularExpression(pattern: #"^\d+\.\s+(.+)$"#)
    private static let citationRefRegex = try! NSRegularExpression(pattern: #"\[ref_(\d+)\]"#)
    private static let inlineCodeRegex = try! NSRegularExpression(pattern: #"`([^`]+)`"#)
    private static let linkRegex = try! NSRegularExpression(pattern: #"\[([^\]]+)\]\(([^)]+)\)"#)
    private static let boldRegex = try! NSRegularExpression(pattern: #"\*\*([^*]+)\*\*"#)
    private static let italicRegex = try! NSRegularExpression(pattern: #"\*([^*]+)\*"#)

    static func render(
        _ markdown: String,
        sources: [[String: Any]] = [],
        reasoningMarkdown: String = "",
        reasoningCollapsed: Bool = false,
        codeMarkdown: String = "",
        codeCollapsed: Bool = true
    ) -> String {
        let body = renderBody(
            markdown,
            sources: sources,
            reasoningMarkdown: reasoningMarkdown,
            reasoningCollapsed: reasoningCollapsed,
            codeMarkdown: codeMarkdown,
            codeCollapsed: codeCollapsed
        )
        return """
        <!doctype html>
        <html lang="zh-CN">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            :root {
              color-scheme: light;
              --ink: #0f172a;
              --muted: #64748b;
              --accent: #0284c7;
              --quote-bg: rgba(186, 230, 253, 0.28);
              --code-bg: #0f172a;
              --inline-code-bg: rgba(148, 163, 184, 0.18);
              --rule: rgba(148, 163, 184, 0.35);
            }
            * { box-sizing: border-box; }
            html, body {
              margin: 0;
              padding: 0;
              background: transparent;
              color: var(--ink);
              font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
              font-size: 15px;
              line-height: 1.72;
              -webkit-font-smoothing: antialiased;
              -webkit-user-select: text;
              user-select: text;
            }
            body {
              padding: 4px 2px 24px;
              cursor: text;
            }
            .placeholder {
              margin: 0.2em 0 0;
              color: var(--muted);
            }
            h1, h2, h3, h4 {
              margin: 1.1em 0 0.45em;
              color: var(--ink);
              line-height: 1.3;
            }
            h1 { font-size: 1.7rem; }
            h2 { font-size: 1.35rem; }
            h3 { font-size: 1.12rem; }
            p {
              margin: 0.72em 0;
            }
            ul, ol {
              margin: 0.8em 0;
              padding-left: 1.45em;
            }
            li + li {
              margin-top: 0.26em;
            }
            blockquote {
              margin: 1em 0;
              padding: 0.72em 0.9em;
              border-left: 3px solid var(--accent);
              background: var(--quote-bg);
              border-radius: 12px;
              color: var(--ink);
            }
            code {
              padding: 0.14em 0.38em;
              border-radius: 7px;
              background: var(--inline-code-bg);
              font-family: "SF Mono", ui-monospace, Menlo, monospace;
              font-size: 0.92em;
            }
            pre {
              margin: 0.95em 0;
              padding: 1em 1.1em;
              border-radius: 16px;
              background: var(--code-bg);
              color: #e2e8f0;
              overflow: auto;
            }
            pre code {
              padding: 0;
              background: transparent;
              color: inherit;
              font-size: 0.92em;
            }
            hr {
              margin: 1.2em 0;
              border: none;
              border-top: 1px solid var(--rule);
            }
            a {
              color: var(--accent);
              text-decoration: none;
            }
            .citation {
              margin-left: 0.14em;
              font-size: 0.72em;
              vertical-align: super;
            }
            .citation a {
              padding: 0 0.18em;
              border-radius: 999px;
              background: rgba(2, 132, 199, 0.10);
              color: var(--accent);
            }
            .reasoning {
              margin: 0.25em 0 1em;
              border: 1px solid rgba(148, 163, 184, 0.28);
              border-radius: 16px;
              background: rgba(248, 250, 252, 0.8);
              overflow: hidden;
            }
            .reasoning summary {
              padding: 0.72em 0.9em;
              cursor: pointer;
              list-style: none;
              color: var(--accent);
              font-size: 0.92rem;
              font-weight: 600;
              user-select: none;
            }
            .reasoning summary::-webkit-details-marker {
              display: none;
            }
            .reasoning-body {
              padding: 0 0.9em 0.9em;
              color: var(--muted);
              font-size: 13px;
              line-height: 1.62;
            }
            .reasoning-body > :first-child {
              margin-top: 0;
            }
            .sources {
              margin-top: 1.4em;
              padding-top: 1.1em;
              border-top: 1px solid var(--rule);
            }
            table {
              width: 100%;
              margin: 1em 0;
              border-collapse: collapse;
              overflow: hidden;
              border: 1px solid rgba(148, 163, 184, 0.25);
              border-radius: 14px;
              background: rgba(255, 255, 255, 0.75);
            }
            th, td {
              padding: 0.72em 0.82em;
              border-bottom: 1px solid rgba(148, 163, 184, 0.18);
              text-align: left;
              vertical-align: top;
            }
            th {
              background: rgba(226, 232, 240, 0.45);
              font-weight: 700;
            }
            tr:last-child td {
              border-bottom: none;
            }
            .sources h3 {
              margin: 0 0 0.7em;
              font-size: 0.95rem;
            }
            .sources ol {
              margin: 0;
              padding-left: 1.2em;
            }
            .sources li + li {
              margin-top: 0.45em;
            }
            .source-url {
              display: block;
              margin-top: 0.14em;
              color: var(--muted);
              font-size: 0.86em;
              word-break: break-all;
            }
            strong {
              font-weight: 700;
            }
            em {
              font-style: italic;
            }
          </style>
        </head>
        <body>\(body)</body>
        </html>
        """
    }

    static func renderBody(
        _ markdown: String,
        sources: [[String: Any]] = [],
        reasoningMarkdown: String = "",
        reasoningCollapsed: Bool = false,
        codeMarkdown: String = "",
        codeCollapsed: Bool = true
    ) -> String {
        let trimmedMarkdown = markdown.trimmingCharacters(in: .whitespacesAndNewlines)
        let reasoningSection = renderReasoning(reasoningMarkdown, collapsed: reasoningCollapsed)
        let codeSection = renderCodeSection(codeMarkdown, collapsed: codeCollapsed)
        let mainContent = trimmedMarkdown.isEmpty
            ? (reasoningSection.isEmpty && codeSection.isEmpty ? "<p class=\"placeholder\">正在生成...</p>" : "")
            : renderBlocks(trimmedMarkdown)
        return [reasoningSection, codeSection, mainContent, renderSources(sources)]
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
    }

    static func escapeForJSString(_ string: String) -> String {
        string
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }

    private static func renderReasoning(_ markdown: String, collapsed: Bool) -> String {
        let trimmed = markdown.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        let openAttribute = collapsed ? "" : " open"
        return """
        <details class="reasoning"\(openAttribute)>
          <summary>思考过程</summary>
          <div class="reasoning-body">\(renderBlocks(trimmed))</div>
        </details>
        """
    }

    private static func renderCodeSection(_ markdown: String, collapsed: Bool) -> String {
        let trimmed = markdown.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        let openAttribute = collapsed ? "" : " open"
        return """
        <details class="reasoning"\(openAttribute)>
          <summary>代码执行</summary>
          <div class="reasoning-body">\(renderBlocks(trimmed))</div>
        </details>
        """
    }

    private static func renderBlocks(_ markdown: String) -> String {
        let normalized = markdown.replacingOccurrences(of: "\r\n", with: "\n")
        let lines = normalized.components(separatedBy: "\n")
        var index = 0
        var html: [String] = []

        while index < lines.count {
            let rawLine = lines[index]
            let trimmed = rawLine.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty {
                index += 1
                continue
            }

            if trimmed.hasPrefix("```") {
                index += 1
                var codeLines: [String] = []
                while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    codeLines.append(lines[index])
                    index += 1
                }
                html.append("<pre><code>\(escapeHTML(codeLines.joined(separator: "\n")))</code></pre>")
                index += 1
                continue
            }

            if trimmed == "---" || trimmed == "***" {
                html.append("<hr>")
                index += 1
                continue
            }

            if let heading = renderHeading(trimmed) {
                html.append(heading)
                index += 1
                continue
            }

            if isTableHeader(lines, at: index) {
                let tableHTML = renderTable(lines: lines, startIndex: &index)
                if !tableHTML.isEmpty {
                    html.append(tableHTML)
                    continue
                }
            }

            if trimmed.hasPrefix(">") {
                var quoteLines: [String] = []
                while index < lines.count {
                    let candidate = lines[index].trimmingCharacters(in: .whitespaces)
                    guard candidate.hasPrefix(">") else { break }
                    let stripped = candidate.dropFirst().trimmingCharacters(in: .whitespaces)
                    quoteLines.append(renderInline(stripped))
                    index += 1
                }
                html.append("<blockquote>\(quoteLines.joined(separator: "<br>"))</blockquote>")
                continue
            }

            if isUnorderedList(trimmed) {
                var items: [String] = []
                while index < lines.count {
                    while index < lines.count, lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
                        index += 1
                    }
                    guard index < lines.count else { break }
                    let candidate = lines[index].trimmingCharacters(in: .whitespaces)
                    guard isUnorderedList(candidate) else { break }
                    items.append("<li>\(renderInline(String(candidate.dropFirst(2))))</li>")
                    index += 1
                }
                html.append("<ul>\(items.joined())</ul>")
                continue
            }

            if isOrderedList(trimmed) {
                var items: [String] = []
                var startNumber: Int?
                while index < lines.count {
                    while index < lines.count, lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
                        index += 1
                    }
                    guard index < lines.count else { break }
                    let candidate = lines[index].trimmingCharacters(in: .whitespaces)
                    guard let item = orderedListItem(candidate) else { break }
                    if startNumber == nil {
                        startNumber = item.number
                    }
                    items.append("<li>\(renderInline(item.text))</li>")
                    index += 1
                }
                let startAttribute = startNumber != nil && startNumber != 1 ? " start=\"\(startNumber!)\"" : ""
                html.append("<ol\(startAttribute)>\(items.joined())</ol>")
                continue
            }

            var paragraphLines: [String] = []
            while index < lines.count {
                let candidate = lines[index].trimmingCharacters(in: .whitespaces)
                if candidate.isEmpty || candidate.hasPrefix("#") || candidate.hasPrefix(">") || candidate.hasPrefix("```") || isUnorderedList(candidate) || isOrderedList(candidate) || candidate == "---" || candidate == "***" {
                    break
                }
                paragraphLines.append(renderInline(candidate))
                index += 1
            }
            html.append("<p>\(paragraphLines.joined(separator: "<br>"))</p>")
        }

        return html.joined(separator: "\n")
    }

    private static func renderHeading(_ line: String) -> String? {
        let hashes = line.prefix { $0 == "#" }
        guard !hashes.isEmpty, hashes.count <= 4 else { return nil }
        let content = line.dropFirst(hashes.count).trimmingCharacters(in: .whitespaces)
        guard !content.isEmpty else { return nil }
        return "<h\(hashes.count)>\(renderInline(content))</h\(hashes.count)>"
    }

    private static func isTableHeader(_ lines: [String], at index: Int) -> Bool {
        guard index + 1 < lines.count else { return false }
        let header = lines[index].trimmingCharacters(in: .whitespaces)
        let separator = lines[index + 1].trimmingCharacters(in: .whitespaces)
        guard header.contains("|"), separator.contains("|") else { return false }
        return isTableSeparator(separator)
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        let cells = splitTableRow(line)
        guard !cells.isEmpty else { return false }
        return cells.allSatisfy { cell in
            let trimmed = cell.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { return false }
            return trimmed.allSatisfy { $0 == "-" || $0 == ":" }
        }
    }

    private static func splitTableRow(_ line: String) -> [String] {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let stripped = trimmed
            .trimmingCharacters(in: CharacterSet(charactersIn: "|"))
        guard !stripped.isEmpty else { return [] }
        return stripped.split(separator: "|", omittingEmptySubsequences: false).map {
            String($0).trimmingCharacters(in: .whitespaces)
        }
    }

    private static func renderTable(lines: [String], startIndex index: inout Int) -> String {
        let headerCells = splitTableRow(lines[index])
        guard !headerCells.isEmpty else { return "" }
        index += 2

        var bodyRows: [[String]] = []
        while index < lines.count {
            let candidate = lines[index].trimmingCharacters(in: .whitespaces)
            if candidate.isEmpty {
                index += 1
                continue
            }
            guard candidate.contains("|"), !isTableSeparator(candidate) else { break }
            let row = splitTableRow(candidate)
            guard !row.isEmpty else { break }
            bodyRows.append(row)
            index += 1
        }

        let headerHTML = headerCells.map { "<th>\(renderInline($0))</th>" }.joined()
        let bodyHTML = bodyRows.map { row in
            let cells = row.map { "<td>\(renderInline($0))</td>" }.joined()
            return "<tr>\(cells)</tr>"
        }.joined()

        return """
        <table>
          <thead><tr>\(headerHTML)</tr></thead>
          <tbody>\(bodyHTML)</tbody>
        </table>
        """
    }

    private static func isUnorderedList(_ line: String) -> Bool {
        line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ")
    }

    private static func isOrderedList(_ line: String) -> Bool {
        orderedListItem(line) != nil
    }

    private static func orderedListItem(_ line: String) -> (number: Int, text: String)? {
        let range = NSRange(line.startIndex..<line.endIndex, in: line)
        guard let match = orderedListRegex.firstMatch(in: line, range: range),
              let fullRange = Range(match.range(at: 0), in: line),
              let textRange = Range(match.range(at: 1), in: line) else {
            return nil
        }
        let prefix = line[fullRange].split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
        guard let number = Int(prefix) else { return nil }
        return (number: number, text: String(line[textRange]))
    }

    private static func renderInline<S: StringProtocol>(_ source: S) -> String {
        var html = escapeHTML(String(source))
        html = replaceRegex(citationRefRegex, in: html) { groups in
            "<sup class=\"citation\"><a href=\"#ref-\(groups[1])\">\(groups[1])</a></sup>"
        }
        html = replaceRegex(inlineCodeRegex, in: html) { groups in
            "<code>\(groups[1])</code>"
        }
        html = replaceRegex(linkRegex, in: html) { groups in
            "<a href=\"\(groups[2])\">\(groups[1])</a>"
        }
        html = replaceRegex(boldRegex, in: html) { groups in
            "<strong>\(groups[1])</strong>"
        }
        html = replaceRegex(italicRegex, in: html) { groups in
            "<em>\(groups[1])</em>"
        }
        return html
    }

    private static func escapeHTML(_ string: String) -> String {
        string
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }

    private static func replaceRegex(
        _ regex: NSRegularExpression,
        in source: String,
        transform: ([String]) -> String
    ) -> String {
        let matches = regex.matches(in: source, options: [], range: NSRange(source.startIndex..<source.endIndex, in: source))
        guard !matches.isEmpty else { return source }

        var result = source
        for match in matches.reversed() {
            var groups: [String] = []
            for index in 0..<match.numberOfRanges {
                if let range = Range(match.range(at: index), in: result) {
                    groups.append(String(result[range]))
                } else {
                    groups.append("")
                }
            }
            if let range = Range(match.range(at: 0), in: result) {
                result.replaceSubrange(range, with: transform(groups))
            }
        }
        return result
    }

    private static func renderSources(_ sources: [[String: Any]]) -> String {
        guard !sources.isEmpty else { return "" }
        let items = sources.compactMap { item -> String? in
            guard let index = item["index"] as? Int,
                  let title = item["title"] as? String,
                  let url = item["url"] as? String else {
                return nil
            }
            return """
            <li id="ref-\(index)">
              <a href="\(escapeHTML(url))">\(escapeHTML(title))</a>
              <span class="source-url">\(escapeHTML(url))</span>
            </li>
            """
        }.joined()

        guard !items.isEmpty else { return "" }
        return """
        <section class="sources">
          <h3>搜索来源</h3>
          <ol>\(items)</ol>
        </section>
        """
    }
}

// MARK: - Overlay Coordinator

final class OverlayCoordinator {
    private let hudController = RecordingHUDPanelController()
    private let resultController = AssistantResultPanelController()

    // Layer 2: Async payload merging for overlayResultShow
    private var pendingResultPayload: [String: Any]?
    private let resultLock = NSLock()

    func showHud(payload: [String: Any]) {
        guard let text = payload["text"] as? String,
              let modeRaw = payload["mode"] as? String,
              let voiceModeRaw = payload["voiceMode"] as? String,
              let mode = OverlayVisualMode(rawValue: modeRaw),
              let voiceMode = OverlayVoiceMode(rawValue: voiceModeRaw) else {
            outputOverlayError("Invalid HUD payload")
            return
        }

        let screenshotActive = payload["screenshotActive"] as? Bool ?? false
        hudController.show(text: text, mode: mode, voiceMode: voiceMode, screenshotActive: screenshotActive)
    }

    func updateHud(payload: [String: Any]) {
        guard let text = payload["text"] as? String,
              let modeRaw = payload["mode"] as? String,
              let voiceModeRaw = payload["voiceMode"] as? String,
              let mode = OverlayVisualMode(rawValue: modeRaw),
              let voiceMode = OverlayVoiceMode(rawValue: voiceModeRaw) else {
            outputOverlayError("Invalid HUD payload")
            return
        }

        let screenshotActive = payload["screenshotActive"] as? Bool ?? false
        hudController.update(text: text, mode: mode, voiceMode: voiceMode, screenshotActive: screenshotActive)
        hudController.show(text: text, mode: mode, voiceMode: voiceMode, screenshotActive: screenshotActive)
    }

    func hideHud() {
        hudController.hide()
    }

    func showResult(payload: [String: Any]) {
        guard let text = payload["text"] as? String else {
            outputOverlayError("Invalid result payload")
            return
        }
        let position = payload["position"] as? [String: Any]
        let size = payload["size"] as? [String: Any]
        let detailsMarkdown = payload["detailsMarkdown"] as? String
        let stats = payload["stats"] as? [[String: String]] ?? []
        let sources = payload["sources"] as? [[String: Any]] ?? []
        let reasoningMarkdown = payload["reasoningMarkdown"] as? String
        let reasoningCollapsed = payload["reasoningCollapsed"] as? Bool ?? false
        let codeMarkdown = payload["codeMarkdown"] as? String
        let codeCollapsed = payload["codeCollapsed"] as? Bool ?? true
        resultController.show(
            markdown: text,
            position: position,
            size: size,
            detailsMarkdown: detailsMarkdown,
            stats: stats,
            sources: sources,
            reasoningMarkdown: reasoningMarkdown,
            reasoningCollapsed: reasoningCollapsed,
            codeMarkdown: codeMarkdown,
            codeCollapsed: codeCollapsed
        )
    }

    func hideResult() {
        clearPendingResult()
        resultController.hide()
    }

    func dismissAll() {
        clearPendingResult()
        hudController.hide()
        resultController.hide()
    }

    /// Called from stdin reader thread. Stores the latest payload and schedules
    /// an async drain on the main thread. Multiple rapid calls will coalesce —
    /// only the most recent payload is rendered.
    func enqueueShowResult(payload: [String: Any]) {
        resultLock.lock()
        pendingResultPayload = payload
        resultLock.unlock()
        DispatchQueue.main.async { [weak self] in
            self?.drainAndShowResult()
        }
    }

    private func drainAndShowResult() {
        resultLock.lock()
        let payload = pendingResultPayload
        pendingResultPayload = nil
        resultLock.unlock()
        guard let payload else { return }
        showResult(payload: payload)
    }

    private func clearPendingResult() {
        resultLock.lock()
        pendingResultPayload = nil
        resultLock.unlock()
    }
}

// MARK: - Command Processing

let eventTap = KeyboardEventTap()
let overlayCoordinator = OverlayCoordinator()

func runOnMain<T>(_ block: () -> T) -> T {
    if Thread.isMainThread {
        return block()
    }
    return DispatchQueue.main.sync(execute: block)
}

func processCommand(_ command: [String: Any]) {
    guard let cmd = command["command"] as? String else { return }

    switch cmd {
    case "start":
        let success = runOnMain { eventTap.start() }
        outputStatus(success ? "ok" : "error")

    case "stop":
        runOnMain {
            eventTap.stop()
            overlayCoordinator.dismissAll()
        }
        outputStatus("ok")

    case "setShortcut":
        if let shortcut = command["shortcut"] as? String {
            runOnMain { eventTap.setShortcut(shortcut) }
            outputStatus("ok")
        } else {
            outputStatus("error")
        }

    case "setShortcuts":
        if let shortcutsArray = command["shortcuts"] as? [[String: String]] {
            let shortcuts: [(id: String, shortcut: String)] = shortcutsArray.compactMap { dict in
                guard let id = dict["id"], let shortcut = dict["shortcut"] else { return nil }
                return (id: id, shortcut: shortcut)
            }
            runOnMain { eventTap.setShortcuts(shortcuts) }
            outputStatus("ok")
        } else {
            outputStatus("error")
        }

    case "overlayHudShow":
        if let payload = command["payload"] as? [String: Any] {
            runOnMain { overlayCoordinator.showHud(payload: payload) }
            outputStatus("ok")
        } else {
            outputStatus("error")
        }

    case "overlayHudUpdate":
        if let payload = command["payload"] as? [String: Any] {
            runOnMain { overlayCoordinator.updateHud(payload: payload) }
            outputStatus("ok")
        } else {
            outputStatus("error")
        }

    case "overlayHudHide":
        runOnMain { overlayCoordinator.hideHud() }
        outputStatus("ok")

    case "overlayResultShow":
        if let payload = command["payload"] as? [String: Any] {
            overlayCoordinator.enqueueShowResult(payload: payload)
            outputStatus("ok")
        } else {
            outputStatus("error")
        }

    case "overlayResultHide":
        runOnMain { overlayCoordinator.hideResult() }
        outputStatus("ok")

    case "overlayDismissAll":
        runOnMain { overlayCoordinator.dismissAll() }
        outputStatus("ok")

    default:
        outputStatus("unknown_command")
    }
}

// MARK: - Main Loop

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
application.finishLaunching()
outputJSON(["type": "overlayReady"])

let stdin = FileHandle.standardInput
let fd = STDIN_FILENO
var inputBuffer = ""

let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: DispatchQueue.global(qos: .userInitiated))

source.setEventHandler {
    let data = stdin.availableData
    guard !data.isEmpty else {
        source.cancel()
        return
    }

    if let inputString = String(data: data, encoding: .utf8) {
        inputBuffer += inputString

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
    DispatchQueue.main.async {
        overlayCoordinator.dismissAll()
        eventTap.stop()
        application.stop(nil)
    }
}

source.resume()
application.run()
