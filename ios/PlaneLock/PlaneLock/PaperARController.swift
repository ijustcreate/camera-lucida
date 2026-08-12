import ARKit
import RealityKit
import UIKit
import Vision
import simd

final class PaperARController: NSObject, ARSessionDelegate {
    private struct PaperCandidate {
        var normalizedCorners: [CGPoint]
        var screenCorners: [CGPoint]
        var worldCorners: [SIMD3<Float>]
        var anchorTransform: simd_float4x4
        var width: Float
        var depth: Float
        var confidence: Float
    }

    private weak var arView: ARView?
    private weak var state: AppState?
    private let visionQueue = DispatchQueue(label: "com.ijustcreate.planelock.vision", qos: .userInitiated)
    private var visionBusy = false
    private var lastVisionTime: TimeInterval = 0
    private var lastCandidate: PaperCandidate?
    private var stableFrames = 0
    private var lockedAnchor: AnchorEntity?
    private var planeIDs = Set<UUID>()
    private var meshIDs = Set<UUID>()

    init(arView: ARView, state: AppState) {
        self.arView = arView
        self.state = state
        super.init()
        arView.session.delegate = self
    }

    func start() {
        guard ARWorldTrackingConfiguration.isSupported, let arView else {
            updateState { state in
                state.phase = .unsupported
                state.instruction = "This device cannot run ARKit world tracking."
            }
            return
        }

        let configuration = ARWorldTrackingConfiguration()
        configuration.worldAlignment = .gravity
        configuration.planeDetection = [.horizontal]
        configuration.environmentTexturing = .automatic

        let supportsMesh = ARWorldTrackingConfiguration.supportsSceneReconstruction(.meshWithClassification)
        if supportsMesh {
            configuration.sceneReconstruction = .meshWithClassification
        }

        let supportsDepth = ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
        if supportsDepth {
            configuration.frameSemantics.insert(.sceneDepth)
        }
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) {
            configuration.frameSemantics.insert(.smoothedSceneDepth)
        }

        updateState { state in
            state.phase = .scanning
            state.instruction = "Show the entire sheet with all four corners and a little surface around it."
            state.lidarAvailable = supportsMesh
            state.depthAvailable = supportsDepth
        }
        updateDebugOptions()
        arView.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
    }

    func stop() {
        arView?.session.pause()
    }

    func updateDebugOptions() {
        guard let arView, let state else { return }
        var options: ARView.DebugOptions = []
        if state.showMesh { options.insert(.showSceneUnderstanding) }
        if state.showPoints { options.insert(.showFeaturePoints) }
        arView.debugOptions = options
    }

    func resetAndScan() {
        if let lockedAnchor { arView?.scene.removeAnchor(lockedAnchor) }
        lockedAnchor = nil
        lastCandidate = nil
        stableFrames = 0
        updateState { state in
            state.phase = .scanning
            state.instruction = "Show the entire sheet with all four corners and a little surface around it."
            state.rectanglePoints = []
            state.confidence = 0
            state.stableFrames = 0
        }
    }

    func lockDetectedPaper() {
        guard lockedAnchor == nil, let candidate = lastCandidate, stableFrames >= 5, let arView else { return }

        let anchor = AnchorEntity(world: candidate.anchorTransform)
        let material = SimpleMaterial(
            color: UIColor(red: 0.43, green: 0.91, blue: 0.74, alpha: 0.19),
            roughness: 0.82,
            isMetallic: false
        )
        let plane = ModelEntity(
            mesh: .generatePlane(width: candidate.width, depth: candidate.depth),
            materials: [material]
        )
        plane.position.y = 0.002
        anchor.addChild(plane)
        addFrame(to: anchor, width: candidate.width, depth: candidate.depth)
        arView.scene.addAnchor(anchor)
        lockedAnchor = anchor

        updateState { state in
            state.phase = .locked
            state.instruction = "ARKit is holding this plane in world space while the phone moves."
            state.confidence = candidate.confidence
            state.stableFrames = 5
        }
    }

    private func addFrame(to anchor: AnchorEntity, width: Float, depth: Float) {
        let color = UIColor(red: 0.43, green: 0.91, blue: 0.74, alpha: 0.96)
        let material = SimpleMaterial(color: color, roughness: 0.65, isMetallic: false)
        let thickness: Float = max(0.0025, min(width, depth) * 0.006)
        let edgeHeight: Float = 0.004

        let horizontalMesh = MeshResource.generateBox(size: [width, edgeHeight, thickness])
        for z in [-depth / 2, depth / 2] {
            let edge = ModelEntity(mesh: horizontalMesh, materials: [material])
            edge.position = [0, edgeHeight / 2 + 0.003, z]
            anchor.addChild(edge)
        }

        let verticalMesh = MeshResource.generateBox(size: [thickness, edgeHeight, depth])
        for x in [-width / 2, width / 2] {
            let edge = ModelEntity(mesh: verticalMesh, materials: [material])
            edge.position = [x, edgeHeight / 2 + 0.003, 0]
            anchor.addChild(edge)
        }
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        updateFeatureCount(frame.rawFeaturePoints?.points.count ?? 0)
        guard lockedAnchor == nil else { return }
        let now = frame.timestamp
        guard !visionBusy, now - lastVisionTime >= 0.20 else { return }
        lastVisionTime = now
        visionBusy = true

        let pixelBuffer = frame.capturedImage
        let cameraTransform = frame.camera.transform
        let trackingState = frame.camera.trackingState
        visionQueue.async { [weak self] in
            self?.detectPaper(in: pixelBuffer, frame: frame, cameraTransform: cameraTransform, trackingState: trackingState)
        }
    }

    func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
        updateAnchorCounts(anchors, adding: true)
    }

    func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
        updateAnchorCounts(anchors, adding: false)
    }

    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        guard lockedAnchor != nil else { return }
        switch camera.trackingState {
        case .normal:
            updateState { state in
                state.phase = .locked
                state.instruction = "ARKit is holding this plane in world space while the phone moves."
            }
        case .limited(let reason):
            updateState { state in
                state.phase = .limited(Self.description(for: reason))
                state.instruction = "Move slowly and keep the paper area in view while ARKit recovers."
            }
        case .notAvailable:
            updateState { state in
                state.phase = .unsupported
                state.instruction = "World tracking is temporarily unavailable."
            }
        }
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        updateState { state in
            state.phase = .limited(error.localizedDescription)
            state.instruction = "ARKit stopped. Tap reset to restart the spatial session."
        }
    }

    private func detectPaper(
        in pixelBuffer: CVPixelBuffer,
        frame: ARFrame,
        cameraTransform: simd_float4x4,
        trackingState: ARCamera.TrackingState
    ) {
        defer { visionBusy = false }
        let request = VNDetectRectanglesRequest()
        request.maximumObservations = 4
        request.minimumConfidence = 0.63
        request.minimumAspectRatio = 0.38
        request.maximumAspectRatio = 1.0
        request.minimumSize = 0.16
        request.quadratureTolerance = 34

        do {
            let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .right, options: [:])
            try handler.perform([request])
            guard case .normal = trackingState else {
                updateState { state in
                    state.phase = .limited("World tracking")
                    state.instruction = "Move slowly and point the camera at a textured surface."
                }
                return
            }
            let observations = request.results ?? []
            DispatchQueue.main.async { [weak self] in
                self?.handle(observations: observations, frame: frame, cameraTransform: cameraTransform)
            }
        } catch {
            updateState { state in
                state.phase = .scanning
                state.instruction = "No paper detected. Keep the whole sheet visible and improve the lighting."
            }
        }
    }

    private func handle(
        observations: [VNRectangleObservation],
        frame: ARFrame,
        cameraTransform: simd_float4x4
    ) {
        guard let arView, lockedAnchor == nil else { return }
        let viewport = arView.bounds.size
        guard viewport.width > 0, viewport.height > 0 else { return }
        let orientation = arView.window?.windowScene?.interfaceOrientation ?? .portrait
        let displayTransform = frame.displayTransform(for: orientation, viewportSize: viewport)

        var candidates: [PaperCandidate] = []
        var sawIncomplete = false
        for observation in observations {
            let visionCorners = [observation.topLeft, observation.topRight, observation.bottomRight, observation.bottomLeft]
            let screenCorners = visionCorners.map { point -> CGPoint in
                let imagePoint = CGPoint(x: point.x, y: 1 - point.y)
                let normalized = imagePoint.applying(displayTransform)
                return CGPoint(x: normalized.x * viewport.width, y: normalized.y * viewport.height)
            }

            let margin = max(18, min(viewport.width, viewport.height) * 0.035)
            let fullyVisible = screenCorners.allSatisfy {
                $0.x >= margin && $0.x <= viewport.width - margin && $0.y >= margin && $0.y <= viewport.height - margin
            }
            if !fullyVisible {
                sawIncomplete = true
                continue
            }

            guard let candidate = makeWorldCandidate(
                screenCorners: screenCorners,
                viewport: viewport,
                confidence: observation.confidence,
                cameraTransform: cameraTransform
            ) else { continue }
            candidates.append(candidate)
        }

        guard let best = candidates.max(by: { $0.confidence < $1.confidence }) else {
            lastCandidate = nil
            stableFrames = 0
            updateState { state in
                state.phase = sawIncomplete ? .incomplete : .scanning
                state.instruction = sawIncomplete
                    ? "Move the phone back until every paper edge and all four corners are visible."
                    : "No paper detected. Show a complete sheet against a contrasting surface."
                state.rectanglePoints = []
                state.confidence = 0
                state.stableFrames = 0
            }
            return
        }

        let movement = averageDistance(best.normalizedCorners, lastCandidate?.normalizedCorners)
        let worldMovement = worldCenterDistance(best.worldCorners, lastCandidate?.worldCorners)
        stableFrames = movement < 0.018 && worldMovement < 0.025 ? min(5, stableFrames + 1) : 1
        lastCandidate = best

        updateState { [self] state in
            state.phase = self.stableFrames >= 5 ? .ready : .confirming
            state.instruction = self.stableFrames >= 5
                ? "LiDAR and ARKit agree on the sheet plane. Lock this detected paper."
                : "Hold still while ARKit confirms the same four corners in 3D."
            state.rectanglePoints = best.normalizedCorners
            state.confidence = best.confidence
            state.stableFrames = self.stableFrames
        }
    }

    private func makeWorldCandidate(
        screenCorners: [CGPoint],
        viewport: CGSize,
        confidence: VNConfidence,
        cameraTransform: simd_float4x4
    ) -> PaperCandidate? {
        guard let arView else { return nil }
        let raycastResults = screenCorners.compactMap {
            arView.raycast(from: $0, allowing: .estimatedPlane, alignment: .horizontal).first
        }
        guard raycastResults.count == 4 else { return nil }
        let worldCorners = raycastResults.map { Self.translation(of: $0.worldTransform) }
        let edgeHeights = worldCorners.map(\.y)
        guard let minimumY = edgeHeights.min(), let maximumY = edgeHeights.max(), maximumY - minimumY < 0.035 else { return nil }

        let left = (worldCorners[0] + worldCorners[3]) * 0.5
        let right = (worldCorners[1] + worldCorners[2]) * 0.5
        let top = (worldCorners[0] + worldCorners[1]) * 0.5
        let bottom = (worldCorners[3] + worldCorners[2]) * 0.5
        let width = simd_distance(left, right)
        let depth = simd_distance(top, bottom)
        guard width > 0.09, depth > 0.09, width < 1.5, depth < 1.5 else { return nil }

        let centerScreen = screenCorners.reduce(CGPoint.zero) {
            CGPoint(x: $0.x + $1.x / 4, y: $0.y + $1.y / 4)
        }
        guard let centerResult = arView.raycast(from: centerScreen, allowing: .estimatedPlane, alignment: .horizontal).first else { return nil }
        let center = Self.translation(of: centerResult.worldTransform)
        let xAxis = simd_normalize(right - left)
        var yAxis = SIMD3<Float>(centerResult.worldTransform.columns.1.x,
                                 centerResult.worldTransform.columns.1.y,
                                 centerResult.worldTransform.columns.1.z)
        if yAxis.y < 0 { yAxis *= -1 }
        yAxis = simd_normalize(yAxis)
        let zAxis = simd_normalize(simd_cross(xAxis, yAxis))
        let transform = simd_float4x4(
            SIMD4<Float>(xAxis.x, xAxis.y, xAxis.z, 0),
            SIMD4<Float>(yAxis.x, yAxis.y, yAxis.z, 0),
            SIMD4<Float>(zAxis.x, zAxis.y, zAxis.z, 0),
            SIMD4<Float>(center.x, center.y, center.z, 1)
        )

        let normalAgreement = max(0, min(1, 1 - (maximumY - minimumY) / 0.035))
        let sizeScore = max(0, min(1, min(width, depth) / 0.25))
        let cameraDistance = simd_distance(center, Self.translation(of: cameraTransform))
        let distanceScore = max(0, min(1, 1.4 - cameraDistance / 1.8))
        let combined = min(0.99, Float(confidence) * 0.58 + normalAgreement * 0.22 + sizeScore * 0.12 + distanceScore * 0.08)

        return PaperCandidate(
            normalizedCorners: screenCorners.map { CGPoint(x: $0.x / viewport.width, y: $0.y / viewport.height) },
            screenCorners: screenCorners,
            worldCorners: worldCorners,
            anchorTransform: transform,
            width: width,
            depth: depth,
            confidence: combined
        )
    }

    private func updateAnchorCounts(_ anchors: [ARAnchor], adding: Bool) {
        for anchor in anchors {
            if anchor is ARPlaneAnchor {
                if adding { planeIDs.insert(anchor.identifier) }
                else { planeIDs.remove(anchor.identifier) }
            }
            if anchor is ARMeshAnchor {
                if adding { meshIDs.insert(anchor.identifier) }
                else { meshIDs.remove(anchor.identifier) }
            }
        }
        updateState { [self] state in
            state.planeCount = self.planeIDs.count
            state.meshCount = self.meshIDs.count
        }
    }

    private func updateFeatureCount(_ count: Int) {
        DispatchQueue.main.async { [weak state] in state?.featureCount = count }
    }

    private func updateState(_ update: @escaping (AppState) -> Void) {
        DispatchQueue.main.async { [weak state] in
            guard let state else { return }
            update(state)
        }
    }

    private func averageDistance(_ first: [CGPoint], _ second: [CGPoint]?) -> CGFloat {
        guard let second, first.count == second.count else { return .infinity }
        return zip(first, second).reduce(0) { partial, pair in
            partial + hypot(pair.0.x - pair.1.x, pair.0.y - pair.1.y) / CGFloat(first.count)
        }
    }

    private func worldCenterDistance(_ first: [SIMD3<Float>], _ second: [SIMD3<Float>]?) -> Float {
        guard let second, first.count == second.count else { return .infinity }
        let firstCenter = first.reduce(SIMD3<Float>.zero, +) / Float(first.count)
        let secondCenter = second.reduce(SIMD3<Float>.zero, +) / Float(second.count)
        return simd_distance(firstCenter, secondCenter)
    }

    private static func translation(of transform: simd_float4x4) -> SIMD3<Float> {
        SIMD3<Float>(transform.columns.3.x, transform.columns.3.y, transform.columns.3.z)
    }

    private static func description(for reason: ARCamera.TrackingState.Reason) -> String {
        switch reason {
        case .excessiveMotion: return "Excessive motion"
        case .insufficientFeatures: return "Not enough visual detail"
        case .initializing: return "Initializing"
        case .relocalizing: return "Relocalizing"
        @unknown default: return "Tracking limited"
        }
    }
}
