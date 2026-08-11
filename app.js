(() => {
  const $ = (selector) => document.querySelector(selector);
  const ANCHOR_STORAGE_KEY = 'lucida-paper-anchor-v1';
  const FINGERPRINT_WIDTH = 48;
  const FINGERPRINT_HEIGHT = 36;

  const ui = {
    welcome: $('#welcome'),
    studio: $('#studio'),
    stage: $('#drawingStage'),
    cameraFeed: $('#cameraFeed'),
    referenceImage: $('#referenceImage'),
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
    anchorButton: $('#anchorButton'),
    clearAnchor: $('#clearAnchorButton'),
    anchorStatus: $('#anchorStatus'),
    anchorHint: $('#anchorHint'),
  };

  const state = {
    stream: null,
    overlay: { x: 0, y: 0, scale: 1, opacity: 62 },
    pointers: new Map(),
    gestureStart: null,
    locked: false,
    objectUrl: null,
    cameraStartPromise: null,
    anchor: readSavedAnchor(),
    tracking: false,
    trackerOffset: { x: 0, y: 0 },
    trackerCanvas: null,
    lastTrackAt: 0,
    lastConfidence: null,
  };

  function readSavedAnchor() {
    try {
      const anchor = JSON.parse(localStorage.getItem(ANCHOR_STORAGE_KEY));
      const valid = anchor
        && anchor.version === 1
        && anchor.fingerprint?.width === FINGERPRINT_WIDTH
        && anchor.fingerprint?.height === FINGERPRINT_HEIGHT
        && Array.isArray(anchor.fingerprint?.values)
        && anchor.fingerprint.values.length === FINGERPRINT_WIDTH * FINGERPRINT_HEIGHT
        && Number.isFinite(anchor.overlay?.x)
        && Number.isFinite(anchor.overlay?.y)
        && Number.isFinite(anchor.overlay?.scale);
      return valid ? anchor : null;
    } catch (_) {
      return null;
    }
  }

  function saveAnchor(anchor) {
    try {
      localStorage.setItem(ANCHOR_STORAGE_KEY, JSON.stringify(anchor));
      return true;
    } catch (_) {
      return false;
    }
  }

  function setOverlayTransform() {
    const tracker = state.tracking ? state.trackerOffset : { x: 0, y: 0 };
    const { x, y, scale } = state.overlay;
    ui.referenceImage.style.transform = `translate(-50%, -50%) translate(${x + tracker.x}px, ${y + tracker.y}px) scale(${scale})`;
  }

  function updateOpacity() {
    state.overlay.opacity = Number(ui.opacity.value);
    ui.referenceImage.style.opacity = state.overlay.opacity / 100;
    ui.opacityValue.value = `${state.overlay.opacity}%`;
    ui.opacity.style.setProperty('--slider-fill', `${state.overlay.opacity}%`);
  }

  function showStudio() {
    ui.welcome.hidden = true;
    ui.studio.hidden = false;
  }

  function setOverlayVisible(visible) {
    ui.referenceImage.hidden = !visible;
    ui.studio.classList.toggle('has-overlay', visible);
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

  function updateAnchorControl(message) {
    const hasAnchor = Boolean(state.anchor);
    ui.clearAnchor.disabled = !hasAnchor;

    if (message) {
      ui.anchorStatus.value = message;
      return;
    }

    if (!hasLiveCamera()) {
      ui.anchorStatus.value = hasAnchor ? 'Saved — open camera to use' : 'Open camera first';
      ui.anchorHint.textContent = 'The anchor watches the live camera view, so it needs the rear camera running.';
      ui.anchorButton.textContent = hasAnchor ? 'Track saved paper' : 'Set paper anchor';
      ui.anchorButton.disabled = true;
      return;
    }

    if (ui.referenceImage.hidden) {
      ui.anchorStatus.value = hasAnchor ? 'Saved — add an overlay' : 'Add an overlay first';
      ui.anchorHint.textContent = 'Choose the image you want to trace, line it up with your paper, then set the anchor.';
      ui.anchorButton.textContent = hasAnchor ? 'Track saved paper' : 'Set paper anchor';
      ui.anchorButton.disabled = true;
      return;
    }

    ui.anchorButton.disabled = false;
    if (state.tracking) {
      const confidence = state.lastConfidence === null ? 'looking…' : `${Math.round(state.lastConfidence * 100)}% match`;
      ui.anchorStatus.value = `Tracking paper · ${confidence}`;
      ui.anchorHint.textContent = 'Keep the page and its nearby visual detail in view. Small movements are corrected automatically.';
      ui.anchorButton.textContent = 'Stop tracking';
      return;
    }

    if (hasAnchor) {
      ui.anchorStatus.value = 'Saved on this iPhone';
      ui.anchorHint.textContent = 'Place the phone roughly where you saved this space, then let Lucida re-find the paper.';
      ui.anchorButton.textContent = 'Track saved paper';
      return;
    }

    ui.anchorStatus.value = 'No surface saved';
    ui.anchorHint.textContent = 'Align the overlay to your paper, then save the surface. Lucida will use camera details to steady it.';
    ui.anchorButton.textContent = 'Set paper anchor';
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
        if (!ui.studio.classList.contains('has-overlay')) {
          ui.emptyOverlayNote.textContent = 'Add a photo to place it over the live camera.';
        }
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
      state.overlay.x = 0;
      state.overlay.y = 0;
      state.overlay.scale = 1;
      setOverlayTransform();
      setOverlayVisible(true);
    };
    ui.referenceImage.src = source;
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

  function gestureMetrics() {
    const points = [...state.pointers.values()];
    if (points.length === 1) return { center: points[0], distance: 0 };
    const [a, b] = points;
    return {
      center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      distance: Math.hypot(b.x - a.x, b.y - a.y),
    };
  }

  function gestureStart(event) {
    if (state.locked || state.tracking || ui.referenceImage.hidden) return;
    event.preventDefault();
    ui.gestureLayer.setPointerCapture(event.pointerId);
    state.pointers.set(event.pointerId, stagePoint(event));
    state.gestureStart = { metrics: gestureMetrics(), overlay: { ...state.overlay } };
  }

  function gestureMove(event) {
    if (!state.pointers.has(event.pointerId) || !state.gestureStart) return;
    event.preventDefault();
    state.pointers.set(event.pointerId, stagePoint(event));
    const next = gestureMetrics();
    const start = state.gestureStart;
    state.overlay.x = start.overlay.x + (next.center.x - start.metrics.center.x);
    state.overlay.y = start.overlay.y + (next.center.y - start.metrics.center.y);
    if (next.distance && start.metrics.distance) {
      state.overlay.scale = Math.min(4, Math.max(.2, start.overlay.scale * (next.distance / start.metrics.distance)));
    }
    setOverlayTransform();
  }

  function gestureEnd(event) {
    state.pointers.delete(event.pointerId);
    if (state.pointers.size) {
      state.gestureStart = { metrics: gestureMetrics(), overlay: { ...state.overlay } };
    } else {
      state.gestureStart = null;
    }
  }

  function resetOverlay() {
    setTracking(false);
    state.overlay.x = 0;
    state.overlay.y = 0;
    state.overlay.scale = 1;
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
    if (!state.tracking || !state.anchor || timestamp - state.lastTrackAt < 160) return;
    state.lastTrackAt = timestamp;
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
      state.overlay.x += state.trackerOffset.x;
      state.overlay.y += state.trackerOffset.y;
      state.trackerOffset = { x: 0, y: 0 };
      state.lastConfidence = null;
    }
    if (enabled && state.anchor) {
      state.overlay.x = state.anchor.overlay.x;
      state.overlay.y = state.anchor.overlay.y;
      state.overlay.scale = state.anchor.overlay.scale;
      state.trackerOffset = { x: 0, y: 0 };
      state.lastConfidence = null;
    }
    state.tracking = enabled;
    ui.studio.classList.toggle('is-tracking', enabled);
    setOverlayTransform();
    updateAnchorControl();
  }

  function setPaperAnchor() {
    const fingerprint = getFingerprint();
    if (!fingerprint) {
      updateAnchorControl('Camera needed');
      return;
    }
    if (fingerprint.detail < .045) {
      ui.anchorStatus.value = 'Need more surface detail';
      ui.anchorHint.textContent = 'Aim at a paper edge, desk grain, tape, or another visible detail, then try again.';
      return;
    }
    state.anchor = {
      version: 1,
      createdAt: new Date().toISOString(),
      fingerprint,
      overlay: { x: state.overlay.x, y: state.overlay.y, scale: state.overlay.scale },
    };
    const saved = saveAnchor(state.anchor);
    setTracking(true);
    if (!saved) updateAnchorControl('Tracking — not saved');
  }

  function togglePaperTracking() {
    if (state.tracking) {
      setTracking(false);
    } else if (state.anchor) {
      setTracking(true);
    } else {
      setPaperAnchor();
    }
  }

  function clearPaperAnchor() {
    setTracking(false);
    state.anchor = null;
    try { localStorage.removeItem(ANCHOR_STORAGE_KEY); } catch (_) { /* Keep the current session usable. */ }
    updateAnchorControl();
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
  ui.anchorButton.addEventListener('click', togglePaperTracking);
  ui.clearAnchor.addEventListener('click', clearPaperAnchor);
  ui.fullScreen.addEventListener('click', toggleFullscreen);
  ui.gestureLayer.addEventListener('pointerdown', gestureStart);
  ui.gestureLayer.addEventListener('pointermove', gestureMove);
  ui.gestureLayer.addEventListener('pointerup', gestureEnd);
  ui.gestureLayer.addEventListener('pointercancel', gestureEnd);
  window.addEventListener('pagehide', stopCamera);

  updateOpacity();
  setLocked(false);
  updateAnchorControl();
  requestAnimationFrame(trackPaper);
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./service-worker.js?v=7', { updateViaCache: 'none' }));
  }
})();
