(() => {
  const PROCESS_WIDTH = 360;
  const STABLE_FRAMES_REQUIRED = 5;
  const $ = (selector) => document.querySelector(selector);

  const ui = {
    welcome: $('#welcome'),
    scanner: $('#scanner'),
    video: $('#cameraFeed'),
    overlay: $('#visionOverlay'),
    processing: $('#processingCanvas'),
    openCamera: $('#openCameraButton'),
    cameraPermission: $('#cameraPermission'),
    restart: $('#restartButton'),
    vision: $('#visionButton'),
    fullscreen: $('#fullscreenButton'),
    readout: $('.readout'),
    status: $('#statusText'),
    confidence: $('#confidenceText'),
    instruction: $('#instructionText'),
    edges: $('#edgeCount'),
    corners: $('#cornerCount'),
    stability: $('#stabilityCount'),
    points: $('#pointCount'),
    lock: $('#lockButton'),
    clear: $('#clearButton'),
  };

  const state = {
    stream: null,
    cameraPromise: null,
    cv: null,
    cvPromise: null,
    running: false,
    showVision: true,
    lastProcessAt: 0,
    lastDetectionAt: 0,
    detection: null,
    previousCorners: null,
    smoothedCorners: null,
    stableFrames: 0,
    locked: false,
    lockedCorners: null,
    tracker: null,
    pendingTracker: false,
    trackingState: 'idle',
    trackingConfidence: 0,
    cameraError: false,
    frameError: null,
  };

  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

  function showScanner() {
    ui.welcome.hidden = true;
    ui.scanner.hidden = false;
    resizeCanvases();
  }

  function hasCamera() {
    return Boolean(state.stream && ui.video.videoWidth && ui.video.videoHeight);
  }

  function setReadoutClass(name) {
    ui.readout.classList.remove('is-searching', 'is-ready', 'is-locked', 'is-warning');
    if (name) ui.readout.classList.add(name);
  }

  function renderStatus() {
    const detection = state.detection;
    const tracker = state.tracker;
    const trackedPoints = tracker?.pointCount || 0;
    ui.points.textContent = String(trackedPoints);

    if (!hasCamera()) {
      setReadoutClass(state.cameraError ? 'is-warning' : '');
      ui.status.value = state.cameraError ? 'Camera unavailable' : 'Open camera first';
      ui.confidence.textContent = '0%';
      ui.instruction.textContent = state.cameraError
        ? 'Allow camera access in Safari settings, then tap the message in the camera view.'
        : 'Open the rear camera and show the complete sheet.';
      ui.edges.textContent = '0';
      ui.corners.textContent = '0';
      ui.stability.textContent = `0/${STABLE_FRAMES_REQUIRED}`;
      ui.lock.disabled = true;
      ui.lock.textContent = 'Searching for paper';
      return;
    }

    if (!state.cv) {
      setReadoutClass('is-searching');
      ui.status.value = state.frameError ? 'Vision engine failed' : 'Loading vision engine';
      ui.confidence.textContent = '0%';
      ui.instruction.textContent = state.frameError
        ? 'Check the internet connection and reload. The edge engine could not start.'
        : 'Camera ready. Loading edge and corner detection...';
      ui.edges.textContent = '0';
      ui.corners.textContent = '0';
      ui.stability.textContent = `0/${STABLE_FRAMES_REQUIRED}`;
      ui.lock.disabled = true;
      ui.lock.textContent = 'Loading vision';
      return;
    }

    if (state.locked) {
      const confidence = Math.round(state.trackingConfidence * 100);
      ui.edges.textContent = '4';
      ui.corners.textContent = '4';
      ui.stability.textContent = 'LOCK';
      ui.confidence.textContent = `${confidence}%`;
      ui.lock.disabled = false;
      ui.lock.textContent = 'Find new sheet';
      if (state.trackingState === 'locked') {
        setReadoutClass('is-locked');
        ui.status.value = 'Plane locked';
        ui.instruction.textContent = 'The four-corner plane is moving with the tracked surface points.';
      } else if (state.trackingState === 'recovering') {
        setReadoutClass('is-searching');
        ui.status.value = 'Recalculating plane';
        ui.instruction.textContent = 'Hold still and keep the sheet plus nearby surface detail visible.';
      } else {
        setReadoutClass('is-warning');
        ui.status.value = 'Tracking weakened';
        ui.instruction.textContent = 'Aim back at the sheet. The app is looking for its four-corner outline again.';
      }
      return;
    }

    const outline = detection?.candidate || detection?.partial || detection?.outlines?.[0];
    ui.edges.textContent = String(outline?.points?.length || 0);
    ui.corners.textContent = String(detection?.candidate || detection?.partial ? 4 : 0);
    ui.stability.textContent = `${state.stableFrames}/${STABLE_FRAMES_REQUIRED}`;
    ui.points.textContent = '0';

    if (detection?.candidate) {
      const confidence = Math.round(detection.candidate.confidence * 100);
      ui.confidence.textContent = `${confidence}%`;
      if (detection.ready) {
        setReadoutClass('is-ready');
        ui.status.value = 'Paper identified';
        ui.instruction.textContent = 'Four edges and four corners are stable. Lock this detected sheet.';
        ui.lock.disabled = false;
        ui.lock.textContent = 'Lock detected sheet';
      } else {
        setReadoutClass('is-searching');
        ui.status.value = 'Paper found - hold still';
        ui.instruction.textContent = 'Checking the same four corners across several camera frames.';
        ui.lock.disabled = true;
        ui.lock.textContent = 'Confirming corners';
      }
      return;
    }

    ui.confidence.textContent = '0%';
    ui.lock.disabled = true;
    ui.lock.textContent = 'Searching for paper';
    if (detection?.partial) {
      setReadoutClass('is-warning');
      ui.status.value = 'Whole sheet not visible';
      ui.instruction.textContent = 'Move the phone back until every paper edge and all four corners are inside the camera view.';
    } else {
      setReadoutClass('is-warning');
      ui.status.value = 'No paper detected';
      ui.instruction.textContent = 'Show the whole sheet. Add contrast between the paper and the surface underneath it.';
    }
  }

  function waitForOpenCV() {
    if (state.cvPromise) return state.cvPromise;
    state.cvPromise = new Promise((resolve, reject) => {
      const deadline = Date.now() + 25000;
      const check = async () => {
        try {
          let candidate = window.cv;
          if (candidate?.Mat && candidate?.findContours && candidate?.calcOpticalFlowPyrLK) {
            state.cv = candidate;
            resolve(true);
            return;
          }
          if (candidate && typeof candidate.then === 'function') candidate = await candidate;
          if (candidate?.Mat && candidate?.findContours && candidate?.calcOpticalFlowPyrLK) {
            state.cv = candidate;
            resolve(true);
            return;
          }
        } catch (_) {
          // The runtime can exist before its WebAssembly module is ready.
        }
        if (Date.now() >= deadline) {
          reject(new Error('OpenCV timed out'));
          return;
        }
        window.setTimeout(check, 100);
      };
      check();
    });
    return state.cvPromise;
  }

  async function startCamera() {
    showScanner();
    if (state.stream) return;
    if (state.cameraPromise) return state.cameraPromise;
    state.cameraError = false;
    renderStatus();
    if (!navigator.mediaDevices?.getUserMedia) {
      state.cameraError = true;
      ui.cameraPermission.textContent = 'This browser cannot open the camera. Use Safari on your iPhone.';
      renderStatus();
      return;
    }
    state.cameraPromise = navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    })
      .then(async (stream) => {
        state.stream = stream;
        ui.video.srcObject = stream;
        await ui.video.play();
        ui.scanner.classList.add('has-camera');
        state.running = true;
        resizeCanvases();
        renderStatus();
        requestAnimationFrame(processLoop);
        return waitForOpenCV();
      })
      .then(() => renderStatus())
      .catch((error) => {
        if (!state.stream) {
          state.cameraError = true;
          ui.cameraPermission.textContent = 'Camera permission was blocked. Tap to try again.';
        } else {
          state.frameError = error;
        }
        renderStatus();
      })
      .finally(() => { state.cameraPromise = null; });
    return state.cameraPromise;
  }

  function stopCamera() {
    state.running = false;
    state.stream?.getTracks().forEach((track) => track.stop());
    state.stream = null;
    ui.video.srcObject = null;
    releaseTracker();
  }

  function resizeCanvases() {
    if (ui.scanner.hidden) return;
    const rect = ui.scanner.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    ui.overlay.width = Math.max(1, Math.round(rect.width * ratio));
    ui.overlay.height = Math.max(1, Math.round(rect.height * ratio));
    ui.overlay.dataset.ratio = String(ratio);
    let width = PROCESS_WIDTH;
    let height = Math.round(width * rect.height / rect.width);
    if (height > 640) {
      height = 640;
      width = Math.round(height * rect.width / rect.height);
    }
    ui.processing.width = Math.max(180, width);
    ui.processing.height = Math.max(180, height);
  }

  function drawCameraCrop() {
    if (!hasCamera()) return false;
    const canvas = ui.processing;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const videoWidth = ui.video.videoWidth;
    const videoHeight = ui.video.videoHeight;
    const sourceAspect = videoWidth / videoHeight;
    const targetAspect = canvas.width / canvas.height;
    let sourceX = 0;
    let sourceY = 0;
    let sourceWidth = videoWidth;
    let sourceHeight = videoHeight;
    if (sourceAspect > targetAspect) {
      sourceWidth = videoHeight * targetAspect;
      sourceX = (videoWidth - sourceWidth) / 2;
    } else {
      sourceHeight = videoWidth / targetAspect;
      sourceY = (videoHeight - sourceHeight) / 2;
    }
    context.drawImage(ui.video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
    return true;
  }

  function polygonArea(points) {
    return Math.abs(points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length];
      return sum + point.x * next.y - next.x * point.y;
    }, 0) / 2);
  }

  function orderCorners(points) {
    const center = points.reduce((value, point) => ({ x: value.x + point.x / points.length, y: value.y + point.y / points.length }), { x: 0, y: 0 });
    const clockwise = [...points].sort((left, right) => Math.atan2(left.y - center.y, left.x - center.x) - Math.atan2(right.y - center.y, right.x - center.x));
    const start = clockwise.reduce((best, point, index) => point.x + point.y < clockwise[best].x + clockwise[best].y ? index : best, 0);
    let ordered = [...clockwise.slice(start), ...clockwise.slice(0, start)];
    if (ordered[1].x < ordered[3].x) ordered = [ordered[0], ordered[3], ordered[2], ordered[1]];
    return ordered;
  }

  function angleQuality(points) {
    let total = 0;
    for (let index = 0; index < 4; index += 1) {
      const previous = points[(index + 3) % 4];
      const current = points[index];
      const next = points[(index + 1) % 4];
      const first = { x: previous.x - current.x, y: previous.y - current.y };
      const second = { x: next.x - current.x, y: next.y - current.y };
      const denominator = Math.hypot(first.x, first.y) * Math.hypot(second.x, second.y) || 1;
      total += 1 - clamp(Math.abs((first.x * second.x + first.y * second.y) / denominator) / .72, 0, 1);
    }
    return total / 4;
  }

  function pointInPolygon(x, y, polygon) {
    let inside = false;
    for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
      const a = polygon[current];
      const b = polygon[previous];
      const crosses = (a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / ((b.y - a.y) || .00001) + a.x;
      if (crosses) inside = !inside;
    }
    return inside;
  }

  function polygonLuminance(gray, points) {
    const minimumX = Math.max(0, Math.floor(Math.min(...points.map((point) => point.x))));
    const maximumX = Math.min(gray.cols - 1, Math.ceil(Math.max(...points.map((point) => point.x))));
    const minimumY = Math.max(0, Math.floor(Math.min(...points.map((point) => point.y))));
    const maximumY = Math.min(gray.rows - 1, Math.ceil(Math.max(...points.map((point) => point.y))));
    let sum = 0;
    let count = 0;
    for (let y = minimumY; y <= maximumY; y += 4) {
      for (let x = minimumX; x <= maximumX; x += 4) {
        if (!pointInPolygon(x, y, points)) continue;
        sum += gray.data[y * gray.cols + x];
        count += 1;
      }
    }
    return count ? sum / count : 0;
  }

  function imageStats(gray) {
    let sum = 0;
    let squareSum = 0;
    let count = 0;
    for (let index = 0; index < gray.data.length; index += 3) {
      const value = gray.data[index];
      sum += value;
      squareSum += value * value;
      count += 1;
    }
    const mean = sum / Math.max(1, count);
    return { mean, deviation: Math.sqrt(Math.max(0, squareSum / Math.max(1, count) - mean * mean)) };
  }

  function evaluateQuad(points, contourArea, gray, statistics, source) {
    const width = gray.cols;
    const height = gray.rows;
    const ordered = orderCorners(points);
    const area = polygonArea(ordered);
    const areaRatio = area / (width * height);
    const sides = ordered.map((point, index) => Math.hypot(point.x - ordered[(index + 1) % 4].x, point.y - ordered[(index + 1) % 4].y));
    const minimumSide = Math.min(...sides) / Math.min(width, height);
    const margin = Math.min(...ordered.flatMap((point) => [point.x, width - point.x, point.y, height - point.y])) / Math.min(width, height);
    const fill = Math.min(1, Math.abs(contourArea) / Math.max(1, area));
    const angles = angleQuality(ordered);
    const paperMean = polygonLuminance(gray, ordered);
    const brightness = clamp(.5 + (paperMean - statistics.mean) / (statistics.deviation * 2 + 1), 0, 1);
    const averageWidth = (sides[0] + sides[2]) / 2;
    const averageHeight = (sides[1] + sides[3]) / 2;
    const aspect = averageWidth / Math.max(1, averageHeight);
    const aspectQuality = aspect >= .42 && aspect <= 2.4 ? 1 : clamp(1 - Math.min(Math.abs(aspect - .42), Math.abs(aspect - 2.4)), 0, 1);
    const geometryValid = areaRatio >= .07 && areaRatio <= .9 && minimumSide >= .16 && fill >= .66 && angles >= .27;
    const fullSheet = margin >= .026;
    const areaQuality = clamp((areaRatio - .07) / .45, 0, 1);
    const marginQuality = clamp(margin / .09, 0, 1);
    const confidence = clamp(.18 + areaQuality * .19 + fill * .19 + angles * .2 + brightness * .13 + aspectQuality * .05 + marginQuality * .06, 0, .99);
    return {
      points: ordered.map((point) => ({ x: point.x / width, y: point.y / height })),
      pixelPoints: ordered,
      confidence,
      areaRatio,
      margin,
      geometryValid,
      fullSheet,
      source,
    };
  }

  function collectContours(binary, gray, statistics, source) {
    const cv = state.cv;
    const work = binary.clone();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    const quads = [];
    const outlines = [];
    try {
      cv.findContours(work, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (let index = 0; index < contours.size(); index += 1) {
        const contour = contours.get(index);
        const contourArea = Math.abs(cv.contourArea(contour, false));
        const areaRatio = contourArea / (gray.cols * gray.rows);
        if (areaRatio < .045 || areaRatio > .94) { contour.delete(); continue; }
        const perimeter = cv.arcLength(contour, true);
        let recordedOutline = false;
        for (const precision of [.012, .018, .024, .032, .042]) {
          const approximation = new cv.Mat();
          cv.approxPolyDP(contour, approximation, perimeter * precision, true);
          const vertexCount = approximation.rows;
          if (!recordedOutline && vertexCount >= 3 && vertexCount <= 8) {
            const outlinePoints = [];
            for (let point = 0; point < vertexCount; point += 1) outlinePoints.push({ x: approximation.data32S[point * 2] / gray.cols, y: approximation.data32S[point * 2 + 1] / gray.rows });
            outlines.push({ points: outlinePoints, areaRatio, source });
            recordedOutline = true;
          }
          if (vertexCount === 4 && cv.isContourConvex(approximation)) {
            const points = [];
            for (let point = 0; point < 4; point += 1) points.push({ x: approximation.data32S[point * 2], y: approximation.data32S[point * 2 + 1] });
            const evaluated = evaluateQuad(points, contourArea, gray, statistics, source);
            if (evaluated.geometryValid) quads.push(evaluated);
            approximation.delete();
            break;
          }
          approximation.delete();
        }
        contour.delete();
      }
    } finally {
      work.delete();
      contours.delete();
      hierarchy.delete();
    }
    return { quads, outlines };
  }

  function sampleEdges(edges) {
    const points = [];
    const step = 3;
    for (let y = 1; y < edges.rows - 1; y += step) {
      for (let x = 1; x < edges.cols - 1; x += step) {
        if (edges.data[y * edges.cols + x] > 0) points.push({ x: x / edges.cols, y: y / edges.rows });
        if (points.length >= 2400) return points;
      }
    }
    return points;
  }

  function analyzeFrame(rgba) {
    const cv = state.cv;
    const gray = new cv.Mat();
    const blurred = new cv.Mat();
    const edges = new cv.Mat();
    const edgeClosed = new cv.Mat();
    const bright = new cv.Mat();
    const brightClosed = new cv.Mat();
    const edgeKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    const brightKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
    try {
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
      const statistics = imageStats(blurred);
      const low = clamp(statistics.mean - statistics.deviation * .72, 24, 105);
      const high = clamp(statistics.mean + statistics.deviation * 1.08, 68, 225);
      cv.Canny(blurred, edges, low, high, 3, true);
      cv.morphologyEx(edges, edgeClosed, cv.MORPH_CLOSE, edgeKernel, new cv.Point(-1, -1), 2);
      const threshold = clamp(statistics.mean + Math.max(4, statistics.deviation * .1), 45, 245);
      cv.threshold(blurred, bright, threshold, 255, cv.THRESH_BINARY);
      cv.morphologyEx(bright, brightClosed, cv.MORPH_CLOSE, brightKernel, new cv.Point(-1, -1), 2);

      const edgeResult = collectContours(edgeClosed, blurred, statistics, 'edge');
      const brightResult = collectContours(brightClosed, blurred, statistics, 'brightness');
      const allQuads = [...edgeResult.quads, ...brightResult.quads].sort((left, right) => right.confidence - left.confidence);
      const full = allQuads.find((quad) => quad.fullSheet && quad.confidence >= .54) || null;
      const partial = allQuads.find((quad) => !quad.fullSheet && quad.confidence >= .5) || null;
      const outlines = [...edgeResult.outlines, ...brightResult.outlines].sort((left, right) => right.areaRatio - left.areaRatio).slice(0, 7);
      return {
        candidate: full,
        partial,
        outlines,
        edgePoints: sampleEdges(edges),
        edgePixelCount: cv.countNonZero(edges),
      };
    } finally {
      gray.delete();
      blurred.delete();
      edges.delete();
      edgeClosed.delete();
      bright.delete();
      brightClosed.delete();
      edgeKernel.delete();
      brightKernel.delete();
    }
  }

  function cornerDistance(left, right) {
    if (!left || !right) return Infinity;
    return left.reduce((sum, point, index) => sum + Math.hypot(point.x - right[index].x, point.y - right[index].y), 0) / 4;
  }

  function updateDetection(result) {
    if (result.candidate) {
      const shift = cornerDistance(result.candidate.points, state.previousCorners);
      if (shift < .035) state.stableFrames = Math.min(STABLE_FRAMES_REQUIRED, state.stableFrames + 1);
      else state.stableFrames = 1;
      if (shift < .08 && state.smoothedCorners) {
        state.smoothedCorners = result.candidate.points.map((point, index) => ({
          x: state.smoothedCorners[index].x * .62 + point.x * .38,
          y: state.smoothedCorners[index].y * .62 + point.y * .38,
        }));
      } else {
        state.smoothedCorners = result.candidate.points.map((point) => ({ ...point }));
      }
      state.previousCorners = result.candidate.points.map((point) => ({ ...point }));
      result.candidate.points = state.smoothedCorners.map((point) => ({ ...point }));
      result.ready = state.stableFrames >= STABLE_FRAMES_REQUIRED;
    } else {
      state.stableFrames = 0;
      state.previousCorners = null;
      state.smoothedCorners = null;
      result.ready = false;
    }
    state.detection = result;
    renderStatus();
  }

  function expandedQuad(corners, amount = 1.12) {
    const center = corners.reduce((value, point) => ({ x: value.x + point.x / 4, y: value.y + point.y / 4 }), { x: 0, y: 0 });
    return corners.map((point) => ({
      x: clamp(center.x + (point.x - center.x) * amount, 0, 1),
      y: clamp(center.y + (point.y - center.y) * amount, 0, 1),
    }));
  }

  function findTrackingPoints(gray, corners) {
    const cv = state.cv;
    const mask = cv.Mat.zeros(gray.rows, gray.cols, cv.CV_8UC1);
    const expanded = expandedQuad(corners);
    const polygon = cv.matFromArray(4, 1, cv.CV_32SC2, expanded.flatMap((point) => [Math.round(point.x * gray.cols), Math.round(point.y * gray.rows)]));
    const points = new cv.Mat();
    cv.fillConvexPoly(mask, polygon, new cv.Scalar(255));
    cv.goodFeaturesToTrack(gray, points, 180, .008, 7, mask, 3, false, .04);
    polygon.delete();
    mask.delete();
    if (points.rows >= 10) return points;
    points.delete();
    const fallback = new cv.Mat();
    const emptyMask = new cv.Mat();
    cv.goodFeaturesToTrack(gray, fallback, 180, .008, 7, emptyMask, 3, false, .04);
    emptyMask.delete();
    return fallback;
  }

  function initializeTracker(rgba) {
    releaseTracker();
    const cv = state.cv;
    const gray = new cv.Mat();
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    const points = findTrackingPoints(gray, state.lockedCorners);
    state.tracker = {
      previousGray: gray,
      previousPoints: points,
      pointCount: points.rows,
      failures: 0,
      frame: 0,
      nodes: Array.from({ length: points.rows }, (_, index) => ({ x: points.data32F[index * 2] / gray.cols, y: points.data32F[index * 2 + 1] / gray.rows })),
    };
    state.pendingTracker = false;
    state.trackingState = points.rows >= 8 ? 'recovering' : 'weak';
    state.trackingConfidence = points.rows >= 8 ? .35 : 0;
  }

  function releaseTracker() {
    state.tracker?.previousGray?.delete();
    state.tracker?.previousPoints?.delete();
    state.tracker = null;
  }

  function projectWithHomography(matrix, point) {
    const data = matrix.data64F?.length ? matrix.data64F : matrix.data32F;
    const denominator = data[6] * point.x + data[7] * point.y + data[8];
    if (!Number.isFinite(denominator) || Math.abs(denominator) < .000001) return null;
    return {
      x: (data[0] * point.x + data[1] * point.y + data[2]) / denominator,
      y: (data[3] * point.x + data[4] * point.y + data[5]) / denominator,
    };
  }

  function trackingFailure(currentGray) {
    const tracker = state.tracker;
    tracker.failures += 1;
    tracker.previousGray.delete();
    tracker.previousPoints.delete();
    tracker.previousGray = currentGray;
    tracker.previousPoints = findTrackingPoints(currentGray, state.lockedCorners);
    tracker.pointCount = tracker.previousPoints.rows;
    tracker.nodes = Array.from({ length: tracker.pointCount }, (_, index) => ({ x: tracker.previousPoints.data32F[index * 2] / currentGray.cols, y: tracker.previousPoints.data32F[index * 2 + 1] / currentGray.rows }));
    state.trackingConfidence = 0;
    state.trackingState = tracker.failures >= 3 ? 'weak' : 'recovering';
  }

  function trackFrame(rgba) {
    const cv = state.cv;
    if (state.pendingTracker || !state.tracker) initializeTracker(rgba);
    const tracker = state.tracker;
    if (!tracker || tracker.previousPoints.rows < 8) {
      const current = new cv.Mat();
      cv.cvtColor(rgba, current, cv.COLOR_RGBA2GRAY);
      trackingFailure(current);
      return;
    }

    const currentGray = new cv.Mat();
    const nextPoints = new cv.Mat();
    const status = new cv.Mat();
    const errors = new cv.Mat();
    cv.cvtColor(rgba, currentGray, cv.COLOR_RGBA2GRAY);
    cv.calcOpticalFlowPyrLK(
      tracker.previousGray,
      currentGray,
      tracker.previousPoints,
      nextPoints,
      status,
      errors,
      new cv.Size(21, 21),
      3,
      new cv.TermCriteria(cv.TermCriteria_COUNT | cv.TermCriteria_EPS, 30, .01),
      0,
      .0001,
    );

    const source = [];
    const destination = [];
    for (let index = 0; index < tracker.previousPoints.rows; index += 1) {
      if (!status.data[index] || errors.data32F[index] > 35) continue;
      const fromX = tracker.previousPoints.data32F[index * 2];
      const fromY = tracker.previousPoints.data32F[index * 2 + 1];
      const toX = nextPoints.data32F[index * 2];
      const toY = nextPoints.data32F[index * 2 + 1];
      if (toX < 1 || toY < 1 || toX >= currentGray.cols - 1 || toY >= currentGray.rows - 1) continue;
      source.push({ x: fromX, y: fromY });
      destination.push({ x: toX, y: toY });
    }
    nextPoints.delete();
    status.delete();
    errors.delete();

    if (source.length < 8) {
      trackingFailure(currentGray);
      return;
    }

    const sourceMat = cv.matFromArray(source.length, 1, cv.CV_32FC2, source.flatMap((point) => [point.x, point.y]));
    const destinationMat = cv.matFromArray(destination.length, 1, cv.CV_32FC2, destination.flatMap((point) => [point.x, point.y]));
    const homography = cv.findHomography(sourceMat, destinationMat, cv.RANSAC, 3);
    sourceMat.delete();
    destinationMat.delete();
    if (!homography || homography.empty()) {
      homography?.delete();
      trackingFailure(currentGray);
      return;
    }

    const inlierDestinations = [];
    for (let index = 0; index < source.length; index += 1) {
      const projected = projectWithHomography(homography, source[index]);
      if (projected && Math.hypot(projected.x - destination[index].x, projected.y - destination[index].y) <= 3.2) inlierDestinations.push(destination[index]);
    }
    const inlierRatio = inlierDestinations.length / source.length;
    const projectedCorners = state.lockedCorners.map((point) => projectWithHomography(homography, { x: point.x * currentGray.cols, y: point.y * currentGray.rows }))
      .map((point) => point && ({ x: point.x / currentGray.cols, y: point.y / currentGray.rows }));
    homography.delete();
    const validCorners = projectedCorners.every(Boolean)
      && polygonArea(projectedCorners) >= .035
      && polygonArea(projectedCorners) <= 1.05
      && projectedCorners.every((point) => point.x > -.15 && point.x < 1.15 && point.y > -.15 && point.y < 1.15)
      && cornerDistance(projectedCorners, state.lockedCorners) < .16;

    if (inlierDestinations.length < 8 || inlierRatio < .42 || !validCorners) {
      trackingFailure(currentGray);
      return;
    }

    state.lockedCorners = projectedCorners;
    tracker.previousGray.delete();
    tracker.previousPoints.delete();
    tracker.previousGray = currentGray;
    tracker.previousPoints = cv.matFromArray(inlierDestinations.length, 1, cv.CV_32FC2, inlierDestinations.flatMap((point) => [point.x, point.y]));
    tracker.pointCount = inlierDestinations.length;
    tracker.nodes = inlierDestinations.map((point) => ({ x: point.x / currentGray.cols, y: point.y / currentGray.rows }));
    tracker.failures = 0;
    tracker.frame += 1;
    if (tracker.pointCount < 45 || tracker.frame % 30 === 0) {
      tracker.previousPoints.delete();
      tracker.previousPoints = findTrackingPoints(currentGray, state.lockedCorners);
      tracker.pointCount = tracker.previousPoints.rows;
      tracker.nodes = Array.from({ length: tracker.pointCount }, (_, index) => ({ x: tracker.previousPoints.data32F[index * 2] / currentGray.cols, y: tracker.previousPoints.data32F[index * 2 + 1] / currentGray.rows }));
    }
    state.trackingConfidence = clamp(inlierRatio * .72 + Math.min(1, tracker.pointCount / 75) * .28, 0, .99);
    state.trackingState = state.trackingConfidence >= .55 ? 'locked' : 'recovering';
  }

  function lockDetectedSheet() {
    if (state.locked) {
      resetSheet();
      return;
    }
    if (!state.detection?.ready || !state.detection.candidate) return;
    state.locked = true;
    state.lockedCorners = state.detection.candidate.points.map((point) => ({ ...point }));
    state.pendingTracker = true;
    state.trackingState = 'recovering';
    state.trackingConfidence = .35;
    renderStatus();
    drawOverlay();
  }

  function resetSheet() {
    releaseTracker();
    state.locked = false;
    state.lockedCorners = null;
    state.pendingTracker = false;
    state.trackingState = 'idle';
    state.trackingConfidence = 0;
    state.detection = null;
    state.previousCorners = null;
    state.smoothedCorners = null;
    state.stableFrames = 0;
    state.lastDetectionAt = 0;
    renderStatus();
    drawOverlay();
  }

  function canvasPoint(point) {
    const rect = ui.scanner.getBoundingClientRect();
    return { x: point.x * rect.width, y: point.y * rect.height };
  }

  function pathPolygon(context, points) {
    const first = canvasPoint(points[0]);
    context.beginPath();
    context.moveTo(first.x, first.y);
    for (let index = 1; index < points.length; index += 1) {
      const point = canvasPoint(points[index]);
      context.lineTo(point.x, point.y);
    }
    context.closePath();
  }

  function drawGrid(context, corners, color) {
    const points = corners.map(canvasPoint);
    context.save();
    context.strokeStyle = color;
    context.lineWidth = 1;
    for (let step = 1; step < 5; step += 1) {
      const amount = step / 5;
      const left = { x: points[0].x + (points[3].x - points[0].x) * amount, y: points[0].y + (points[3].y - points[0].y) * amount };
      const right = { x: points[1].x + (points[2].x - points[1].x) * amount, y: points[1].y + (points[2].y - points[1].y) * amount };
      const top = { x: points[0].x + (points[1].x - points[0].x) * amount, y: points[0].y + (points[1].y - points[0].y) * amount };
      const bottom = { x: points[3].x + (points[2].x - points[3].x) * amount, y: points[3].y + (points[2].y - points[3].y) * amount };
      context.beginPath(); context.moveTo(left.x, left.y); context.lineTo(right.x, right.y); context.stroke();
      context.beginPath(); context.moveTo(top.x, top.y); context.lineTo(bottom.x, bottom.y); context.stroke();
    }
    context.restore();
  }

  function drawCornerMarkers(context, corners, color) {
    corners.forEach((corner, index) => {
      const point = canvasPoint(corner);
      context.beginPath();
      context.arc(point.x, point.y, 11, 0, Math.PI * 2);
      context.fillStyle = 'rgba(8,10,9,.82)';
      context.fill();
      context.lineWidth = 2;
      context.strokeStyle = color;
      context.stroke();
      context.fillStyle = color;
      context.font = '700 10px system-ui';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(String(index + 1), point.x, point.y + .5);
    });
  }

  function drawOverlay() {
    const context = ui.overlay.getContext('2d');
    const rect = ui.scanner.getBoundingClientRect();
    const ratio = Number(ui.overlay.dataset.ratio || 1);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    const detection = state.detection;

    if (state.showVision && detection?.edgePoints) {
      context.fillStyle = 'rgba(127,220,255,.33)';
      for (const edge of detection.edgePoints) context.fillRect(edge.x * rect.width, edge.y * rect.height, 1.2, 1.2);
      context.lineWidth = 1;
      context.setLineDash([4, 7]);
      context.strokeStyle = 'rgba(230,199,162,.2)';
      for (const outline of detection.outlines || []) {
        if (outline.points.length < 3) continue;
        pathPolygon(context, outline.points);
        context.stroke();
      }
      context.setLineDash([]);
    }

    if (state.lockedCorners) {
      drawGrid(context, state.lockedCorners, 'rgba(110,231,189,.28)');
      pathPolygon(context, state.lockedCorners);
      context.lineWidth = 3;
      context.strokeStyle = '#6ee7bd';
      context.stroke();
      drawCornerMarkers(context, state.lockedCorners, '#6ee7bd');
      if (state.showVision && state.tracker?.nodes) {
        for (const node of state.tracker.nodes) {
          context.beginPath();
          context.arc(node.x * rect.width, node.y * rect.height, 3.1, 0, Math.PI * 2);
          context.fillStyle = 'rgba(110,231,189,.88)';
          context.fill();
          context.lineWidth = 1;
          context.strokeStyle = 'rgba(3,20,14,.9)';
          context.stroke();
        }
      }
      return;
    }

    const target = detection?.candidate || detection?.partial;
    if (!target) return;
    const ready = Boolean(detection?.ready);
    const partial = !detection?.candidate;
    const color = partial ? '#ff806e' : ready ? '#6ee7bd' : '#f4b860';
    drawGrid(context, target.points, partial ? 'rgba(255,128,110,.17)' : 'rgba(244,184,96,.2)');
    pathPolygon(context, target.points);
    context.lineWidth = 3;
    context.strokeStyle = color;
    context.stroke();
    drawCornerMarkers(context, target.points, color);
  }

  function processLoop(timestamp) {
    if (!state.running) return;
    requestAnimationFrame(processLoop);
    const interval = state.locked ? 90 : 145;
    if (!state.cv || !hasCamera() || timestamp - state.lastProcessAt < interval) return;
    state.lastProcessAt = timestamp;
    if (!drawCameraCrop()) return;
    let rgba = null;
    try {
      rgba = state.cv.imread(ui.processing);
      if (state.locked) {
        trackFrame(rgba);
        if (timestamp - state.lastDetectionAt >= 650) {
          state.lastDetectionAt = timestamp;
          const result = analyzeFrame(rgba);
          result.ready = false;
          state.detection = result;
        }
      } else {
        updateDetection(analyzeFrame(rgba));
      }
      state.frameError = null;
    } catch (error) {
      state.frameError = error;
      console.error('Plane Lock vision frame failed:', error);
    } finally {
      rgba?.delete();
    }
    renderStatus();
    drawOverlay();
  }

  function toggleVision() {
    state.showVision = !state.showVision;
    ui.vision.setAttribute('aria-pressed', String(state.showVision));
    drawOverlay();
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) await (document.exitFullscreen?.() || document.webkitExitFullscreen?.());
      else await (ui.scanner.requestFullscreen?.() || ui.scanner.webkitRequestFullscreen?.());
    } catch (_) {
      // Installed web-app mode is the fullscreen fallback on iPhone.
    }
  }

  ui.openCamera.addEventListener('click', startCamera);
  ui.cameraPermission.addEventListener('click', startCamera);
  ui.restart.addEventListener('click', resetSheet);
  ui.clear.addEventListener('click', resetSheet);
  ui.lock.addEventListener('click', lockDetectedSheet);
  ui.vision.addEventListener('click', toggleVision);
  ui.fullscreen.addEventListener('click', toggleFullscreen);
  window.addEventListener('resize', () => { resizeCanvases(); drawOverlay(); });
  window.addEventListener('pagehide', stopCamera);

  window.__planeLock = {
    getState: () => ({
      status: ui.status.value,
      stableFrames: state.stableFrames,
      ready: Boolean(state.detection?.ready),
      locked: state.locked,
      corners: (state.lockedCorners || state.detection?.candidate?.points || []).map((point) => ({ ...point })),
      trackingPoints: state.tracker?.pointCount || 0,
    }),
  };

  if (['localhost', '127.0.0.1'].includes(window.location.hostname)) {
    window.__planeLock.testCanvas = async (canvas, frames = STABLE_FRAMES_REQUIRED) => {
      await waitForOpenCV();
      let summary = null;
      for (let frame = 0; frame < frames; frame += 1) {
        const rgba = state.cv.imread(canvas);
        const result = analyzeFrame(rgba);
        rgba.delete();
        updateDetection(result);
        summary = {
          candidate: Boolean(result.candidate),
          partial: Boolean(result.partial),
          corners: result.candidate?.points || result.partial?.points || [],
          confidence: result.candidate?.confidence || result.partial?.confidence || 0,
          edgePixels: result.edgePixelCount,
          outlineCount: result.outlines.length,
        };
      }
      drawOverlay();
      return { ...summary, stableFrames: state.stableFrames, ready: Boolean(state.detection?.ready) };
    };
    window.__planeLock.testTrackingCanvases = async (firstCanvas, secondCanvas, corners) => {
      await waitForOpenCV();
      releaseTracker();
      state.locked = true;
      state.lockedCorners = corners.map((point) => ({ ...point }));
      const first = state.cv.imread(firstCanvas);
      initializeTracker(first);
      first.delete();
      const second = state.cv.imread(secondCanvas);
      trackFrame(second);
      second.delete();
      const result = {
        trackingState: state.trackingState,
        confidence: state.trackingConfidence,
        pointCount: state.tracker?.pointCount || 0,
        corners: state.lockedCorners.map((point) => ({ ...point })),
      };
      releaseTracker();
      state.locked = false;
      state.lockedCorners = null;
      state.trackingState = 'idle';
      state.trackingConfidence = 0;
      return result;
    };
  }

  renderStatus();
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./service-worker.js?v=12', { updateViaCache: 'none' }));
  }
})();
