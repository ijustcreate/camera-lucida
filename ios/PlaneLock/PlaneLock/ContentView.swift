import SwiftUI

struct ContentView: View {
    @StateObject private var state = AppState()

    var body: some View {
        ZStack {
            ARViewContainer(state: state)
                .ignoresSafeArea()

            RectangleOverlay(
                points: state.rectanglePoints,
                color: state.statusColor,
                locked: state.isLocked
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                header
                Spacer()
                readout
            }
            .padding(.horizontal, 15)
            .padding(.top, 8)
            .padding(.bottom, 10)
        }
        .background(Color.black)
        .persistentSystemOverlays(.hidden)
    }

    private var header: some View {
        HStack {
            Button(action: state.reset) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 18, weight: .medium))
                    .frame(width: 44, height: 44)
            }
            .glassButton()

            Spacer()

            Label("Plane Lock", systemImage: "viewfinder")
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .tracking(1.5)
                .textCase(.uppercase)
                .padding(.horizontal, 13)
                .frame(height: 40)
                .background(.black.opacity(0.58), in: Capsule())
                .overlay(Capsule().stroke(.white.opacity(0.13)))

            Spacer()

            HStack(spacing: 7) {
                Button(action: state.toggleMesh) {
                    Image(systemName: state.showMesh ? "cube.transparent.fill" : "cube.transparent")
                        .font(.system(size: 17, weight: .medium))
                        .frame(width: 44, height: 44)
                }
                .glassButton(active: state.showMesh)

                Button(action: state.togglePoints) {
                    Image(systemName: state.showPoints ? "smallcircle.filled.circle.fill" : "smallcircle.filled.circle")
                        .font(.system(size: 17, weight: .medium))
                        .frame(width: 44, height: 44)
                }
                .glassButton(active: state.showPoints)
            }
        }
        .foregroundStyle(.white)
    }

    private var readout: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(spacing: 9) {
                Circle()
                    .fill(state.statusColor)
                    .frame(width: 8, height: 8)
                    .shadow(color: state.statusColor.opacity(0.7), radius: 5)
                Text(state.title)
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .tracking(0.65)
                    .textCase(.uppercase)
                    .lineLimit(1)
                Spacer()
                Text("\(Int(state.confidence * 100))%")
                    .font(.system(size: 12, weight: .bold, design: .monospaced))
                    .foregroundStyle(state.statusColor)
            }

            Text(state.instruction)
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.65))
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 1) {
                metric("Planes", "\(state.planeCount)")
                metric("Mesh", "\(state.meshCount)")
                metric("Stable", state.isLocked ? "LOCK" : "\(state.stableFrames)/5")
                metric("Points", "\(state.featureCount)")
            }
            .padding(1)
            .background(.white.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))

            HStack(spacing: 8) {
                Button(action: state.lockOrFindAgain) {
                    Text(state.isLocked ? "Find new sheet" : state.canLock ? "Lock detected sheet" : "Searching for paper")
                        .font(.system(size: 13, weight: .bold))
                        .frame(maxWidth: .infinity, minHeight: 48)
                }
                .buttonStyle(.plain)
                .foregroundStyle(state.canLock || state.isLocked ? .white : .white.opacity(0.35))
                .background(state.canLock || state.isLocked ? state.statusColor.opacity(0.23) : .white.opacity(0.06), in: RoundedRectangle(cornerRadius: 13))
                .overlay(RoundedRectangle(cornerRadius: 13).stroke(state.canLock || state.isLocked ? state.statusColor.opacity(0.72) : .white.opacity(0.09)))
                .disabled(!state.canLock && !state.isLocked)

                Button("Reset", action: state.reset)
                    .font(.system(size: 12, weight: .semibold))
                    .frame(width: 78, height: 48)
                    .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 13))
                    .overlay(RoundedRectangle(cornerRadius: 13).stroke(.white.opacity(0.1)))
            }

            HStack(spacing: 12) {
                Label(state.lidarAvailable ? "LiDAR active" : "LiDAR unavailable", systemImage: "sensor.tag.radiowaves.forward")
                Label(state.depthAvailable ? "Depth active" : "Depth unavailable", systemImage: "square.3.layers.3d")
            }
            .font(.system(size: 9, weight: .semibold, design: .rounded))
            .foregroundStyle(.white.opacity(0.45))
            .textCase(.uppercase)
        }
        .padding(15)
        .background(.black.opacity(0.78), in: RoundedRectangle(cornerRadius: 22))
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(.white.opacity(0.14)))
        .background(.ultraThinMaterial.opacity(0.25), in: RoundedRectangle(cornerRadius: 22))
    }

    private func metric(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: 8, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.38))
                .textCase(.uppercase)
            Text(value)
                .font(.system(size: 12, weight: .bold, design: .monospaced))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 9)
        .frame(height: 47)
        .background(.black.opacity(0.55))
    }
}

private extension View {
    func glassButton(active: Bool = false) -> some View {
        buttonStyle(.plain)
            .background(active ? Color.orange.opacity(0.2) : Color.black.opacity(0.58), in: Circle())
            .overlay(Circle().stroke(active ? Color.orange.opacity(0.65) : Color.white.opacity(0.14)))
    }
}

