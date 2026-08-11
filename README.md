# Plane Lock

Plane Lock is a camera-first paper detector and planar tracker for iPhone Safari. It contains no drawing or tracing tools.

## What the vision pipeline does

1. Crops the rear-camera image to exactly match the visible screen.
2. Calculates a grayscale image and dynamic contrast statistics.
3. Runs Gaussian smoothing and Canny edge detection.
4. Closes small edge gaps and extracts contours.
5. Uses Douglas-Peucker polygon fitting to find convex four-corner candidates.
6. Scores candidate area, contour fill, corner angles, brightness contrast, page aspect, and distance from every screen edge.
7. Rejects partial sheets and asks for the whole paper to be visible.
8. Confirms the same four corners across five consecutive frames before enabling **Lock detected sheet**.
9. After locking, tracks Shi-Tomasi feature points with pyramidal Lucas-Kanade optical flow and recalculates the paper homography with RANSAC.

Tap **Vision** to show or hide the live Canny edge samples, candidate contours, numbered paper corners, and tracking points.

## Browser limitation

This is a browser-based planar visual lock. It estimates the sheet position and perspective in the current camera image. It is not an ARKit world anchor and cannot retain a true device-level 3D anchor after the paper and surrounding scene fully leave the camera view.
