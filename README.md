# Lucida

A camera-lucida-style tracing viewer for iPhone. It is made for drawing on real paper while looking through the phone.

## Use it

1. Open the tracing camera and allow access to the back camera.
2. Add an overlay from Photos, or capture the current camera view as an overlay.
3. Drag the overlay with one finger and pinch with two fingers to line it up with the paper beneath your phone.
4. Use the opacity slider to see the live camera through the image, then lock it in place before drawing on paper.

## Mapped paper plane

After you add an overlay, tap **Map paper plane** and tap the paper's four visible corners clockwise, starting at the top-left. Lucida perspective-maps the image to that physical sheet. Drag the image with one finger and pinch with two fingers to place and size it anywhere on the mapped paper.

Lucida saves a small, private visual fingerprint of the live camera view with the plane. That lets it compensate for small camera shifts while the same flat, textured surface remains visible. The calibration stays only on that iPhone until you reset it; it does not save or upload the camera image.

Tap **Nodes** in the camera header to see the natural visual features Lucida is using. Teal nodes have survived multiple frames; gold nodes are new or weaker candidates. If the surface has too few nodes, keep more paper edge, desk grain, tape, or other texture visible.

This is a browser-based visual stabilizer, not ARKit world tracking. It works best with visible paper edges, desk grain, tape, or other detail, and should be remapped after a large movement, lighting change, or a different surface.

The reference image and camera stay in your browser; no photo is uploaded to a server.
