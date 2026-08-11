# Plane Lock

A camera-first paper-plane mapper for iPhone. It intentionally contains no tracing or drawing tools.

## Use it

1. Open the rear camera and allow access.
2. The point-node overlay starts automatically while the camera looks for a sheet.
3. Put the entire paper in frame, with all four edges and some contrasting desk visible. The app outlines an identified sheet and enables **Lock detected sheet**.
4. Tap **Lock detected sheet**. The perspective grid becomes the mapped plane and follows the camera view using tracked natural features.
5. Use **Find again** to clear the current plane and search for another sheet.

Teal nodes have survived multiple frames. Gold nodes are new or weaker candidates. A paper edge plus nearby desk grain, tape, or other texture gives the tracker the most reliable lock. The detector intentionally refuses partial sheets: when it cannot see a full candidate, it says **No paper detected** and asks for the whole paper to be visible.

This is browser-based planar tracking: it estimates the paper’s position and perspective in the camera image with optical flow, RANSAC homography, and visual relocalization. It is not a native ARKit world anchor and will ask to relocalize or remap after large motion, a major lighting change, or if the surface leaves the camera view.
