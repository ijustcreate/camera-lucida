import ARKit
import Foundation
import SwiftUI

final class AppState: ObservableObject {
    enum TrackingPhase: Equatable {
        case starting
        case scanning
        case incomplete
        case confirming
        case ready
        case locked
        case limited(String)
        case unsupported
    }

    @Published var phase: TrackingPhase = .starting
    @Published var instruction = "Starting ARKit and LiDAR…"
    @Published var rectanglePoints: [CGPoint] = []
    @Published var confidence: Float = 0
    @Published var stableFrames = 0
    @Published var planeCount = 0
    @Published var meshCount = 0
    @Published var featureCount = 0
    @Published var lidarAvailable = false
    @Published var depthAvailable = false
    @Published var showMesh = true
    @Published var showPoints = true

    weak var controller: PaperARController?

    var canLock: Bool { phase == .ready }
    var isLocked: Bool { phase == .locked }

    var title: String {
        switch phase {
        case .starting: return "Starting spatial camera"
        case .scanning: return "No paper detected"
        case .incomplete: return "Whole sheet not visible"
        case .confirming: return "Paper found — hold still"
        case .ready: return "Paper identified"
        case .locked: return "World plane locked"
        case .limited: return "Tracking limited"
        case .unsupported: return "ARKit unavailable"
        }
    }

    var statusColor: Color {
        switch phase {
        case .ready, .locked: return Color(red: 0.43, green: 0.91, blue: 0.74)
        case .incomplete, .limited, .unsupported: return Color(red: 1, green: 0.50, blue: 0.43)
        default: return Color(red: 0.96, green: 0.72, blue: 0.38)
        }
    }

    func lockOrFindAgain() {
        if isLocked { controller?.resetAndScan() }
        else { controller?.lockDetectedPaper() }
    }

    func reset() {
        controller?.resetAndScan()
    }

    func toggleMesh() {
        showMesh.toggle()
        controller?.updateDebugOptions()
    }

    func togglePoints() {
        showPoints.toggle()
        controller?.updateDebugOptions()
    }
}
