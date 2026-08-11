(() => {
  const $ = (selector) => document.querySelector(selector);

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
  };

  const state = {
    stream: null,
    overlay: { x: 0, y: 0, scale: 1, opacity: 62 },
    pointers: new Map(),
    gestureStart: null,
    locked: false,
    objectUrl: null,
    cameraStartPromise: null,
  };

  function setOverlayTransform() {
    const { x, y, scale } = state.overlay;
    ui.referenceImage.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale})`;
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
  }

  function setLocked(locked) {
    state.locked = locked;
    ui.studio.classList.toggle('is-locked', locked);
    ui.lock.setAttribute('aria-pressed', String(locked));
    ui.lock.textContent = locked ? 'Unlock image' : 'Lock image';
  }

  async function startCamera() {
    showStudio();
    if (state.stream) return;
    if (state.cameraStartPromise) return state.cameraStartPromise;
    if (!navigator.mediaDevices?.getUserMedia) {
      ui.emptyOverlayNote.textContent = 'This browser cannot open the live camera. Try Safari on your iPhone.';
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
      })
      .catch(() => {
        ui.emptyOverlayNote.textContent = 'Allow camera access, then tap here to try the live tracing view again.';
      })
      .finally(() => { state.cameraStartPromise = null; });

    return state.cameraStartPromise;
  }

  function stopCamera() {
    state.stream?.getTracks().forEach((track) => track.stop());
    state.stream = null;
    ui.cameraFeed.srcObject = null;
    ui.studio.classList.remove('has-camera');
  }

  function openSourceSheet() {
    if (!ui.sourceSheet.open) ui.sourceSheet.showModal();
  }

  function choosePhoto() {
    if (ui.sourceSheet.open) ui.sourceSheet.close();
    ui.photoInput.click();
  }

  function loadReference(source, isObjectUrl = false) {
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
    if (state.locked || ui.referenceImage.hidden) return;
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
    state.overlay.x = 0;
    state.overlay.y = 0;
    state.overlay.scale = 1;
    setOverlayTransform();
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
  ui.fullScreen.addEventListener('click', toggleFullscreen);
  ui.gestureLayer.addEventListener('pointerdown', gestureStart);
  ui.gestureLayer.addEventListener('pointermove', gestureMove);
  ui.gestureLayer.addEventListener('pointerup', gestureEnd);
  ui.gestureLayer.addEventListener('pointercancel', gestureEnd);
  window.addEventListener('pagehide', stopCamera);

  updateOpacity();
  setLocked(false);
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./service-worker.js?v=6', { updateViaCache: 'none' }));
  }
})();
