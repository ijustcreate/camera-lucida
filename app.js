(() => {
  const $ = (selector) => document.querySelector(selector);
  const PLANE_SIZE = 1000;

  const ui = {
    welcome: $('#welcome'),
    studio: $('#studio'),
    stage: $('#drawingStage'),
    camera: $('#cameraFeed'),
    paperPlane: $('#paperPlane'),
    trackingOverlay: $('#trackingOverlay'),
    cameraNote: $('#cameraNote'),
    openCamera: $('#openCameraButton'),
    remapHeader: $('#remapHeaderButton'),
    nodes: $('#nodesButton'),
    fullScreen: $('#fullScreenButton'),
    map: $('#mapButton'),
    reset: $('#resetButton'),
    status: $('#planeStatus'),
    hint: $('#planeHint'),
    nodeReadout: $('#nodeReadout'),
    lockReadout: $('#lockReadout'),
  };

  const state = {
    stream: null,
    cameraStartPromise: null,
    paperPlane: null,
    candidate: null,
    tracking: false,
    trackerState: 'searching',
    confidence: 0,
    naturalTracker: null,
    showNodes: false,
    lastTrackAt: 0,
    lastDetectAt: 0,
    candidateFrames: 0,
    detector: null,
  };

  function showStudio() {
    ui.welcome.hidden = true;
    ui.studio.hidden = false;
  }

  function hasLiveCamera() {
    return Boolean(state.stream && ui.camera.videoWidth && ui.camera.videoHeight);
  }

  function isMapped() {
    return Boolean(state.paperPlane);
  }

  function setStatus() {
    const tracker = state.naturalTracker;
    const nodes = tracker?.nodes || [];
    const stable = nodes.filter((node) => node.stable).length;
    ui.nodeReadout.textContent = isMapped()
      ? `${stable} stable node${stable === 1 ? '' : 's'}`
      : `${nodes.length} live node${nodes.length === 1 ? '' : 's'}`;

    if (!hasLiveCamera()) {
      ui.status.value = 'Open camera first';
      ui.hint.textContent = 'The mapper needs the rear camera to see the paper and nearby visual detail.';
      ui.lockReadout.textContent = 'Camera off';
      ui.map.textContent = 'Looking for paper';
      ui.map.disabled = true;
      ui.reset.disabled = true;
      return;
    }

    if (!isMapped()) {
      ui.reset.disabled = false;
      if (state.candidate) {
        ui.status.value = `Paper detected - ${Math.round(state.candidate.confidence * 100)}%`;
        ui.hint.textContent = 'The outlined sheet is complete. Keep all four edges visible, then lock the identified paper.';
        ui.lockReadout.textContent = 'Ready to lock';
        ui.map.textContent = 'Lock detected sheet';
        ui.map.disabled = false;
      } else {
        ui.status.value = 'No paper detected';
        ui.hint.textContent = 'Make the whole paper visible, including all four edges. Keep a little of the desk around it in view.';
        ui.lockReadout.textContent = 'Searching for sheet';
        ui.map.textContent = 'Looking for paper';
        ui.map.disabled = true;
      }
      return;
    }

    ui.reset.disabled = false;
    ui.map.disabled = false;
    if (state.trackerState === 'locked') {
      ui.status.value = `Locked - ${Math.round(state.confidence * 100)}%`;
      ui.hint.textContent = 'The plane is being updated from natural camera features. Move slowly and keep paper edges and nearby texture in view.';
      ui.lockReadout.textContent = 'Planar lock active';
    } else if (state.trackerState === 'relocalizing') {
      ui.status.value = 'Re-finding paper...';
      ui.hint.textContent = 'The node set changed. Aim back at the mapped paper and its nearby texture.';
      ui.lockReadout.textContent = 'Relocalizing';
    } else if (state.trackerState === 'scanning') {
      ui.status.value = `${nodes.length} nodes scanning`;
      ui.hint.textContent = 'Hold still briefly while the camera selects strong paper and desk features.';
      ui.lockReadout.textContent = 'Learning surface';
    } else if (state.trackerState === 'unsupported') {
      ui.status.value = 'Feature engine unavailable';
      ui.hint.textContent = 'Reconnect to the internet, then reload so point tracking can start.';
      ui.lockReadout.textContent = 'Static plane';
    } else {
      ui.status.value = 'Lock weakened';
      ui.hint.textContent = 'Keep more texture and the paper edge visible, or find the sheet again.';
      ui.lockReadout.textContent = 'Needs detail';
    }
    ui.map.textContent = 'Find new sheet';
  }

  async function startCamera() {
    showStudio();
    if (state.stream) return;
    if (state.cameraStartPromise) return state.cameraStartPromise;
    if (!navigator.mediaDevices?.getUserMedia) {
      ui.cameraNote.textContent = 'This browser cannot open the live camera. Use Safari on your iPhone.';
      setStatus();
      return;
    }
    state.cameraStartPromise = navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    })
      .then(async (stream) => {
        state.stream = stream;
        ui.camera.srcObject = stream;
        await ui.camera.play();
        ui.studio.classList.add('has-camera');
        state.showNodes = true;
        ui.nodes.setAttribute('aria-pressed', 'true');
        ui.nodes.setAttribute('aria-label', 'Hide tracking nodes');
        startFeatureScan();
        setStatus();
      })
      .catch(() => {
        ui.cameraNote.textContent = 'Allow camera access, then tap here to search for a paper sheet.';
        setStatus();
      })
      .finally(() => { state.cameraStartPromise = null; });
    return state.cameraStartPromise;
  }

  function stopCamera() {
    state.stream?.getTracks().forEach((track) => track.stop());
    state.stream = null;
    ui.camera.srcObject = null;
    ui.studio.classList.remove('has-camera');
    state.paperPlane = null;
    state.candidate = null;
    state.tracking = false;
    state.naturalTracker = null;
    state.detector = null;
  }

  function homographyForQuad(points) {
    const [topLeft, topRight, bottomRight, bottomLeft] = points;
    const c1 = bottomRight.x - topRight.x - bottomLeft.x + topLeft.x;
    const c2 = bottomRight.y - topRight.y - bottomLeft.y + topLeft.y;
    const a1 = topRight.x - bottomRight.x;
    const b1 = bottomLeft.x - bottomRight.x;
    const a2 = topRight.y - bottomRight.y;
    const b2 = bottomLeft.y - bottomRight.y;
    const determinant = a1 * b2 - a2 * b1;
    if (Math.abs(determinant) < .0001) return null;
    const g = (c1 * b2 - c2 * b1) / determinant;
    const h = (a1 * c2 - a2 * c1) / determinant;
    return {
      a: topRight.x * (g + 1) - topLeft.x,
      b: bottomLeft.x * (h + 1) - topLeft.x,
      c: topLeft.x,
      d: topRight.y * (g + 1) - topLeft.y,
      e: bottomLeft.y * (h + 1) - topLeft.y,
      f: topLeft.y,
      g,
      h,
    };
  }

  function identityMatrix() {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }

  function multiplyMatrices(left, right) {
    const output = new Array(9).fill(0);
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        output[row * 3 + column] = left[row * 3] * right[column]
          + left[row * 3 + 1] * right[3 + column]
          + left[row * 3 + 2] * right[6 + column];
      }
    }
    const scale = output[8] || 1;
    return output.map((value) => value / scale);
  }

  function projectPoint(matrix, point) {
    const scale = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
    if (Math.abs(scale) < .000001) return null;
    return {
      x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / scale,
      y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / scale,
    };
  }

  function stagePlanePoints() {
    const plane = state.paperPlane || state.candidate;
    if (!plane) return [];
    const rect = ui.stage.getBoundingClientRect();
    const tracker = state.naturalTracker;
    if (state.paperPlane && state.tracking && tracker?.anchorQuad) {
      return tracker.anchorQuad.map((point) => {
        const projected = projectPoint(tracker.cumulative, point) || point;
        return { x: projected.x / tracker.width * rect.width, y: projected.y / tracker.height * rect.height };
      });
    }
    return plane.points.map((point) => ({ x: point.x * rect.width, y: point.y * rect.height }));
  }

  function renderPlane() {
    if (!state.paperPlane && !state.candidate) {
      ui.paperPlane.hidden = true;
      ui.paperPlane.classList.remove('is-candidate');
      return;
    }
    const homography = homographyForQuad(stagePlanePoints());
    if (!homography) return;
    const { a, b, c, d, e, f, g, h } = homography;
    ui.paperPlane.hidden = false;
    ui.paperPlane.classList.toggle('is-candidate', Boolean(state.candidate && !state.paperPlane));
    ui.paperPlane.style.transform = `matrix3d(${a / PLANE_SIZE}, ${d / PLANE_SIZE}, 0, ${g / PLANE_SIZE}, ${b / PLANE_SIZE}, ${e / PLANE_SIZE}, 0, ${h / PLANE_SIZE}, 0, 0, 1, 0, ${c}, ${f}, 0, 1)`;
  }

  function lockCandidate() {
    if (!state.candidate) return;
    state.paperPlane = { points: state.candidate.points.map((point) => ({ ...point })) };
    state.candidate = null;
    state.candidateFrames = 0;
    state.tracking = true;
    state.confidence = 0;
    state.trackerState = 'scanning';
    state.naturalTracker = null;
    renderPlane();
    const started = startNaturalTracker();
    if (!started) state.trackerState = window.jsfeat ? 'scanning' : 'unsupported';
    setStatus();
  }

  function resetPlane() {
    state.paperPlane = null;
    state.candidate = null;
    state.candidateFrames = 0;
    state.tracking = false;
    state.trackerState = 'searching';
    state.confidence = 0;
    state.naturalTracker = null;
    renderPlane();
    startFeatureScan();
    setStatus();
  }

  function createNaturalTracker() {
    const J = window.jsfeat;
    if (!J || !hasLiveCamera()) return null;
    const stage = ui.stage.getBoundingClientRect();
    let width = 260;
    let height = Math.round(width * stage.height / stage.width);
    if (height > 560) {
      height = 560;
      width = Math.round(height * stage.width / stage.height);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const type = J.U8_t | J.C1_t;
    const previousPyramid = new J.pyramid_t(3);
    const currentPyramid = new J.pyramid_t(3);
    previousPyramid.allocate(width, height, type);
    currentPyramid.allocate(width, height, type);
    J.yape06.laplacian_threshold = 28;
    J.yape06.min_eigen_value_threshold = 22;
    return {
      canvas,
      context: canvas.getContext('2d', { willReadFrequently: true }),
      width,
      height,
      grayscale: new J.matrix_t(width, height, type),
      previousPyramid,
      currentPyramid,
      corners: Array.from({ length: Math.ceil(width * height / 2) }, () => new J.keypoint_t(0, 0, 0, 0)),
      previousPoints: new Float32Array(240 * 2),
      currentPoints: new Float32Array(240 * 2),
      backwardPoints: new Float32Array(240 * 2),
      pointStatus: new Uint8Array(240),
      backwardStatus: new Uint8Array(240),
      pointStrength: new Float32Array(240),
      pointAge: new Uint16Array(240),
      pointCount: 0,
      cumulative: identityMatrix(),
      anchorQuad: null,
      nodes: [],
      failures: 0,
      frame: 0,
      keyframeCorners: [],
      keyframeDescriptors: null,
      relocalizing: false,
    };
  }

  function captureFrame(tracker) {
    const J = window.jsfeat;
    const videoWidth = ui.camera.videoWidth;
    const videoHeight = ui.camera.videoHeight;
    if (!J || !videoWidth || !videoHeight) return false;
    const sourceAspect = videoWidth / videoHeight;
    const targetAspect = tracker.width / tracker.height;
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
    tracker.context.drawImage(ui.camera, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, tracker.width, tracker.height);
    const pixels = tracker.context.getImageData(0, 0, tracker.width, tracker.height);
    J.imgproc.grayscale(pixels.data, tracker.width, tracker.height, tracker.grayscale);
    J.imgproc.gaussian_blur(tracker.grayscale, tracker.grayscale, 3, 0);
    tracker.currentPyramid.build(tracker.grayscale, true);
    return true;
  }

  function detectPoints(tracker, preserve = false) {
    const J = window.jsfeat;
    if (!J) return;
    const selected = [];
    if (preserve) {
      for (let index = 0; index < tracker.pointCount; index += 1) {
        selected.push({ x: tracker.previousPoints[index * 2], y: tracker.previousPoints[index * 2 + 1], strength: tracker.pointStrength[index], age: tracker.pointAge[index] });
      }
    }
    const found = J.yape06.detect(tracker.grayscale, tracker.corners, 12);
    const candidates = tracker.corners.slice(0, found).sort((left, right) => right.score - left.score);
    const strongest = candidates[0]?.score || 1;
    const cellSize = Math.max(24, Math.round(tracker.width / 9));
    const cells = new Set(selected.map((point) => `${Math.floor(point.x / cellSize)}:${Math.floor(point.y / cellSize)}`));
    for (const corner of candidates) {
      if (corner.x < 12 || corner.y < 12 || corner.x > tracker.width - 12 || corner.y > tracker.height - 12) continue;
      const cell = `${Math.floor(corner.x / cellSize)}:${Math.floor(corner.y / cellSize)}`;
      if (cells.has(cell) || selected.some((point) => Math.abs(point.x - corner.x) < 9 && Math.abs(point.y - corner.y) < 9)) continue;
      selected.push({ x: corner.x, y: corner.y, strength: corner.score / strongest, age: 1 });
      cells.add(cell);
      if (selected.length >= 240) break;
    }
    tracker.pointCount = selected.length;
    selected.forEach((point, index) => {
      tracker.previousPoints[index * 2] = point.x;
      tracker.previousPoints[index * 2 + 1] = point.y;
      tracker.pointStrength[index] = point.strength;
      tracker.pointAge[index] = point.age;
    });
    tracker.previousPyramid.build(tracker.grayscale, true);
    updateNodes(tracker);
  }

  function detectOrb(tracker) {
    const J = window.jsfeat;
    const found = J.yape06.detect(tracker.grayscale, tracker.corners, 18);
    const candidates = tracker.corners.slice(0, found).sort((left, right) => right.score - left.score);
    const corners = [];
    const cells = new Set();
    const cellSize = Math.max(26, Math.round(tracker.width / 9));
    for (const candidate of candidates) {
      if (candidate.x < 18 || candidate.y < 18 || candidate.x > tracker.width - 18 || candidate.y > tracker.height - 18) continue;
      const cell = `${Math.floor(candidate.x / cellSize)}:${Math.floor(candidate.y / cellSize)}`;
      if (cells.has(cell)) continue;
      cells.add(cell);
      corners.push(new J.keypoint_t(candidate.x, candidate.y, candidate.score, candidate.level, 0));
      if (corners.length >= 180) break;
    }
    const descriptors = new J.matrix_t(32, corners.length, J.U8_t | J.C1_t);
    if (corners.length) J.orb.describe(tracker.grayscale, corners, corners.length, descriptors);
    return { corners, descriptors };
  }

  function hamming(bytesA, offsetA, bytesB, offsetB) {
    let distance = 0;
    for (let index = 0; index < 32; index += 1) {
      let value = bytesA[offsetA + index] ^ bytesB[offsetB + index];
      value -= (value >> 1) & 0x55;
      value = (value & 0x33) + ((value >> 2) & 0x33);
      distance += (value + (value >> 4)) & 0x0f;
    }
    return distance;
  }

  function estimateHomography(from, to) {
    const J = window.jsfeat;
    if (!J || from.length < 8) return null;
    const model = new J.matrix_t(3, 3, J.F32_t | J.C1_t);
    const mask = new J.matrix_t(from.length, 1, J.U8_t | J.C1_t);
    const kernel = new J.motion_model.homography2d();
    const parameters = new J.ransac_params_t(4, 2.5, .45, .995);
    if (!J.motion_estimator.ransac(parameters, kernel, from, to, from.length, model, mask, 180)) return null;
    const indices = [];
    for (let index = 0; index < from.length; index += 1) if (mask.data[index]) indices.push(index);
    if (indices.length >= 4) kernel.run(indices.map((index) => from[index]), indices.map((index) => to[index]), model, indices.length);
    return { matrix: Array.from(model.data), mask, inliers: indices.length };
  }

  function updateNodes(tracker) {
    tracker.nodes = Array.from({ length: tracker.pointCount }, (_, index) => ({
      x: tracker.previousPoints[index * 2] / tracker.width,
      y: tracker.previousPoints[index * 2 + 1] / tracker.height,
      stable: tracker.pointAge[index] >= 4,
    }));
    drawNodes();
  }

  function startFeatureScan() {
    if (!hasLiveCamera()) return false;
    const tracker = createNaturalTracker();
    if (!tracker || !captureFrame(tracker)) return false;
    detectPoints(tracker);
    state.naturalTracker = tracker;
    state.trackerState = 'searching';
    return true;
  }

  function startNaturalTracker() {
    const tracker = createNaturalTracker();
    if (!tracker || !captureFrame(tracker)) return false;
    detectPoints(tracker);
    tracker.anchorQuad = state.paperPlane.points.map((point) => ({ x: point.x * tracker.width, y: point.y * tracker.height }));
    const keyframe = detectOrb(tracker);
    tracker.keyframeCorners = keyframe.corners;
    tracker.keyframeDescriptors = keyframe.descriptors;
    state.naturalTracker = tracker;
    return tracker.pointCount >= 8;
  }

  function tryRelocalize(tracker) {
    if (!tracker.keyframeDescriptors || tracker.frame % 5 !== 0) return false;
    const current = detectOrb(tracker);
    if (current.corners.length < 18) return false;
    const source = tracker.keyframeDescriptors.data;
    const destination = current.descriptors.data;
    const candidates = [];
    for (let index = 0; index < tracker.keyframeCorners.length; index += 1) {
      let best = 999;
      let second = 999;
      let destinationIndex = -1;
      for (let candidate = 0; candidate < current.corners.length; candidate += 1) {
        const score = hamming(source, index * 32, destination, candidate * 32);
        if (score < best) { second = best; best = score; destinationIndex = candidate; }
        else if (score < second) second = score;
      }
      if (destinationIndex >= 0 && best < 70 && best < second * .76) candidates.push({ source: index, destination: destinationIndex, score: best });
    }
    candidates.sort((left, right) => left.score - right.score);
    const used = new Set();
    const unique = candidates.filter((candidate) => {
      if (used.has(candidate.destination)) return false;
      used.add(candidate.destination);
      return true;
    });
    const estimate = estimateHomography(unique.map((match) => tracker.keyframeCorners[match.source]), unique.map((match) => current.corners[match.destination]));
    if (!estimate || estimate.inliers < 14 || estimate.inliers / Math.max(1, unique.length) < .4) return false;
    tracker.cumulative = estimate.matrix;
    tracker.relocalizing = false;
    tracker.failures = 0;
    detectPoints(tracker, false);
    state.confidence = estimate.inliers / unique.length;
    state.trackerState = 'locked';
    return true;
  }

  function updateNaturalTracker() {
    const J = window.jsfeat;
    const tracker = state.naturalTracker;
    if (!J || !tracker || !captureFrame(tracker)) return;
    tracker.frame += 1;
    if (tracker.relocalizing) {
      if (tryRelocalize(tracker)) renderPlane();
      else state.trackerState = 'relocalizing';
      setStatus();
      return;
    }
    if (tracker.pointCount < 8) {
      detectPoints(tracker);
      state.trackerState = 'scanning';
      setStatus();
      return;
    }
    J.optical_flow_lk.track(tracker.previousPyramid, tracker.currentPyramid, tracker.previousPoints, tracker.currentPoints, tracker.pointCount, 21, 22, tracker.pointStatus, .01, .0001);
    J.optical_flow_lk.track(tracker.currentPyramid, tracker.previousPyramid, tracker.currentPoints, tracker.backwardPoints, tracker.pointCount, 21, 18, tracker.backwardStatus, .01, .0001);
    const from = [];
    const to = [];
    const sourceIndices = [];
    for (let index = 0; index < tracker.pointCount; index += 1) {
      if (!tracker.pointStatus[index] || !tracker.backwardStatus[index]) continue;
      const x = tracker.currentPoints[index * 2];
      const y = tracker.currentPoints[index * 2 + 1];
      const backwardError = Math.hypot(tracker.backwardPoints[index * 2] - tracker.previousPoints[index * 2], tracker.backwardPoints[index * 2 + 1] - tracker.previousPoints[index * 2 + 1]);
      if (backwardError > 2.2 || x < 4 || y < 4 || x > tracker.width - 4 || y > tracker.height - 4) continue;
      from.push({ x: tracker.previousPoints[index * 2], y: tracker.previousPoints[index * 2 + 1] });
      to.push({ x, y });
      sourceIndices.push(index);
    }
    const estimate = estimateHomography(from, to);
    const confidence = estimate ? estimate.inliers / Math.max(1, from.length) : 0;
    if (!estimate || estimate.inliers < 8 || confidence < .34) {
      tracker.failures += 1;
      detectPoints(tracker, false);
      tracker.relocalizing = tracker.failures >= 3 && Boolean(tracker.keyframeDescriptors);
      state.trackerState = tracker.relocalizing ? 'relocalizing' : 'degraded';
      state.confidence = confidence;
      setStatus();
      return;
    }
    tracker.cumulative = multiplyMatrices(estimate.matrix, tracker.cumulative);
    let write = 0;
    for (let index = 0; index < from.length; index += 1) {
      if (!estimate.mask.data[index]) continue;
      const source = sourceIndices[index];
      tracker.previousPoints[write * 2] = to[index].x;
      tracker.previousPoints[write * 2 + 1] = to[index].y;
      tracker.pointStrength[write] = tracker.pointStrength[source];
      tracker.pointAge[write] = Math.min(65535, tracker.pointAge[source] + 1);
      write += 1;
    }
    tracker.pointCount = write;
    [tracker.previousPyramid, tracker.currentPyramid] = [tracker.currentPyramid, tracker.previousPyramid];
    if (tracker.pointCount < 72 || tracker.frame % 25 === 0) detectPoints(tracker, true);
    else updateNodes(tracker);
    tracker.failures = 0;
    state.confidence = confidence;
    state.trackerState = confidence >= .52 && estimate.inliers >= 18 ? 'locked' : 'scanning';
    renderPlane();
    setStatus();
  }

  function updateFeatureScan() {
    let tracker = state.naturalTracker;
    if (!tracker && !startFeatureScan()) return;
    tracker = state.naturalTracker;
    if (!tracker || !captureFrame(tracker)) return;
    detectPoints(tracker);
  }

  function createDetector() {
    const rect = ui.stage.getBoundingClientRect();
    const width = 180;
    const height = Math.max(180, Math.min(420, Math.round(width * rect.height / rect.width)));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }), width, height };
  }

  function captureDetectorFrame(detector) {
    const videoWidth = ui.camera.videoWidth;
    const videoHeight = ui.camera.videoHeight;
    if (!videoWidth || !videoHeight) return null;
    const sourceAspect = videoWidth / videoHeight;
    const targetAspect = detector.width / detector.height;
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
    detector.context.drawImage(ui.camera, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, detector.width, detector.height);
    return detector.context.getImageData(0, 0, detector.width, detector.height).data;
  }

  function polygonArea(points) {
    return Math.abs(points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length];
      return sum + point.x * next.y - next.x * point.y;
    }, 0) / 2);
  }

  function candidateFromComponent(component, width, height, mean, deviation) {
    const boxWidth = component.maxX - component.minX + 1;
    const boxHeight = component.maxY - component.minY + 1;
    const areaRatio = component.count / (width * height);
    const fill = component.count / (boxWidth * boxHeight);
    const aspect = boxWidth / boxHeight;
    const contrast = component.luminance / component.count - mean;
    if (areaRatio < .075 || areaRatio > .82 || boxWidth < width * .28 || boxHeight < height * .24 || aspect < .38 || aspect > 2.65 || fill < .44 || contrast < Math.max(7, deviation * .1)) return null;
    const points = [component.topLeft, component.topRight, component.bottomRight, component.bottomLeft].map((point) => ({ x: point.x / width, y: point.y / height }));
    const quadArea = polygonArea(points);
    if (quadArea < .065 || quadArea > .86) return null;
    const sides = points.map((point, index) => Math.hypot(point.x - points[(index + 1) % 4].x, point.y - points[(index + 1) % 4].y));
    if (Math.min(...sides) < .18) return null;
    const confidence = Math.max(.5, Math.min(.97, .3 + fill * .34 + Math.min(1, contrast / (deviation * 1.35 + 1)) * .24 + Math.min(.12, areaRatio * .16)));
    return { points, confidence, areaRatio, fill };
  }

  function findPaperCandidate() {
    if (!hasLiveCamera()) return;
    const rect = ui.stage.getBoundingClientRect();
    if (!state.detector || Math.abs(state.detector.width / state.detector.height - rect.width / rect.height) > .04) state.detector = createDetector();
    const detector = state.detector;
    const pixels = captureDetectorFrame(detector);
    if (!pixels) return;
    const total = detector.width * detector.height;
    const luminance = new Uint8Array(total);
    let sum = 0;
    let squareSum = 0;
    for (let index = 0; index < total; index += 1) {
      const pixel = index * 4;
      const value = Math.round(pixels[pixel] * .2126 + pixels[pixel + 1] * .7152 + pixels[pixel + 2] * .0722);
      luminance[index] = value;
      sum += value;
      squareSum += value * value;
    }
    const mean = sum / total;
    const deviation = Math.sqrt(Math.max(0, squareSum / total - mean * mean));
    const threshold = Math.min(245, mean + Math.max(9, deviation * .18));
    const accepted = new Uint8Array(total);
    for (let index = 0; index < total; index += 1) accepted[index] = luminance[index] >= threshold ? 1 : 0;
    const visited = new Uint8Array(total);
    const queue = new Int32Array(total);
    let best = null;
    for (let seed = 0; seed < total; seed += 1) {
      if (!accepted[seed] || visited[seed]) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = seed;
      visited[seed] = 1;
      const component = {
        count: 0, luminance: 0, minX: detector.width, maxX: 0, minY: detector.height, maxY: 0,
        topLeft: null, topRight: null, bottomRight: null, bottomLeft: null,
        minSum: Infinity, maxDifference: -Infinity, maxSum: -Infinity, minDifference: Infinity,
      };
      while (head < tail) {
        const index = queue[head++];
        const x = index % detector.width;
        const y = Math.floor(index / detector.width);
        const sumXY = x + y;
        const difference = x - y;
        component.count += 1;
        component.luminance += luminance[index];
        component.minX = Math.min(component.minX, x);
        component.maxX = Math.max(component.maxX, x);
        component.minY = Math.min(component.minY, y);
        component.maxY = Math.max(component.maxY, y);
        if (sumXY < component.minSum) { component.minSum = sumXY; component.topLeft = { x, y }; }
        if (difference > component.maxDifference) { component.maxDifference = difference; component.topRight = { x, y }; }
        if (sumXY > component.maxSum) { component.maxSum = sumXY; component.bottomRight = { x, y }; }
        if (difference < component.minDifference) { component.minDifference = difference; component.bottomLeft = { x, y }; }
        const neighbours = [index - 1, index + 1, index - detector.width, index + detector.width];
        for (const neighbour of neighbours) {
          if (neighbour < 0 || neighbour >= total) continue;
          const neighbourX = neighbour % detector.width;
          if (Math.abs(neighbourX - x) > 1 || !accepted[neighbour] || visited[neighbour]) continue;
          visited[neighbour] = 1;
          queue[tail++] = neighbour;
        }
      }
      const candidate = candidateFromComponent(component, detector.width, detector.height, mean, deviation);
      if (candidate && (!best || candidate.confidence > best.confidence)) best = candidate;
    }
    if (!best) {
      state.candidate = null;
      state.candidateFrames = 0;
      renderPlane();
      setStatus();
      return;
    }
    const previous = state.candidate;
    const shift = previous ? best.points.reduce((sumDistance, point, index) => sumDistance + Math.hypot(point.x - previous.points[index].x, point.y - previous.points[index].y), 0) / 4 : Infinity;
    state.candidateFrames = shift < .075 ? state.candidateFrames + 1 : 1;
    best.confidence = Math.min(.99, best.confidence + Math.min(.08, state.candidateFrames * .02));
    state.candidate = best;
    renderPlane();
    setStatus();
  }

  function drawNodes() {
    const canvas = ui.trackingOverlay;
    const context = canvas.getContext('2d');
    const rect = ui.stage.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    if (!state.showNodes || !state.naturalTracker) return;
    const nodes = state.naturalTracker.nodes;
    nodes.forEach((node) => {
      const x = node.x * rect.width;
      const y = node.y * rect.height;
      context.beginPath();
      context.arc(x, y, node.stable ? 4.2 : 3, 0, Math.PI * 2);
      context.fillStyle = node.stable ? 'rgba(124,235,206,.95)' : 'rgba(238,196,126,.82)';
      context.fill();
      context.lineWidth = 1;
      context.strokeStyle = 'rgba(7,15,13,.8)';
      context.stroke();
    });
    context.fillStyle = 'rgba(13,17,15,.78)';
    context.fillRect(12, rect.height - 38, 132, 26);
    context.fillStyle = '#d9f8ec';
    context.font = '600 12px system-ui';
    context.fillText(`${nodes.filter((node) => node.stable).length}/${nodes.length} stable nodes`, 20, rect.height - 21);
  }

  function toggleNodes() {
    state.showNodes = !state.showNodes;
    ui.nodes.setAttribute('aria-pressed', String(state.showNodes));
    ui.nodes.setAttribute('aria-label', state.showNodes ? 'Hide tracking nodes' : 'Show tracking nodes');
    drawNodes();
  }

  function trackLoop(timestamp) {
    requestAnimationFrame(trackLoop);
    if (!hasLiveCamera()) return;
    if (state.tracking && timestamp - state.lastTrackAt >= 85) {
      state.lastTrackAt = timestamp;
      updateNaturalTracker();
      return;
    }
    if (!state.tracking && timestamp - state.lastTrackAt >= 160) {
      state.lastTrackAt = timestamp;
      updateFeatureScan();
      setStatus();
    }
    if (!state.tracking && timestamp - state.lastDetectAt >= 240) {
      state.lastDetectAt = timestamp;
      findPaperCandidate();
    }
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) await (document.exitFullscreen?.() || document.webkitExitFullscreen?.());
      else await (ui.studio.requestFullscreen?.() || ui.studio.webkitRequestFullscreen?.());
    } catch (_) {
      // Installed web-app mode provides the closest iPhone fullscreen experience.
    }
  }

  ui.openCamera.addEventListener('click', startCamera);
  ui.cameraNote.addEventListener('click', startCamera);
  ui.remapHeader.addEventListener('click', resetPlane);
  ui.map.addEventListener('click', () => (isMapped() ? resetPlane() : lockCandidate()));
  ui.reset.addEventListener('click', resetPlane);
  ui.nodes.addEventListener('click', toggleNodes);
  ui.fullScreen.addEventListener('click', toggleFullscreen);
  window.addEventListener('resize', () => { state.detector = null; renderPlane(); drawNodes(); });
  window.addEventListener('pagehide', stopCamera);

  setStatus();
  drawNodes();
  requestAnimationFrame(trackLoop);
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./service-worker.js?v=11', { updateViaCache: 'none' }));
  }
})();
