(() => {
  const $ = (selector) => document.querySelector(selector);
  const ANCHOR_STORAGE_KEY = 'lucida-paper-anchor-v2';
  const LEGACY_ANCHOR_STORAGE_KEY = 'lucida-paper-anchor-v1';
  const FINGERPRINT_WIDTH = 48;
  const FINGERPRINT_HEIGHT = 36;
  const PLANE_SIZE = 1000;

  const ui = {
    welcome: $('#welcome'),
    studio: $('#studio'),
    stage: $('#drawingStage'),
    cameraFeed: $('#cameraFeed'),
    referenceImage: $('#referenceImage'),
    paperPlane: $('#paperPlane'),
    planeImage: $('#planeImage'),
    planeMarkers: $('#planeMarkers'),
    mappingGuide: $('#mappingGuide'),
    emptyOverlayNote: $('#emptyOverlayNote'),
    photoInput: $('#photoInput'),
    openCamera: $('#openCameraButton'),
    openPhotos: $('#openPhotosButton'),
    newReference: $('#newReferenceButton'),
    sourceSheet: $('#sourceSheet'),
    closeSource: $('#closeSourceButton'),
    sourcePhotos: $('#sourcePhotosButton'),
    captureOverlay: $('#captureOverlayButton'),
    opacity: $('#opacityRange'),
    opacityValue: $('#opacityValue'),
    lock: $('#lockButton'),
    reset: $('#resetButton'),
    gestureLayer: $('#gestureLayer'),
    fullScreen: $('#fullScreenButton'),
    nodes: $('#nodesButton'),
    trackingOverlay: $('#trackingOverlay'),
    anchorButton: $('#anchorButton'),
    clearAnchor: $('#clearAnchorButton'),
    anchorStatus: $('#anchorStatus'),
    anchorHint: $('#anchorHint'),
  };

  const storedAnchor = readSavedAnchor();
  const state = {
    stream: null,
    overlay: { x: 0, y: 0, scale: 1, opacity: 62 },
    planeOverlay: storedAnchor?.plane?.overlay || { x: 0, y: 0, scale: 1 },
    paperPlane: storedAnchor?.plane ? clonePlane(storedAnchor.plane) : null,
    mapping: null,
    pointers: new Map(),
    gestureStart: null,
    locked: false,
    objectUrl: null,
    cameraStartPromise: null,
    anchor: storedAnchor,
    tracking: false,
    trackerOffset: { x: 0, y: 0 },
    trackerCanvas: null,
    lastTrackAt: 0,
    lastConfidence: null,
    naturalTracker: null,
    showNodes: false,
  };

  function clonePlane(plane) {
    return {
      points: plane.points.map((point) => ({ x: point.x, y: point.y })),
      overlay: { x: plane.overlay.x, y: plane.overlay.y, scale: plane.overlay.scale },
    };
  }

  function validPlane(plane) {
    return plane
      && Array.isArray(plane.points)
      && plane.points.length === 4
      && plane.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
      && Number.isFinite(plane.overlay?.x)
      && Number.isFinite(plane.overlay?.y)
      && Number.isFinite(plane.overlay?.scale);
  }

  function readSavedAnchor() {
    try {
      const raw = localStorage.getItem(ANCHOR_STORAGE_KEY) || localStorage.getItem(LEGACY_ANCHOR_STORAGE_KEY);
      const anchor = JSON.parse(raw);
      const validFingerprint = anchor
        && anchor.fingerprint?.width === FINGERPRINT_WIDTH
        && anchor.fingerprint?.height === FINGERPRINT_HEIGHT
        && Array.isArray(anchor.fingerprint?.values)
        && anchor.fingerprint.values.length === FINGERPRINT_WIDTH * FINGERPRINT_HEIGHT;
      if (!validFingerprint) return null;
      if (anchor.version === 2 && !validPlane(anchor.plane)) return null;
      return anchor;
    } catch (_) {
      return null;
    }
  }

  function saveAnchor(anchor) {
    try {
      localStorage.setItem(ANCHOR_STORAGE_KEY, JSON.stringify(anchor));
      localStorage.removeItem(LEGACY_ANCHOR_STORAGE_KEY);
      return true;
    } catch (_) {
      return false;
    }
  }

  function isPlaneMapped() {
    return Boolean(state.paperPlane);
  }

  function stagePointsWithTracking() {
    if (!state.paperPlane) return [];
    if (state.tracking && state.naturalTracker?.cumulative && state.naturalTracker.anchorQuad) {
      const tracker = state.naturalTracker;
      return tracker.anchorQuad.map((point) => {
        const projected = projectFeaturePoint(tracker.cumulative, point);
        return {
          x: (projected?.x ?? point.x) / tracker.width * ui.stage.getBoundingClientRect().width,
          y: (projected?.y ?? point.y) / tracker.height * ui.stage.getBoundingClientRect().height,
        };
      });
    }
    const rect = ui.stage.getBoundingClientRect();
    const offset = state.tracking ? state.trackerOffset : { x: 0, y: 0 };
    return state.paperPlane.points.map((point) => ({
      x: point.x * rect.width + offset.x,
      y: point.y * rect.height + offset.y,
    }));
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

  function featureIdentity() {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }

  function multiplyFeatureMatrices(left, right) {
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

  function projectFeaturePoint(matrix, point) {
    const scale = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
    if (Math.abs(scale) < .000001) return null;
    return {
      x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / scale,
      y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / scale,
    };
  }

  function createNaturalTracker() {
    const J = window.jsfeat;
    if (!J || !hasLiveCamera() || !isPlaneMapped()) return null;
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
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const type = J.U8_t | J.C1_t;
    const grayscale = new J.matrix_t(width, height, type);
    const previousPyramid = new J.pyramid_t(3);
    const currentPyramid = new J.pyramid_t(3);
    previousPyramid.allocate(width, height, type);
    currentPyramid.allocate(width, height, type);
    J.yape06.laplacian_threshold = 28;
    J.yape06.min_eigen_value_threshold = 22;
    return {
      canvas,
      context,
      width,
      height,
      grayscale,
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
      cumulative: featureIdentity(),
      anchorQuad: null,
      nodes: [],
    };
  }

  function captureNaturalFrame(tracker) {
    const J = window.jsfeat;
    const videoWidth = ui.cameraFeed.videoWidth;
    const videoHeight = ui.cameraFeed.videoHeight;
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
    tracker.context.drawImage(ui.cameraFeed, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, tracker.width, tracker.height);
    const pixels = tracker.context.getImageData(0, 0, tracker.width, tracker.height);
    J.imgproc.grayscale(pixels.data, tracker.width, tracker.height, tracker.grayscale);
    J.imgproc.gaussian_blur(tracker.grayscale, tracker.grayscale, 3, 0);
    tracker.currentPyramid.build(tracker.grayscale, true);
    return true;
  }

  function detectNaturalPoints(tracker, preserve = false) {
    const J = window.jsfeat;
    if (!J) return;
    const selected = [];
    if (preserve) {
      for (let index = 0; index < tracker.pointCount; index += 1) {
        selected.push({
          x: tracker.previousPoints[index * 2],
          y: tracker.previousPoints[index * 2 + 1],
          strength: tracker.pointStrength[index],
          age: tracker.pointAge[index],
        });
      }
    }
    const found = J.yape06.detect(tracker.grayscale, tracker.corners, 12);
    const candidates = tracker.corners.slice(0, found).sort((left, right) => right.score - left.score);
    const strongest = candidates[0]?.score || 1;
    const cellSize = Math.max(24, Math.round(tracker.width / 9));
    const cells = new Map();
    selected.forEach((point) => cells.set(`${Math.floor(point.x / cellSize)}:${Math.floor(point.y / cellSize)}`, 1));
    for (const corner of candidates) {
      if (corner.x < 12 || corner.y < 12 || corner.x > tracker.width - 12 || corner.y > tracker.height - 12) continue;
      const cell = `${Math.floor(corner.x / cellSize)}:${Math.floor(corner.y / cellSize)}`;
      if (cells.has(cell)) continue;
      if (selected.some((point) => Math.abs(point.x - corner.x) < 9 && Math.abs(point.y - corner.y) < 9)) continue;
      selected.push({ x: corner.x, y: corner.y, strength: corner.score / strongest, age: 1 });
      cells.set(cell, 1);
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
    updateNaturalNodes(tracker);
  }

  function estimateNaturalHomography(from, to) {
    const J = window.jsfeat;
    if (!J || from.length < 8) return null;
    const model = new J.matrix_t(3, 3, J.F32_t | J.C1_t);
    const mask = new J.matrix_t(from.length, 1, J.U8_t | J.C1_t);
    const kernel = new J.motion_model.homography2d();
    const parameters = new J.ransac_params_t(4, 2.5, 0.45, 0.995);
    if (!J.motion_estimator.ransac(parameters, kernel, from, to, from.length, model, mask, 160)) return null;
    const inliers = [];
    for (let index = 0; index < from.length; index += 1) {
      if (mask.data[index]) inliers.push(index);
    }
    if (inliers.length >= 4) kernel.run(inliers.map((index) => from[index]), inliers.map((index) => to[index]), model, inliers.length);
    return { matrix: Array.from(model.data), mask, inliers: inliers.length };
  }

  function updateNaturalNodes(tracker) {
    tracker.nodes = Array.from({ length: tracker.pointCount }, (_, index) => ({
      x: tracker.previousPoints[index * 2] / tracker.width,
      y: tracker.previousPoints[index * 2 + 1] / tracker.height,
      stable: tracker.pointAge[index] >= 4,
      strength: tracker.pointStrength[index],
    }));
    drawTrackingNodes();
  }

  function startNaturalTracker() {
    const tracker = createNaturalTracker();
    if (!tracker || !captureNaturalFrame(tracker)) return false;
    detectNaturalPoints(tracker);
    tracker.anchorQuad = state.paperPlane.points.map((point) => ({ x: point.x * tracker.width, y: point.y * tracker.height }));
    state.naturalTracker = tracker;
    if (state.anchor) {
      state.anchor.nodes = tracker.nodes.slice(0, 120);
      saveAnchor(state.anchor);
    }
    return tracker.pointCount >= 8;
  }

  function updateNaturalTracker() {
    const J = window.jsfeat;
    const tracker = state.naturalTracker;
    if (!J || !tracker || !captureNaturalFrame(tracker)) return null;
    if (tracker.pointCount < 8) {
      detectNaturalPoints(tracker);
      return { confidence: 0, inliers: 0, features: tracker.pointCount };
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
    const estimate = estimateNaturalHomography(from, to);
    const confidence = estimate ? estimate.inliers / Math.max(1, from.length) : 0;
    if (!estimate || estimate.inliers < 8 || confidence < .34) {
      detectNaturalPoints(tracker, false);
      return { confidence, inliers: estimate?.inliers || 0, features: from.length };
    }
    tracker.cumulative = multiplyFeatureMatrices(estimate.matrix, tracker.cumulative);
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
    if (tracker.pointCount < 72) detectNaturalPoints(tracker, true);
    else updateNaturalNodes(tracker);
    return { confidence, inliers: estimate.inliers, features: from.length };
  }

  function drawTrackingNodes() {
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
      context.fillStyle = node.stable ? 'rgba(124, 235, 206, .94)' : 'rgba(238, 196, 126, .8)';
      context.fill();
      context.lineWidth = 1;
      context.strokeStyle = 'rgba(8, 15, 13, .78)';
      context.stroke();
    });
    context.fillStyle = 'rgba(13, 17, 15, .78)';
    context.fillRect(12, rect.height - 38, 122, 26);
    context.fillStyle = '#d9f8ec';
    context.font = '600 12px system-ui';
    context.fillText(`${nodes.filter((node) => node.stable).length}/${nodes.length} stable nodes`, 20, rect.height - 21);
  }

  function toggleNodes() {
    state.showNodes = !state.showNodes;
    ui.nodes.setAttribute('aria-pressed', String(state.showNodes));
    ui.nodes.setAttribute('aria-label', state.showNodes ? 'Hide tracking nodes' : 'Show tracking nodes');
    drawTrackingNodes();
  }

  function updatePaperPlaneTransform() {
    if (!isPlaneMapped()) return;
    const homography = homographyForQuad(stagePointsWithTracking());
    if (!homography) return;
    const { a, b, c, d, e, f, g, h } = homography;
    ui.paperPlane.style.transform = `matrix3d(${a / PLANE_SIZE}, ${d / PLANE_SIZE}, 0, ${g / PLANE_SIZE}, ${b / PLANE_SIZE}, ${e / PLANE_SIZE}, 0, ${h / PLANE_SIZE}, 0, 0, 1, 0, ${c}, ${f}, 0, 1)`;
  }

  function setOverlayTransform() {
    if (isPlaneMapped()) {
      updatePaperPlaneTransform();
      const { x, y, scale } = state.planeOverlay;
      ui.planeImage.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale})`;
      return;
    }
    const tracker = state.tracking ? state.trackerOffset : { x: 0, y: 0 };
    const { x, y, scale } = state.overlay;
    ui.referenceImage.style.transform = `translate(-50%, -50%) translate(${x + tracker.x}px, ${y + tracker.y}px) scale(${scale})`;
  }

  function updateOpacity() {
    state.overlay.opacity = Number(ui.opacity.value);
    const opacity = state.overlay.opacity / 100;
    ui.referenceImage.style.opacity = opacity;
    ui.planeImage.style.opacity = opacity;
    ui.opacityValue.value = `${state.overlay.opacity}%`;
    ui.opacity.style.setProperty('--slider-fill', `${state.overlay.opacity}%`);
  }

  function showStudio() {
    ui.welcome.hidden = true;
    ui.studio.hidden = false;
  }

  function setOverlayVisible(visible) {
    const mapped = isPlaneMapped();
    ui.referenceImage.hidden = !visible || mapped;
    ui.paperPlane.hidden = !visible || !mapped;
    ui.planeImage.hidden = !visible || !mapped;
    ui.studio.classList.toggle('has-overlay', visible);
    setOverlayTransform();
    updateAnchorControl();
  }

  function setLocked(locked) {
    state.locked = locked;
    ui.studio.classList.toggle('is-locked', locked);
    ui.lock.setAttribute('aria-pressed', String(locked));
    ui.lock.textContent = locked ? 'Unlock image' : 'Lock image';
  }

  function hasLiveCamera() {
    return Boolean(state.stream && ui.cameraFeed.videoWidth && ui.cameraFeed.videoHeight);
  }

  function hasOverlay() {
    return ui.studio.classList.contains('has-overlay');
  }

  function updateAnchorControl(message) {
    const mapped = isPlaneMapped();
    ui.clearAnchor.disabled = !mapped && !state.mapping && !state.anchor;

    if (message) {
      ui.anchorStatus.value = message;
      return;
    }

    if (state.mapping) {
      const labels = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
      const next = labels[state.mapping.points.length] || 'paper';
      ui.anchorStatus.value = `${state.mapping.points.length}/4 corners`;
      ui.anchorHint.textContent = `Tap the ${next} corner of the physical paper. Start at the top-left and go clockwise.`;
      ui.anchorButton.textContent = 'Cancel mapping';
      ui.anchorButton.disabled = false;
      return;
    }

    if (!hasLiveCamera()) {
      ui.anchorStatus.value = mapped ? 'Mapped — open camera to track' : 'Open camera first';
      ui.anchorHint.textContent = 'The plane needs the live rear camera so it can see the physical paper.';
      ui.anchorButton.textContent = mapped ? 'Track mapped paper' : 'Map paper plane';
      ui.anchorButton.disabled = true;
      return;
    }

    if (!hasOverlay()) {
      ui.anchorStatus.value = mapped ? 'Mapped — add an overlay' : 'Add an overlay first';
      ui.anchorHint.textContent = 'Choose the image you want to trace before mapping it onto your paper.';
      ui.anchorButton.textContent = mapped ? 'Track mapped paper' : 'Map paper plane';
      ui.anchorButton.disabled = true;
      return;
    }

    ui.anchorButton.disabled = false;
    if (mapped && state.tracking) {
      const confidence = state.lastConfidence === null ? 'looking…' : `${Math.round(state.lastConfidence * 100)}% match`;
      ui.anchorStatus.value = `Tracking paper · ${confidence}`;
      ui.anchorHint.textContent = 'Drag or pinch is paused while Lucida keeps the mapped plane steady.';
      ui.anchorButton.textContent = 'Stop tracking';
      return;
    }
    if (mapped) {
      ui.anchorStatus.value = 'Paper mapped';
      ui.anchorHint.textContent = 'Drag the image across the mapped paper, or resume camera tracking when you are ready.';
      ui.anchorButton.textContent = 'Track mapped paper';
      return;
    }

    ui.anchorStatus.value = 'Not mapped';
    ui.anchorHint.textContent = 'Tap the four paper corners once to create a perspective-mapped drawing surface.';
    ui.anchorButton.textContent = 'Map paper plane';
  }

  async function startCamera() {
    showStudio();
    if (state.stream) return;
    if (state.cameraStartPromise) return state.cameraStartPromise;
    if (!navigator.mediaDevices?.getUserMedia) {
      ui.emptyOverlayNote.textContent = 'This browser cannot open the live camera. Try Safari on your iPhone.';
      updateAnchorControl();
      return;
    }

    state.cameraStartPromise = navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    })
      .then(async (stream) => {
        state.stream = stream;
        ui.cameraFeed.srcObject = stream;
        await ui.cameraFeed.play();
        ui.studio.classList.add('has-camera');
        if (!hasOverlay()) ui.emptyOverlayNote.textContent = 'Add a photo to place it over the live camera.';
        updateAnchorControl();
      })
      .catch(() => {
        ui.emptyOverlayNote.textContent = 'Allow camera access, then tap here to try the live tracing view again.';
        updateAnchorControl();
      })
      .finally(() => { state.cameraStartPromise = null; });

    return state.cameraStartPromise;
  }

  function stopCamera() {
    setTracking(false);
    state.stream?.getTracks().forEach((track) => track.stop());
    state.stream = null;
    ui.cameraFeed.srcObject = null;
    ui.studio.classList.remove('has-camera');
    updateAnchorControl();
  }

  function openSourceSheet() {
    if (!ui.sourceSheet.open) ui.sourceSheet.showModal();
  }

  function choosePhoto() {
    if (ui.sourceSheet.open) ui.sourceSheet.close();
    ui.photoInput.click();
  }

  function loadReference(source, isObjectUrl = false) {
    setTracking(false);
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = isObjectUrl ? source : null;
    ui.referenceImage.onload = () => {
      if (!isPlaneMapped()) {
        state.overlay.x = 0;
        state.overlay.y = 0;
        state.overlay.scale = 1;
      }
      setOverlayVisible(true);
    };
    ui.referenceImage.src = source;
    ui.planeImage.src = source;
  }

  function captureCameraView() {
    if (!ui.cameraFeed.videoWidth) {
      startCamera();
      return;
    }
    const frame = document.createElement('canvas');
    frame.width = ui.cameraFeed.videoWidth;
    frame.height = ui.cameraFeed.videoHeight;
    frame.getContext('2d').drawImage(ui.cameraFeed, 0, 0);
    loadReference(frame.toDataURL('image/jpeg', .94));
    ui.sourceSheet.close();
  }

  function stagePoint(event) {
    const rect = ui.stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function screenPointToPlane(point) {
    const homography = homographyForQuad(stagePointsWithTracking());
    if (!homography) return null;
    const { a, b, c, d, e, f, g, h } = homography;
    const determinant = a * (e - f * h) - b * (d - f * g) + c * (d * h - e * g);
    if (Math.abs(determinant) < .0001) return null;
    const inverse = [
      e - f * h, c * h - b, b * f - c * e,
      f * g - d, a - c * g, c * d - a * f,
      d * h - e * g, b * g - a * h, a * e - b * d,
    ].map((value) => value / determinant);
    const divisor = inverse[6] * point.x + inverse[7] * point.y + inverse[8];
    if (Math.abs(divisor) < .0001) return null;
    return {
      x: (inverse[0] * point.x + inverse[1] * point.y + inverse[2]) / divisor * PLANE_SIZE,
      y: (inverse[3] * point.x + inverse[4] * point.y + inverse[5]) / divisor * PLANE_SIZE,
    };
  }

  function gestureMetrics() {
    const points = [...state.pointers.values()];
    if (points.length === 1) return { center: points[0], distance: 0 };
    const [a, b] = points;
    return {
      center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      distance: Math.hypot(b.x - a.x, b.y - a.y),
    };
  }

  function renderMapping() {
    const mapping = state.mapping;
    ui.studio.classList.toggle('is-mapping', Boolean(mapping));
    ui.planeMarkers.replaceChildren();
    if (!mapping) {
      ui.mappingGuide.hidden = true;
      return;
    }
    const labels = ['Tap top-left', 'Tap top-right', 'Tap bottom-right', 'Tap bottom-left'];
    ui.mappingGuide.textContent = labels[mapping.points.length];
    ui.mappingGuide.hidden = false;
    mapping.points.forEach((point, index) => {
      const marker = document.createElement('span');
      marker.className = 'plane-marker';
      marker.textContent = String(index + 1);
      marker.style.left = `${point.x * 100}%`;
      marker.style.top = `${point.y * 100}%`;
      ui.planeMarkers.append(marker);
    });
  }

  function startMapping() {
    if (!hasLiveCamera() || !hasOverlay()) return;
    setTracking(false);
    state.mapping = { points: [] };
    renderMapping();
    updateAnchorControl();
  }

  function cancelMapping() {
    state.mapping = null;
    renderMapping();
    updateAnchorControl();
  }

  function completeMapping() {
    const fingerprint = getFingerprint();
    if (!fingerprint || fingerprint.detail < .045) {
      cancelMapping();
      ui.anchorStatus.value = 'Need more surface detail';
      ui.anchorHint.textContent = 'Keep a paper edge, desk grain, tape, or another visible detail in camera view, then map again.';
      return;
    }
    const plane = {
      points: state.mapping.points,
      overlay: { x: 0, y: 0, scale: 1 },
    };
    state.paperPlane = clonePlane(plane);
    state.planeOverlay = { ...plane.overlay };
    state.anchor = {
      version: 2,
      createdAt: new Date().toISOString(),
      fingerprint,
      plane: clonePlane(plane),
    };
    const saved = saveAnchor(state.anchor);
    state.mapping = null;
    renderMapping();
    setOverlayVisible(true);
    setTracking(true);
    if (!saved) updateAnchorControl('Tracking — not saved');
  }

  function addMappingPoint(event) {
    const rect = ui.stage.getBoundingClientRect();
    const point = stagePoint(event);
    state.mapping.points.push({ x: point.x / rect.width, y: point.y / rect.height });
    renderMapping();
    if (state.mapping.points.length === 4) completeMapping();
    else updateAnchorControl();
  }

  function gestureStart(event) {
    if (state.mapping) {
      event.preventDefault();
      addMappingPoint(event);
      return;
    }
    if (state.locked || state.tracking || !hasOverlay()) return;
    const rawPoint = stagePoint(event);
    const point = isPlaneMapped() ? screenPointToPlane(rawPoint) : rawPoint;
    if (!point) return;
    event.preventDefault();
    ui.gestureLayer.setPointerCapture(event.pointerId);
    state.pointers.set(event.pointerId, point);
    state.gestureStart = {
      metrics: gestureMetrics(),
      overlay: isPlaneMapped() ? { ...state.planeOverlay } : { ...state.overlay },
    };
  }

  function gestureMove(event) {
    if (!state.pointers.has(event.pointerId) || !state.gestureStart) return;
    event.preventDefault();
    const rawPoint = stagePoint(event);
    const point = isPlaneMapped() ? screenPointToPlane(rawPoint) : rawPoint;
    if (!point) return;
    state.pointers.set(event.pointerId, point);
    const next = gestureMetrics();
    const start = state.gestureStart;
    const target = isPlaneMapped() ? state.planeOverlay : state.overlay;
    target.x = start.overlay.x + (next.center.x - start.metrics.center.x);
    target.y = start.overlay.y + (next.center.y - start.metrics.center.y);
    if (next.distance && start.metrics.distance) {
      target.scale = Math.min(4, Math.max(.2, start.overlay.scale * (next.distance / start.metrics.distance)));
    }
    setOverlayTransform();
  }

  function gestureEnd(event) {
    state.pointers.delete(event.pointerId);
    if (state.pointers.size) {
      state.gestureStart = {
        metrics: gestureMetrics(),
        overlay: isPlaneMapped() ? { ...state.planeOverlay } : { ...state.overlay },
      };
    } else {
      state.gestureStart = null;
    }
  }

  function resetOverlay() {
    setTracking(false);
    if (isPlaneMapped()) {
      state.planeOverlay = { x: 0, y: 0, scale: 1 };
    } else {
      state.overlay.x = 0;
      state.overlay.y = 0;
      state.overlay.scale = 1;
    }
    setOverlayTransform();
  }

  function getFingerprint() {
    if (!hasLiveCamera()) return null;
    if (!state.trackerCanvas) state.trackerCanvas = document.createElement('canvas');
    state.trackerCanvas.width = FINGERPRINT_WIDTH;
    state.trackerCanvas.height = FINGERPRINT_HEIGHT;
    const context = state.trackerCanvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(ui.cameraFeed, 0, 0, FINGERPRINT_WIDTH, FINGERPRINT_HEIGHT);
    const pixels = context.getImageData(0, 0, FINGERPRINT_WIDTH, FINGERPRINT_HEIGHT).data;
    const luminance = new Array(FINGERPRINT_WIDTH * FINGERPRINT_HEIGHT);
    let sum = 0;
    for (let i = 0; i < luminance.length; i += 1) {
      const offset = i * 4;
      const value = pixels[offset] * .2126 + pixels[offset + 1] * .7152 + pixels[offset + 2] * .0722;
      luminance[i] = value;
      sum += value;
    }
    const mean = sum / luminance.length;
    let variance = 0;
    for (const value of luminance) variance += (value - mean) ** 2;
    const detail = Math.sqrt(variance / luminance.length) / 255;
    const spread = Math.max(Math.sqrt(variance / luminance.length), 1);
    return {
      width: FINGERPRINT_WIDTH,
      height: FINGERPRINT_HEIGHT,
      detail,
      values: luminance.map((value) => Number(((value - mean) / spread).toFixed(3))),
    };
  }

  function findCameraShift(anchor, frame) {
    const maxShift = 6;
    const inset = maxShift + 2;
    let best = { score: Infinity, dx: 0, dy: 0 };
    for (let dy = -maxShift; dy <= maxShift; dy += 1) {
      for (let dx = -maxShift; dx <= maxShift; dx += 1) {
        let error = 0;
        let count = 0;
        for (let y = inset; y < anchor.height - inset; y += 1) {
          for (let x = inset; x < anchor.width - inset; x += 1) {
            const before = anchor.values[y * anchor.width + x];
            const after = frame.values[(y + dy) * frame.width + x + dx];
            error += Math.abs(before - after);
            count += 1;
          }
        }
        const score = error / count;
        if (score < best.score) best = { score, dx, dy };
      }
    }
    return best;
  }

  function videoShiftToStage(shift) {
    const stage = ui.stage.getBoundingClientRect();
    const videoAspect = ui.cameraFeed.videoWidth / ui.cameraFeed.videoHeight;
    const stageAspect = stage.width / stage.height;
    const renderedWidth = videoAspect > stageAspect ? stage.height * videoAspect : stage.width;
    const renderedHeight = videoAspect > stageAspect ? stage.height : stage.width / videoAspect;
    return {
      x: (shift.dx / FINGERPRINT_WIDTH) * renderedWidth,
      y: (shift.dy / FINGERPRINT_HEIGHT) * renderedHeight,
    };
  }

  function trackPaper(timestamp) {
    requestAnimationFrame(trackPaper);
    if (!state.tracking || !state.anchor || timestamp - state.lastTrackAt < 90) return;
    state.lastTrackAt = timestamp;
    const featureResult = updateNaturalTracker();
    if (featureResult?.inliers >= 8 && featureResult.confidence >= .34) {
      state.lastConfidence = featureResult.confidence;
      state.trackerOffset = { x: 0, y: 0 };
      setOverlayTransform();
      updateAnchorControl();
      return;
    }
    const frame = getFingerprint();
    if (!frame) return;
    const match = findCameraShift(state.anchor.fingerprint, frame);
    const confidence = Math.max(0, Math.min(1, 1 - match.score / .82));
    state.lastConfidence = confidence;
    if (confidence >= .34) {
      const target = videoShiftToStage(match);
      state.trackerOffset.x += (target.x - state.trackerOffset.x) * .28;
      state.trackerOffset.y += (target.y - state.trackerOffset.y) * .28;
      setOverlayTransform();
    }
    updateAnchorControl();
  }

  function setTracking(enabled) {
    if (!enabled && state.tracking) {
      if (isPlaneMapped()) {
        if (state.naturalTracker) {
          const rect = ui.stage.getBoundingClientRect();
          state.paperPlane.points = stagePointsWithTracking().map((point) => ({ x: point.x / rect.width, y: point.y / rect.height }));
        } else {
          const rect = ui.stage.getBoundingClientRect();
          state.paperPlane.points = state.paperPlane.points.map((point) => ({
            x: point.x + state.trackerOffset.x / rect.width,
            y: point.y + state.trackerOffset.y / rect.height,
          }));
        }
      } else {
        state.overlay.x += state.trackerOffset.x;
        state.overlay.y += state.trackerOffset.y;
      }
      state.naturalTracker = null;
      state.trackerOffset = { x: 0, y: 0 };
      state.lastConfidence = null;
    }
    if (enabled && state.anchor) {
      state.trackerOffset = { x: 0, y: 0 };
      state.lastConfidence = null;
    }
    state.tracking = enabled;
    if (enabled && isPlaneMapped()) startNaturalTracker();
    ui.studio.classList.toggle('is-tracking', enabled);
    setOverlayTransform();
    drawTrackingNodes();
    updateAnchorControl();
  }

  function clearPaperPlane() {
    setTracking(false);
    state.mapping = null;
    state.anchor = null;
    state.paperPlane = null;
    state.planeOverlay = { x: 0, y: 0, scale: 1 };
    try {
      localStorage.removeItem(ANCHOR_STORAGE_KEY);
      localStorage.removeItem(LEGACY_ANCHOR_STORAGE_KEY);
    } catch (_) { /* Keep the current session usable. */ }
    renderMapping();
    setOverlayVisible(hasOverlay());
    updateAnchorControl();
  }

  function togglePaperPlane() {
    if (state.mapping) {
      cancelMapping();
    } else if (!isPlaneMapped()) {
      startMapping();
    } else {
      setTracking(!state.tracking);
    }
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        await (document.exitFullscreen?.() || document.webkitExitFullscreen?.());
      } else {
        await (ui.studio.requestFullscreen?.() || ui.studio.webkitRequestFullscreen?.());
      }
    } catch (_) {
      // Installed web-app mode provides the fullscreen option on iPhone Safari.
    }
  }

  ui.openCamera.addEventListener('click', startCamera);
  ui.openPhotos.addEventListener('click', () => { choosePhoto(); startCamera(); });
  ui.newReference.addEventListener('click', openSourceSheet);
  ui.emptyOverlayNote.addEventListener('click', () => {
    if (state.stream) openSourceSheet(); else startCamera();
  });
  ui.closeSource.addEventListener('click', () => ui.sourceSheet.close());
  ui.sourcePhotos.addEventListener('click', choosePhoto);
  ui.captureOverlay.addEventListener('click', captureCameraView);
  ui.photoInput.addEventListener('change', (event) => {
    const [file] = event.target.files;
    if (file) loadReference(URL.createObjectURL(file), true);
    event.target.value = '';
    startCamera();
  });
  ui.opacity.addEventListener('input', updateOpacity);
  ui.lock.addEventListener('click', () => setLocked(!state.locked));
  ui.reset.addEventListener('click', resetOverlay);
  ui.anchorButton.addEventListener('click', togglePaperPlane);
  ui.clearAnchor.addEventListener('click', clearPaperPlane);
  ui.nodes.addEventListener('click', toggleNodes);
  ui.fullScreen.addEventListener('click', toggleFullscreen);
  ui.gestureLayer.addEventListener('pointerdown', gestureStart);
  ui.gestureLayer.addEventListener('pointermove', gestureMove);
  ui.gestureLayer.addEventListener('pointerup', gestureEnd);
  ui.gestureLayer.addEventListener('pointercancel', gestureEnd);
  window.addEventListener('resize', () => {
    setOverlayTransform();
    drawTrackingNodes();
  });
  window.addEventListener('pagehide', stopCamera);

  updateOpacity();
  setLocked(false);
  updateAnchorControl();
  drawTrackingNodes();
  requestAnimationFrame(trackPaper);
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./service-worker.js?v=8', { updateViaCache: 'none' }));
  }
})();
