# Lucida

A camera-lucida-style tracing viewer for iPhone. It is made for drawing on real paper while looking through the phone.

## Use it

1. Open the tracing camera and allow access to the back camera.
2. Add an overlay from Photos, or capture the current camera view as an overlay.
3. Drag the overlay with one finger and pinch with two fingers to line it up with the paper beneath your phone.
4. Use the opacity slider to see the live camera through the image, then lock it in place before drawing on paper.

## Smart paper anchor

After you have lined up an overlay, tap **Set paper anchor**. Lucida saves a small, private visual fingerprint of the live camera view and uses it to compensate for small camera shifts while the same flat, textured paper surface remains visible. The fingerprint and calibration stay only on that iPhone until you clear them; it does not save or upload the camera image.

This is a browser-based visual stabilizer, not ARKit world tracking. It works best with a desk, paper edges, tape, or other visible detail, and should be reset after a large movement, lighting change, or a different surface.

The reference image and camera stay in your browser; no photo is uploaded to a server.
