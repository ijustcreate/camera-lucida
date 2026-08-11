(() => {
  const $ = (selector) => document.querySelector(selector);

  const ui = {
    welcome: $('#welcome'),
    studio: $('#studio'),
    drawingStage: $('#drawingStage'),
    referenceImage: $('#referenceImage'),
    referenceVideo: $('#referenceVideo'),
    photoInput: $('#photoInput'),
    openPhotos: $('#openPhotosButton'),
    newReference: $('#newReferenceButton'),
    openCamera: $('#openCameraButton'),
    cameraSheet: $('#cameraSheet'),
    cameraVideo: $('#cameraVideo'),
    cameraMessage: $('#cameraMessage'),
    closeCamera: $('#closeCameraButton'),
    cameraPhoto: $('#cameraPhotoButton'),
    startLiveCamera: $('#startLiveCameraButton'),
    capture: $('#captureButton'),
    fullScreen: $('#fullScreenButton'),
    canvas: $('#drawingCanvas'),
    opacity: $('#opacityRange'),
    opacityValue: $('#opacityValue'),
    opacityNotch: $('#opacityNotch'),
    brush: $('#brushRange'),
    brushValue: $('#brushValue'),
    brushNotch: $('#brushNotch'),
    toolButtons: [...document.querySelectorAll('[data-tool]')],
    gestureLayer: $('#gestureLayer'),
    stageNote: $('#stageNote'),
    undo: $('#undoButton'),
    clear: $('#clearButton'),
  };

  const ctx = ui.canvas.getContext('2d', { willReadFrequently: true });
  const state = {
    mode: 'draw',
    opacity: 54,
    brush: 3,
    isDrawing: false,
    drawingPointerId: null,
    lastPoint: null,
    strokes: [],
    image: { x: 0, y: 0, scale: 1 },
    gesturePointers: new Map(),
    gestureStart: null,
    stream: null,
    cameraInStudio: false,
  };

  function setImageTransform() {
    const { x, y, scale } = state.image;
    const transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale})`;
    ui.referenceImage.style.transform = transform;
    ui.referenceVideo.style.transform = transform;
  }

  function updateDial(input, output, notch, value, min, max, suffix = '') {
    output.value = `${value}${suffix}`;
    const ratio = (value - min) / (max - min);
    notch.style.transform = `rotate(${-132 + ratio * 264}deg)`;
  }

  function updateOpacity() {
    state.opacity = Number(ui.opacity.value);
    ui.referenceImage.style.opacity = state.opacity / 100;
    ui.referenceVideo.style.opacity = state.opacity / 100;
    updateDial(ui.opacity, ui.opacityValue, ui.opacityNotch, state.opacity, 5, 100, '%');
  }

  function updateBrush() {
    state.brush = Number(ui.brush.value);
    updateDial(ui.brush, ui.brushValue, ui.brushNotch, state.brush, 1, 16);
  }

  function canvasPoint(event) {
    const rect = ui.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function fitCanvas() {
    const rect = ui.drawingStage.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    if (!rect.width || !rect.height) return;
    const snapshot = document.createElement('canvas');
    snapshot.width = ui.canvas.width;
    snapshot.height = ui.canvas.height;
    snapshot.getContext('2d').drawImage(ui.canvas, 0, 0);
    ui.canvas.width = Math.round(rect.width * ratio);
    ui.canvas.height = Math.round(rect.height * ratio);
    ui.canvas.style.width = `${rect.width}px`;
    ui.canvas.style.height = `${rect.height}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (snapshot.width) ctx.drawImage(snapshot, 0, 0, snapshot.width, snapshot.height, 0, 0, rect.width, rect.height);
  }

  function setTool(mode) {
    state.mode = mode;
    ui.studio.classList.toggle('is-moving', mode === 'move');
    ui.toolButtons.forEach((button) => {
      const active = button.dataset.tool === mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    if (mode === 'move') showStageNote();
  }

  let noteTimer;
  function showStageNote() {
    ui.stageNote.classList.add('is-visible');
    window.clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => ui.stageNote.classList.remove('is-visible'), 2600);
  }

  function beginStroke(event) {
    if (state.mode === 'move' || event.button === 2 || state.isDrawing || (event.pointerType === 'touch' && !event.isPrimary)) return;
    event.preventDefault();
    state.isDrawing = true;
    state.drawingPointerId = event.pointerId;
    state.lastPoint = canvasPoint(event);
    ui.canvas.setPointerCapture(event.pointerId);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = state.mode === 'erase' ? state.brush * 4 : state.brush;
    ctx.strokeStyle = '#24211d';
    ctx.globalCompositeOperation = state.mode === 'erase' ? 'destination-out' : 'source-over';
    ctx.beginPath();
    ctx.moveTo(state.lastPoint.x, state.lastPoint.y);
  }

  function drawStroke(event) {
    if (!state.isDrawing || event.pointerId !== state.drawingPointerId) return;
    event.preventDefault();
    const point = canvasPoint(event);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    state.lastPoint = point;
  }

  function endStroke(event) {
    if (!state.isDrawing || event.pointerId !== state.drawingPointerId) return;
    const point = canvasPoint(event);
    if (Math.abs(point.x - state.lastPoint.x) < .1 && Math.abs(point.y - state.lastPoint.y) < .1) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, (state.mode === 'erase' ? state.brush * 4 : state.brush) / 2, 0, Math.PI * 2);
      ctx.fillStyle = state.mode === 'erase' ? 'rgba(0,0,0,1)' : '#24211d';
      ctx.fill();
    }
    ctx.restore();
    state.isDrawing = false;
    state.drawingPointerId = null;
    state.lastPoint = null;
    saveHistory();
  }

  function saveHistory() {
    if (state.strokes.length > 25) state.strokes.shift();
    state.strokes.push(ui.canvas.toDataURL('image/png'));
  }

  function restoreHistory() {
    if (state.strokes.length <= 1) return;
    state.strokes.pop();
    const previous = state.strokes.at(-1);
    ctx.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
    if (!previous) return;
    const image = new Image();
    image.onload = () => {
      const ratio = window.devicePixelRatio || 1;
      ctx.save();
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const rect = ui.drawingStage.getBoundingClientRect();
      ctx.drawImage(image, 0, 0, rect.width, rect.height);
      ctx.restore();
    };
    image.src = previous;
  }

  function clearDrawing() {
    if (!state.strokes.length && !window.confirm('Clear this blank page?')) return;
    if (state.strokes.length && !window.confirm('Clear every line from this page?')) return;
    ctx.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
    state.strokes = [''];
  }

  function revealStudio() {
    ui.welcome.hidden = true;
    ui.studio.hidden = false;
    requestAnimationFrame(() => {
      fitCanvas();
      state.strokes = [''];
    });
  }

  function loadReference(source) {
    stopCamera();
    ui.referenceVideo.hidden = true;
    ui.referenceImage.hidden = false;
    ui.referenceImage.onload = () => {
      state.image = { x: 0, y: 0, scale: 1 };
      setImageTransform();
      revealStudio();
      setTool('draw');
    };
    ui.referenceImage.src = source;
  }

  function choosePhoto() {
    stopCamera();
    if (ui.cameraSheet.open) ui.cameraSheet.close();
    ui.photoInput.click();
  }

  async function openCamera() {
    stopCamera();
    if (!navigator.mediaDevices?.getUserMedia) {
      ui.cameraMessage.textContent = 'Camera access is not available in this browser. Choose a photo instead.';
      ui.cameraMessage.hidden = false;
      ui.capture.disabled = true;
      ui.startLiveCamera.disabled = true;
      ui.cameraSheet.showModal();
      return;
    }
    ui.cameraMessage.hidden = true;
    ui.capture.disabled = false;
    ui.startLiveCamera.disabled = false;
    ui.cameraSheet.showModal();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      state.stream = stream;
      ui.cameraVideo.srcObject = stream;
    } catch (error) {
      ui.cameraMessage.textContent = 'Allow camera access to use a live reference, or choose a photo instead.';
      ui.cameraMessage.hidden = false;
      ui.capture.disabled = true;
      ui.startLiveCamera.disabled = true;
    }
  }

  function stopCamera() {
    state.stream?.getTracks().forEach((track) => track.stop());
    state.stream = null;
    ui.cameraVideo.srcObject = null;
    ui.referenceVideo.srcObject = null;
    ui.referenceVideo.hidden = true;
    state.cameraInStudio = false;
  }

  function startLiveCamera() {
    if (!state.stream) return;
    state.cameraInStudio = true;
    ui.referenceImage.hidden = true;
    ui.referenceVideo.hidden = false;
    ui.referenceVideo.srcObject = state.stream;
    ui.referenceVideo.play().catch(() => {});
    ui.cameraVideo.srcObject = null;
    state.image = { x: 0, y: 0, scale: 1 };
    setImageTransform();
    updateOpacity();
    ui.cameraSheet.close();
    revealStudio();
    setTool('draw');
  }

  function captureCamera() {
    if (!ui.cameraVideo.videoWidth) return;
    const captureCanvas = document.createElement('canvas');
    captureCanvas.width = ui.cameraVideo.videoWidth;
    captureCanvas.height = ui.cameraVideo.videoHeight;
    captureCanvas.getContext('2d').drawImage(ui.cameraVideo, 0, 0);
    loadReference(captureCanvas.toDataURL('image/jpeg', .92));
    ui.cameraSheet.close();
  }

  function getGestureMetrics() {
    const points = [...state.gesturePointers.values()];
    if (points.length === 1) return { center: points[0], distance: 0 };
    const [a, b] = points;
    return {
      center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      distance: Math.hypot(b.x - a.x, b.y - a.y),
    };
  }

  function gestureStart(event) {
    ui.gestureLayer.setPointerCapture(event.pointerId);
    state.gesturePointers.set(event.pointerId, canvasPoint(event));
    const metrics = getGestureMetrics();
    state.gestureStart = { metrics, image: { ...state.image } };
  }

  function gestureMove(event) {
    if (!state.gesturePointers.has(event.pointerId) || !state.gestureStart) return;
    state.gesturePointers.set(event.pointerId, canvasPoint(event));
    const now = getGestureMetrics();
    const start = state.gestureStart;
    state.image.x = start.image.x + (now.center.x - start.metrics.center.x);
    state.image.y = start.image.y + (now.center.y - start.metrics.center.y);
    if (now.distance && start.metrics.distance) {
      state.image.scale = Math.min(4, Math.max(.3, start.image.scale * (now.distance / start.metrics.distance)));
    }
    setImageTransform();
  }

  function gestureEnd(event) {
    state.gesturePointers.delete(event.pointerId);
    if (state.gesturePointers.size) {
      const metrics = getGestureMetrics();
      state.gestureStart = { metrics, image: { ...state.image } };
    } else {
      state.gestureStart = null;
    }
  }

  async function toggleFullscreen() {
    const element = ui.studio;
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        await (document.exitFullscreen?.() || document.webkitExitFullscreen?.());
      } else {
        await (element.requestFullscreen?.() || element.webkitRequestFullscreen?.());
      }
    } catch (_) {
      // iOS Safari uses its installed web-app mode for a full-screen experience.
    }
  }

  ui.openPhotos.addEventListener('click', choosePhoto);
  ui.newReference.addEventListener('click', openCamera);
  ui.photoInput.addEventListener('change', (event) => {
    const [file] = event.target.files;
    if (file) loadReference(URL.createObjectURL(file));
    event.target.value = '';
  });
  ui.openCamera.addEventListener('click', openCamera);
  ui.closeCamera.addEventListener('click', () => { stopCamera(); ui.cameraSheet.close(); });
  ui.cameraPhoto.addEventListener('click', choosePhoto);
  ui.startLiveCamera.addEventListener('click', startLiveCamera);
  ui.capture.addEventListener('click', captureCamera);
  ui.cameraSheet.addEventListener('close', () => { if (!state.cameraInStudio) stopCamera(); });
  ui.fullScreen.addEventListener('click', toggleFullscreen);
  ui.opacity.addEventListener('input', updateOpacity);
  ui.brush.addEventListener('input', updateBrush);
  ui.toolButtons.forEach((button) => button.addEventListener('click', () => setTool(button.dataset.tool)));
  ui.undo.addEventListener('click', restoreHistory);
  ui.clear.addEventListener('click', clearDrawing);
  ui.canvas.addEventListener('pointerdown', beginStroke);
  ui.canvas.addEventListener('pointermove', drawStroke);
  ui.canvas.addEventListener('pointerup', endStroke);
  ui.canvas.addEventListener('pointercancel', endStroke);
  ui.canvas.addEventListener('lostpointercapture', endStroke);
  ui.gestureLayer.addEventListener('pointerdown', gestureStart);
  ui.gestureLayer.addEventListener('pointermove', gestureMove);
  ui.gestureLayer.addEventListener('pointerup', gestureEnd);
  ui.gestureLayer.addEventListener('pointercancel', gestureEnd);
  window.addEventListener('resize', fitCanvas);
  window.addEventListener('pagehide', stopCamera);

  updateOpacity();
  updateBrush();
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./service-worker.js'));
})();
