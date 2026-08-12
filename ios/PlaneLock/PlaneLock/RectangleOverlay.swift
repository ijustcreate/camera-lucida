import SwiftUI

struct RectangleOverlay: View {
    let points: [CGPoint]
    let color: Color
    let locked: Bool

    var body: some View {
        GeometryReader { geometry in
            if points.count == 4 {
                Canvas { context, size in
                    let scaled = points.map { CGPoint(x: $0.x * size.width, y: $0.y * size.height) }
                    var outline = Path()
                    outline.move(to: scaled[0])
                    for point in scaled.dropFirst() { outline.addLine(to: point) }
                    outline.closeSubpath()
                    context.stroke(outline, with: .color(color), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))

                    for step in 1..<5 {
                        let amount = CGFloat(step) / 5
                        var horizontal = Path()
                        horizontal.move(to: interpolate(scaled[0], scaled[3], amount))
                        horizontal.addLine(to: interpolate(scaled[1], scaled[2], amount))
                        context.stroke(horizontal, with: .color(color.opacity(0.28)), lineWidth: 1)

                        var vertical = Path()
                        vertical.move(to: interpolate(scaled[0], scaled[1], amount))
                        vertical.addLine(to: interpolate(scaled[3], scaled[2], amount))
                        context.stroke(vertical, with: .color(color.opacity(0.28)), lineWidth: 1)
                    }
                }
                .overlay {
                    ForEach(Array(points.enumerated()), id: \.offset) { index, point in
                        Text("\(index + 1)")
                            .font(.system(size: 10, weight: .bold, design: .rounded))
                            .foregroundStyle(color)
                            .frame(width: 24, height: 24)
                            .background(.black.opacity(0.78), in: Circle())
                            .overlay(Circle().stroke(color, lineWidth: 2))
                            .position(x: point.x * geometry.size.width, y: point.y * geometry.size.height)
                    }
                }
                .shadow(color: color.opacity(locked ? 0.45 : 0.2), radius: locked ? 9 : 3)
            }
        }
        .allowsHitTesting(false)
    }

    private func interpolate(_ first: CGPoint, _ second: CGPoint, _ amount: CGFloat) -> CGPoint {
        CGPoint(x: first.x + (second.x - first.x) * amount,
                y: first.y + (second.y - first.y) * amount)
    }
}

