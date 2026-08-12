# Plane Lock — Native ARKit + LiDAR

This is the native iPhone version. Unlike the browser fallback, it has direct access to:

- ARKit six-degree-of-freedom world tracking
- LiDAR scene reconstruction and classified mesh anchors
- ARKit scene depth and smoothed scene depth
- horizontal plane anchors and 3D raycasts
- Vision rectangle detection for identifying a complete sheet
- RealityKit world anchors that keep the mapped paper plane fixed as the phone moves

## Detection and locking sequence

1. ARKit starts world tracking, horizontal plane detection, LiDAR mesh reconstruction, and scene depth.
2. Vision detects rectangular paper candidates in the rear-camera image.
3. The app requires every corner to be safely inside the visible camera frame.
4. It raycasts all four detected corners into ARKit's reconstructed world.
5. It rejects candidates whose four 3D corner heights do not describe one flat surface.
6. It confirms the same 2D rectangle and 3D world center for five frames.
7. **Lock detected sheet** creates a RealityKit world anchor aligned to the paper's measured width, depth, center, normal, and rotation.

The cube button shows or hides the LiDAR scene-understanding mesh. The point button shows or hides ARKit's world feature points.

## Generate and build on a Mac

```sh
brew install xcodegen
cd ios/PlaneLock
xcodegen generate
open PlaneLock.xcodeproj
```

Choose your Apple development team in Signing & Capabilities, connect the iPhone, and run.

## Build without a modern Mac

The repository's **Native iOS Build** GitHub Action runs Xcode on a hosted macOS machine. It validates both the simulator build and the real-device architecture, then publishes an unsigned IPA artifact.

An unsigned IPA proves the native app compiles but cannot be opened by an ordinary iPhone. For a clean over-the-internet install through TestFlight, the project still needs an Apple Developer Program membership, signing certificate, provisioning profile, and App Store Connect record. Those credentials should be stored as encrypted GitHub secrets and never committed to the repository.

