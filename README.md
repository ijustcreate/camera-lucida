# Plane Lock

A camera-first paper-plane mapper for iPhone. It intentionally contains no tracing or drawing tools.

## Use it

1. Open the rear camera and allow access.
2. Tap **Map paper plane**.
3. Tap the paper corners in order: top-left, top-right, bottom-right, bottom-left.
4. The perspective grid becomes the mapped plane. It follows the camera view using tracked natural features.
5. Tap **Nodes** to inspect the feature points used for the current lock.

Teal nodes have survived multiple frames. Gold nodes are new or weaker candidates. A paper edge plus nearby desk grain, tape, or other texture gives the tracker the most reliable lock.

This is browser-based planar tracking: it estimates the paper’s position and perspective in the camera image with optical flow, RANSAC homography, and visual relocalization. It is not a native ARKit world anchor and will ask to relocalize or remap after large motion, a major lighting change, or if the surface leaves the camera view.
