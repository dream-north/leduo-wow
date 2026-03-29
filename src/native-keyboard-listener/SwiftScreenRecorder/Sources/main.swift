import AppKit
import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

private enum ScreenRecorderError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let message):
            return message
        }
    }
}

private func jsonObject(from error: Error) -> [String: Any] {
    let nsError = error as NSError
    return [
        "message": error.localizedDescription,
        "domain": nsError.domain,
        "code": nsError.code
    ]
}

private func outputJSON(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object),
          let text = String(data: data, encoding: .utf8) else {
        return
    }

    FileHandle.standardOutput.write((text + "\n").data(using: .utf8)!)
}

private func respond(id: String?, ok: Bool, result: Any? = nil, error: Error? = nil) {
    var payload: [String: Any] = [
        "type": "response",
        "ok": ok
    ]

    if let id {
        payload["id"] = id
    }
    if let result {
        payload["result"] = result
    }
    if let error {
        payload["error"] = error.localizedDescription
        payload["errorDetail"] = jsonObject(from: error)
    }

    outputJSON(payload)
}

private func emitEvent(_ event: String, error: Error? = nil, extra: [String: Any] = [:]) {
    var payload: [String: Any] = [
        "type": "event",
        "event": event
    ]
    for (key, value) in extra {
        payload[key] = value
    }
    if let error {
        payload["error"] = error.localizedDescription
        payload["errorDetail"] = jsonObject(from: error)
    }
    outputJSON(payload)
}

private func runOnMain(_ block: @escaping () -> Void) {
    if Thread.isMainThread {
        block()
    } else {
        DispatchQueue.main.async(execute: block)
    }
}

private func makePNGDataURL(from image: CGImage) throws -> String {
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw ScreenRecorderError.message("无法编码 PNG 截图")
    }
    return "data:image/png;base64," + data.base64EncodedString()
}

private func cmTimeMilliseconds(_ time: CMTime) -> Int {
    if !time.isNumeric || time.seconds.isNaN || !time.seconds.isFinite {
        return 0
    }
    return max(0, Int((time.seconds * 1000).rounded()))
}

private func buildTargetDescription(from filter: SCContentFilter) -> String {
    let kind: String
    switch filter.style {
    case .display:
        kind = "显示器"
    case .window:
        kind = "窗口"
    case .application:
        kind = "应用"
    default:
        kind = "屏幕内容"
    }

    let rect = filter.contentRect
    let width = max(1, Int(rect.width.rounded()))
    let height = max(1, Int(rect.height.rounded()))
    return "\(kind) \(width)x\(height)"
}

private final class RecordingSession: NSObject, SCStreamOutput {
    let outputURL: URL
    let targetDescription: String

    private let stream: SCStream
    private let streamQueue = DispatchQueue(label: "SwiftScreenRecorder.stream")
    private let writer: AVAssetWriter
    private let writerInput: AVAssetWriterInput
    private var firstSampleTime: CMTime?
    private var lastSampleTime: CMTime?
    private let startWallClock = Date()
    private var isFinishing = false
    var onFailure: ((Error) -> Void)?

    init(filter: SCContentFilter, outputURL: URL) throws {
        self.outputURL = outputURL
        self.targetDescription = buildTargetDescription(from: filter)

        let config = SCStreamConfiguration()
        let scale = max(1, Double(filter.pointPixelScale))
        let rawWidth = max(1, Int((Double(filter.contentRect.width) * scale).rounded()))
        let rawHeight = max(1, Int((Double(filter.contentRect.height) * scale).rounded()))
        let maxLongEdge = 1728
        let longEdge = max(rawWidth, rawHeight)
        let sizeScale = longEdge > maxLongEdge ? Double(maxLongEdge) / Double(longEdge) : 1.0

        config.width = max(640, Int((Double(rawWidth) * sizeScale).rounded()))
        config.height = max(360, Int((Double(rawHeight) * sizeScale).rounded()))
        config.minimumFrameInterval = CMTime(value: 1, timescale: 15)
        config.queueDepth = 6
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = true
        config.capturesAudio = false

        if #available(macOS 14.2, *) {
            filter.includeMenuBar = true
        }

        self.stream = SCStream(filter: filter, configuration: config, delegate: nil)

        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: config.width,
            AVVideoHeightKey: config.height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 3_000_000,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
            ]
        ]

        self.writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
        self.writerInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        self.writerInput.expectsMediaDataInRealTime = true
        self.writerInput.transform = .identity

        guard self.writer.canAdd(self.writerInput) else {
            throw ScreenRecorderError.message("无法创建原生录屏输出")
        }
        self.writer.add(self.writerInput)
        super.init()
    }

    func start(completion: @escaping (Result<Void, Error>) -> Void) {
        do {
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: streamQueue)
        } catch {
            completion(.failure(error))
            return
        }

        stream.startCapture { error in
            if let error {
                completion(.failure(error))
                return
            }
            completion(.success(()))
        }
    }

    func stop(completion: @escaping (Result<[String: Any], Error>) -> Void) {
        if isFinishing {
            completion(.failure(ScreenRecorderError.message("录屏正在结束，请稍候")))
            return
        }
        isFinishing = true

        stream.stopCapture { [weak self] error in
            guard let self else { return }
            if let error {
                self.finish(cancelled: true)
                completion(.failure(error))
                return
            }

            self.finish(cancelled: false) { result in
                switch result {
                case .success:
                    let duration = self.recordedDurationMs()
                    completion(.success([
                        "filePath": self.outputURL.path,
                        "mimeType": "video/mp4",
                        "durationMs": duration,
                        "targetDescription": self.targetDescription
                    ]))
                case .failure(let error):
                    completion(.failure(error))
                }
            }
        }
    }

    func cancel(completion: @escaping () -> Void) {
        if isFinishing {
            finish(cancelled: true) { _ in completion() }
            return
        }
        isFinishing = true

        stream.stopCapture { [weak self] _ in
            guard let self else {
                completion()
                return
            }
            self.finish(cancelled: true) { _ in
                completion()
            }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        guard CMSampleBufferIsValid(sampleBuffer), CMSampleBufferDataIsReady(sampleBuffer) else { return }
        guard !isFinishing else { return }

        let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        guard presentationTime.isValid else { return }

        if writer.status == .unknown {
            if !writer.startWriting() {
                onFailure?(writer.error ?? ScreenRecorderError.message("无法开始写入录屏文件"))
                return
            }
            writer.startSession(atSourceTime: presentationTime)
            firstSampleTime = presentationTime
        }

        guard writer.status == .writing else {
            if writer.status == .failed {
                onFailure?(writer.error ?? ScreenRecorderError.message("录屏写入失败"))
            }
            return
        }

        guard writerInput.isReadyForMoreMediaData else { return }
        if writerInput.append(sampleBuffer) {
            lastSampleTime = presentationTime
            return
        }

        onFailure?(writer.error ?? ScreenRecorderError.message("录屏帧写入失败"))
    }

    private func finish(cancelled: Bool, completion: ((Result<Void, Error>) -> Void)? = nil) {
        streamQueue.async { [weak self] in
            guard let self else {
                completion?(.success(()))
                return
            }

            if self.writerInput.isReadyForMoreMediaData {
                self.writerInput.markAsFinished()
            } else {
                self.writerInput.markAsFinished()
            }

            if cancelled {
                self.writer.cancelWriting()
                try? FileManager.default.removeItem(at: self.outputURL)
                completion?(.success(()))
                return
            }

            if self.writer.status == .unknown {
                self.writer.cancelWriting()
                try? FileManager.default.removeItem(at: self.outputURL)
                completion?(.failure(ScreenRecorderError.message("录屏没有采集到有效画面")))
                return
            }

            self.writer.finishWriting {
                if self.writer.status == .failed {
                    let error = self.writer.error ?? ScreenRecorderError.message("录屏文件写入失败")
                    completion?(.failure(error))
                    return
                }
                completion?(.success(()))
            }
        }
    }

    private func recordedDurationMs() -> Int {
        if let firstSampleTime, let lastSampleTime {
            let duration = CMTimeSubtract(lastSampleTime, firstSampleTime)
            let milliseconds = cmTimeMilliseconds(duration)
            if milliseconds > 0 {
                return milliseconds
            }
        }
        return max(1, Int(Date().timeIntervalSince(startWallClock) * 1000))
    }
}

private final class ScreenRecorderController: NSObject, SCContentSharingPickerObserver {
    private var session: RecordingSession?
    private var pendingStart: ((Result<[String: Any], Error>) -> Void)?

    func startRecording(completion: @escaping (Result<[String: Any], Error>) -> Void) {
        guard session == nil else {
            completion(.failure(ScreenRecorderError.message("已有录屏会话在进行中")))
            return
        }
        guard pendingStart == nil else {
            completion(.failure(ScreenRecorderError.message("正在等待选择录屏对象")))
            return
        }

        guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
            completion(.failure(ScreenRecorderError.message("请先授予屏幕录制权限")))
            return
        }

        pendingStart = completion

        let picker = pickerInstance()
        picker.add(self)
        picker.maximumStreamCount = 1

        var configuration = picker.defaultConfiguration
        configuration.allowedPickerModes = [.singleWindow, .singleDisplay]
        configuration.allowsChangingSelectedContent = false
        picker.defaultConfiguration = configuration
        picker.isActive = true

        NSApplication.shared.activate(ignoringOtherApps: true)
        picker.present()
    }

    func stopRecording(completion: @escaping (Result<[String: Any], Error>) -> Void) {
        guard let session else {
            completion(.failure(ScreenRecorderError.message("当前没有进行中的录屏")))
            return
        }

        session.stop { [weak self] result in
            self?.session = nil
            completion(result)
        }
    }

    func cancelRecording(completion: @escaping (Result<[String: Any], Error>) -> Void) {
        if let pendingStart {
            self.pendingStart = nil
            pendingStart(.failure(ScreenRecorderError.message("已取消录屏对象选择")))
            tearDownPicker()
            completion(.success([:]))
            return
        }

        guard let session else {
            completion(.failure(ScreenRecorderError.message("当前没有进行中的录屏")))
            return
        }

        session.cancel { [weak self] in
            self?.session = nil
            completion(.success([:]))
        }
    }

    func extractScreenshots(filePath: String, timestampsMs: [Int], completion: @escaping (Result<[[String: Any]], Error>) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let frames = try Self.extractFrames(filePath: filePath, timestampsMs: timestampsMs)
                completion(.success(frames))
            } catch {
                completion(.failure(error))
            }
        }
    }

    func extractTimelineFrames(
        filePath: String,
        intervalMs: Int,
        maxFrames: Int,
        completion: @escaping (Result<[String: Any], Error>) -> Void
    ) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let asset = AVURLAsset(url: URL(fileURLWithPath: filePath))
                let durationMs = max(1, cmTimeMilliseconds(asset.duration))
                let requestedInterval = max(750, intervalMs)
                let frameLimit = max(1, maxFrames)

                var timestamps: [Int] = []
                var current = 0
                while current < durationMs && timestamps.count < frameLimit {
                    timestamps.append(current)
                    current += requestedInterval
                }

                let lastTimestamp = durationMs
                if timestamps.isEmpty || timestamps[timestamps.count - 1] != lastTimestamp {
                    if timestamps.count == frameLimit {
                        timestamps[timestamps.count - 1] = lastTimestamp
                    } else {
                        timestamps.append(lastTimestamp)
                    }
                }

                let frames = try Self.extractFrames(filePath: filePath, timestampsMs: timestamps)
                completion(.success([
                    "frames": frames,
                    "intervalMs": requestedInterval
                ]))
            } catch {
                completion(.failure(error))
            }
        }
    }

    private func pickerInstance() -> SCContentSharingPicker {
        if #available(macOS 14.0, *) {
            return .shared
        }
        fatalError("SCContentSharingPicker requires macOS 14")
    }

    private func tearDownPicker() {
        let picker = pickerInstance()
        picker.remove(self)
        picker.isActive = false
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
        guard let pendingStart else { return }
        self.pendingStart = nil
        tearDownPicker()
        pendingStart(.failure(ScreenRecorderError.message("已取消录屏对象选择")))
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        guard let pendingStart else { return }
        self.pendingStart = nil
        tearDownPicker()

        do {
            let outputURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("screen-doc-\(UUID().uuidString)")
                .appendingPathExtension("mp4")

            let session = try RecordingSession(filter: filter, outputURL: outputURL)
            session.onFailure = { error in
                emitEvent("recording-error", error: error)
            }

            session.start { [weak self] result in
                switch result {
                case .success:
                    self?.session = session
                    pendingStart(.success([
                        "filePath": outputURL.path,
                        "targetDescription": session.targetDescription
                    ]))
                case .failure(let error):
                    try? FileManager.default.removeItem(at: outputURL)
                    pendingStart(.failure(error))
                }
            }
        } catch {
            pendingStart(.failure(error))
        }
    }

    func contentSharingPickerStartDidFailWithError(_ error: Error) {
        guard let pendingStart else { return }
        self.pendingStart = nil
        tearDownPicker()
        pendingStart(.failure(error))
    }

    private static func extractFrames(filePath: String, timestampsMs: [Int]) throws -> [[String: Any]] {
        let url = URL(fileURLWithPath: filePath)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw ScreenRecorderError.message("录屏文件不存在，无法提取截图")
        }

        let asset = AVURLAsset(url: url)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.requestedTimeToleranceBefore = CMTime(value: 1, timescale: 8)
        generator.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 8)
        generator.maximumSize = CGSize(width: 1440, height: 900)

        var results: [[String: Any]] = []
        for timestampMs in timestampsMs {
            let requestedTime = CMTime(value: CMTimeValue(max(0, timestampMs)), timescale: 1000)
            var actualTime = CMTime.zero
            do {
                let image = try generator.copyCGImage(at: requestedTime, actualTime: &actualTime)
                results.append([
                    "timestampMs": cmTimeMilliseconds(actualTime),
                    "dataUrl": try makePNGDataURL(from: image)
                ])
            } catch {
                if timestampsMs.count == 1 {
                    throw error
                }
            }
        }

        guard !results.isEmpty else {
            throw ScreenRecorderError.message("没有提取到有效截图")
        }
        return results
    }
}

private let controller = ScreenRecorderController()

private func parseIntArray(_ value: Any?) -> [Int] {
    guard let numbers = value as? [NSNumber] else { return [] }
    return numbers.map { $0.intValue }
}

private func handleCommand(_ command: [String: Any]) {
    let id = command["id"] as? String
    guard let name = command["command"] as? String else {
        respond(id: id, ok: false, error: ScreenRecorderError.message("缺少 command 字段"))
        return
    }

    let payload = command["payload"] as? [String: Any]

    switch name {
    case "startRecording":
        runOnMain {
            controller.startRecording { result in
                switch result {
                case .success(let result):
                    respond(id: id, ok: true, result: result)
                case .failure(let error):
                    respond(id: id, ok: false, error: error)
                }
            }
        }

    case "stopRecording":
        runOnMain {
            controller.stopRecording { result in
                switch result {
                case .success(let result):
                    respond(id: id, ok: true, result: result)
                case .failure(let error):
                    respond(id: id, ok: false, error: error)
                }
            }
        }

    case "cancelRecording":
        runOnMain {
            controller.cancelRecording { result in
                switch result {
                case .success(let result):
                    respond(id: id, ok: true, result: result)
                case .failure(let error):
                    respond(id: id, ok: false, error: error)
                }
            }
        }

    case "extractScreenshots":
        guard let filePath = payload?["filePath"] as? String else {
            respond(id: id, ok: false, error: ScreenRecorderError.message("缺少 filePath"))
            return
        }
        let timestampsMs = parseIntArray(payload?["timestampsMs"])
        controller.extractScreenshots(filePath: filePath, timestampsMs: timestampsMs) { result in
            switch result {
            case .success(let screenshots):
                respond(id: id, ok: true, result: screenshots)
            case .failure(let error):
                respond(id: id, ok: false, error: error)
            }
        }

    case "extractTimelineFrames":
        guard let filePath = payload?["filePath"] as? String else {
            respond(id: id, ok: false, error: ScreenRecorderError.message("缺少 filePath"))
            return
        }
        let intervalMs = (payload?["intervalMs"] as? NSNumber)?.intValue ?? 1000
        let maxFrames = (payload?["maxFrames"] as? NSNumber)?.intValue ?? 48
        controller.extractTimelineFrames(filePath: filePath, intervalMs: intervalMs, maxFrames: maxFrames) { result in
            switch result {
            case .success(let frames):
                respond(id: id, ok: true, result: frames)
            case .failure(let error):
                respond(id: id, ok: false, error: error)
            }
        }

    default:
        respond(id: id, ok: false, error: ScreenRecorderError.message("未知命令: \(name)"))
    }
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
application.finishLaunching()
outputJSON(["type": "ready"])

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

    guard let chunk = String(data: data, encoding: .utf8) else {
        return
    }
    inputBuffer += chunk

    while let newline = inputBuffer.firstIndex(of: "\n") {
        let line = String(inputBuffer[..<newline]).trimmingCharacters(in: .whitespacesAndNewlines)
        inputBuffer = String(inputBuffer[inputBuffer.index(after: newline)...])
        guard !line.isEmpty else { continue }

        guard let commandData = line.data(using: .utf8),
              let command = try? JSONSerialization.jsonObject(with: commandData) as? [String: Any] else {
            outputJSON([
                "type": "event",
                "event": "protocol-error",
                "error": "无法解析命令"
            ])
            continue
        }

        handleCommand(command)
    }
}

source.setCancelHandler {
    runOnMain {
        controller.cancelRecording { _ in
            application.stop(nil)
        }
    }
}

source.resume()
application.run()
