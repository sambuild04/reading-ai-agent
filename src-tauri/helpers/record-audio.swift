import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

// ScreenCaptureKit system audio recorder.
// Captures system audio to an M4A file, optionally excluding specific processes.
// Usage: record-audio [output-path] [--exclude-pid PID ...] [--exclude-bundle BUNDLE_ID ...]
// Runs until SIGTERM/SIGINT is received, then finalizes and exits.

var outputPath = "/tmp/samuel-recording.m4a"
var excludePIDs: [Int32] = []
var excludeBundles: [String] = []

// Parse arguments
var i = 1
while i < CommandLine.arguments.count {
    let arg = CommandLine.arguments[i]
    if arg == "--exclude-pid", i + 1 < CommandLine.arguments.count,
       let pid = Int32(CommandLine.arguments[i + 1]) {
        excludePIDs.append(pid)
        i += 2
    } else if arg == "--exclude-bundle", i + 1 < CommandLine.arguments.count {
        excludeBundles.append(CommandLine.arguments[i + 1])
        i += 2
    } else if !arg.hasPrefix("--") {
        outputPath = arg
        i += 1
    } else {
        i += 1
    }
}

let outputURL = URL(fileURLWithPath: outputPath)

try? FileManager.default.removeItem(at: outputURL)

// Dedicated queue for audio sample delivery — must not be main queue
let audioQueue = DispatchQueue(label: "com.samuel.record-audio", qos: .userInitiated)

class AudioRecorder: NSObject, SCStreamDelegate, SCStreamOutput {
    var stream: SCStream?
    var writer: AVAssetWriter?
    var audioInput: AVAssetWriterInput?
    var started = false

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: false
        )

        guard let display = content.displays.first else {
            fputs("[record-audio] no display found\n", stderr)
            exit(1)
        }

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        // Minimal video — we only need audio
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        // Filter out excluded processes/bundles (e.g. Samuel's own audio output)
        let excludedApps = content.applications.filter { app in
            excludePIDs.contains(app.processID) ||
            excludeBundles.contains(app.bundleIdentifier)
        }
        let filter: SCContentFilter
        if excludedApps.isEmpty {
            filter = SCContentFilter(display: display, excludingWindows: [])
        } else {
            let names = excludedApps.map { $0.applicationName }.joined(separator: ", ")
            fputs("[record-audio] excluding \(excludedApps.count) app(s): \(names)\n", stderr)
            filter = SCContentFilter(display: display, excludingApplications: excludedApps, exceptingWindows: [])
        }
        let stream = SCStream(filter: filter, configuration: config, delegate: self)

        // Use dedicated queue, not main (main run loop must stay free)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)

        self.stream = stream

        writer = try AVAssetWriter(url: outputURL, fileType: .m4a)

        let audioSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48000,
            AVNumberOfChannelsKey: 2,
            AVEncoderBitRateKey: 128_000,
        ]
        audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
        audioInput!.expectsMediaDataInRealTime = true
        writer!.add(audioInput!)

        try await stream.startCapture()
        fputs("[record-audio] capturing system audio to \(outputPath)\n", stderr)
    }

    func stop() {
        let group = DispatchGroup()
        group.enter()

        Task {
            if let stream = stream {
                try? await stream.stopCapture()
            }
            if let writer = writer, writer.status == .writing {
                audioInput?.markAsFinished()
                await writer.finishWriting()
            }
            fputs("[record-audio] stopped, file written\n", stderr)
            group.leave()
        }

        // Wait up to 5 s for finalization
        let result = group.wait(timeout: .now() + 5)
        if result == .timedOut {
            fputs("[record-audio] warning: finalization timed out\n", stderr)
        }
    }

    // SCStreamOutput — receives audio sample buffers (called on audioQueue)
    func stream(
        _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .audio else { return }
        guard let writer = writer, let audioInput = audioInput else { return }

        if !started {
            writer.startWriting()
            writer.startSession(atSourceTime: sampleBuffer.presentationTimeStamp)
            started = true
        }

        if audioInput.isReadyForMoreMediaData {
            audioInput.append(sampleBuffer)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("[record-audio] stream error: \(error)\n", stderr)
    }
}

let recorder = AudioRecorder()

// SIGTERM/SIGINT: finalize file synchronously then exit
let stopAndExit: @convention(c) (Int32) -> Void = { _ in
    recorder.stop()
    exit(0)
}
signal(SIGTERM, stopAndExit)
signal(SIGINT, stopAndExit)

// Launch the capture on a Task, then keep the main run loop alive
// so ScreenCaptureKit and GCD can function properly.
Task {
    do {
        try await recorder.start()
    } catch {
        fputs("[record-audio] failed to start: \(error)\n", stderr)
        exit(1)
    }
}

// dispatchMain() never returns — keeps the process alive with an active run loop
dispatchMain()
