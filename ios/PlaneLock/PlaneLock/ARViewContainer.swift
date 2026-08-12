import RealityKit
import SwiftUI

struct ARViewContainer: UIViewRepresentable {
    @ObservedObject var state: AppState

    final class Coordinator {
        var controller: PaperARController?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> ARView {
        let arView = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
        arView.renderOptions.insert(.disableMotionBlur)
        let controller = PaperARController(arView: arView, state: state)
        context.coordinator.controller = controller
        state.controller = controller
        controller.start()
        return arView
    }

    func updateUIView(_ uiView: ARView, context: Context) {
        context.coordinator.controller?.updateDebugOptions()
    }

    static func dismantleUIView(_ uiView: ARView, coordinator: Coordinator) {
        coordinator.controller?.stop()
        coordinator.controller = nil
    }
}

