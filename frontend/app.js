/* ═══════════════════════════════════════════════════
   WasteVision — app.js
   Connects UI to your Flask/FastAPI backend.

   ╔══════════════════════════════════════════════╗
   ║  ONLY LINE YOU NEED TO CHANGE:               ║
   ║  const API_BASE = "http://localhost:5000"     ║
   ║  Replace with your actual backend URL         ║
   ╚══════════════════════════════════════════════╝
   ═══════════════════════════════════════════════════ */

// ── CONFIG ────────────────────────────────────────────
// ▼▼▼  CHANGE THIS to your backend server URL  ▼▼▼
const API_BASE =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:5000"
    : "https://enhanced-garbage-detection.onrender.com";
// ▲▲▲  e.g. "http://192.168.1.10:5000" on LAN  ▲▲▲
// ▲▲▲  or "https://your-app.onrender.com"       ▲▲▲

const DETECT_ENDPOINT = `${API_BASE}/detect`;
const HEALTH_ENDPOINT = `${API_BASE}/health`;

// ── Class data (mirrors backend CLASS_NAMES) ──────────
const CLASS_NAMES = [
  'Aluminium foil', 'Bottle cap', 'Bottle', 'Broken glass', 'Can',
  'Carton', 'Cigarette', 'Cup', 'Lid', 'Other litter',
  'Other plastic', 'Paper', 'Plastic bag - wrapper',
  'Plastic container', 'Pop tab', 'Straw', 'Styrofoam piece', 'Unlabeled litter'
];

// Earthy, distinct palette — no neon
const CLASS_COLORS = [
  '#7B6FAB', '#C4572A', '#3A7D6E', '#BF4040', '#D4892A',
  '#4A7CA8', '#6B3A8C', '#2A8C5A', '#B07830', '#8C8880',
  '#C45C8C', '#4A7C4A', '#C4844A', '#3A6AA8', '#A8903A',
  '#C44A4A', '#5C8C9A', '#7A7A8C'
];

// ── DOM refs ──────────────────────────────────────────
const $ = id => document.getElementById(id);
const dropzone       = $('dropzone');
const imageInput     = $('imageInput');
const dzIdle         = $('dzIdle');
const dzPreview      = $('dzPreview');
const previewImg     = $('previewImg');
const removeBtn      = $('removeBtn');
const confSlider     = $('confSlider');
const confDisplay    = $('confDisplay');
const runBtn         = $('runBtn');
const canvasWrap     = $('canvasWrap');
const canvasEmpty    = $('canvasEmpty');
const resultCanvas   = $('resultCanvas');
const canvasToolbar  = $('canvasToolbar');
const downloadBtn    = $('downloadBtn');
const detectionsPanel = $('detectionsPanel');
const totalBadge     = $('totalBadge');
const classBadge     = $('classBadge');
const detList        = $('detList');
const distBars       = $('distBars');
const classesGrid    = $('classesGrid');
const loadingOverlay = $('loadingOverlay');
const apiDot         = $('apiDot');
const apiText        = $('apiText');
const webcamFeed     = $('webcamFeed');
const webcamIdle     = $('webcamIdle');
const webcamCanvas   = $('webcamCanvas');
const liveDot        = $('liveDot');
const startCamBtn    = $('startCamBtn');
const captureBtn     = $('captureBtn');

// ── State ─────────────────────────────────────────────
let currentImage = null;
let cameraStream  = null;
let activeTab     = 'upload';

// ── Health check ──────────────────────────────────────
async function checkHealth() {
  try {
    const r = await fetch(HEALTH_ENDPOINT, { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      apiDot.className = 'api-dot ok';
      apiText.textContent = 'Backend connected — model ready';
    } else {
      throw new Error('non-ok');
    }
  } catch {
    apiDot.className = 'api-dot err';
    apiText.textContent = 'Backend offline — start server first';
  }
}
checkHealth();
setInterval(checkHealth, 15000);

// ── Tabs ──────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    activeTab = btn.dataset.tab;
    $(`tab-${activeTab}`).classList.add('active');
    // only allow run if image loaded for upload tab
    if (activeTab === 'upload') runBtn.disabled = !currentImage;
    else runBtn.disabled = true;
  });
});

// ── Confidence slider ─────────────────────────────────
confSlider.addEventListener('input', () => {
  confDisplay.textContent = (confSlider.value / 100).toFixed(2);
});

// ── Drag & drop ───────────────────────────────────────
dropzone.addEventListener('dragover', e => {
  e.preventDefault();
  dropzone.classList.add('drag-over');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith('image/')) loadFile(f);
});
imageInput.addEventListener('change', () => {
  if (imageInput.files[0]) loadFile(imageInput.files[0]);
});
removeBtn.addEventListener('click', e => {
  e.stopPropagation(); clearImage();
});

function loadFile(file) {
  const url = URL.createObjectURL(file);
  currentImage = new Image();
  currentImage.onload = () => {
    previewImg.src = url;
    dzIdle.style.display = 'none';
    dzPreview.style.display = 'block';
    runBtn.disabled = false;
  };
  currentImage.src = url;
  currentImage._file = file;  // keep reference for FormData
}

function clearImage() {
  currentImage = null;
  imageInput.value = '';
  previewImg.src = '';
  dzIdle.style.display = '';
  dzPreview.style.display = 'none';
  runBtn.disabled = true;
}

// ── Webcam ────────────────────────────────────────────
startCamBtn.addEventListener('click', async () => {
  if (cameraStream) {
    stopCamera(); return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280 } });
    webcamFeed.srcObject = cameraStream;
    webcamFeed.style.display = 'block';
    webcamIdle.style.display = 'none';
    liveDot.style.display = 'block';
    captureBtn.disabled = false;
    startCamBtn.textContent = 'Stop Camera';
    startCamBtn.classList.add('btn--outline');
  } catch (err) {
    alert('Camera access denied: ' + err.message);
  }
});

function stopCamera() {
  cameraStream?.getTracks().forEach(t => t.stop());
  cameraStream = null;
  webcamFeed.style.display = 'none';
  webcamFeed.srcObject = null;
  webcamIdle.style.display = '';
  liveDot.style.display = 'none';
  captureBtn.disabled = true;
  startCamBtn.textContent = 'Start Camera';
}

captureBtn.addEventListener('click', () => {
  if (!cameraStream) return;
  webcamCanvas.width  = webcamFeed.videoWidth;
  webcamCanvas.height = webcamFeed.videoHeight;
  webcamCanvas.getContext('2d').drawImage(webcamFeed, 0, 0);

  webcamCanvas.toBlob(blob => {
    const file = new File([blob], 'capture.jpg', { type: 'image/jpeg' });
    const img  = new Image();
    img.onload = () => {
      currentImage = img;
      currentImage._file = file;
      runDetection();
    };
    img.src = URL.createObjectURL(blob);
  }, 'image/jpeg', 0.92);
});

// ── Run detection ─────────────────────────────────────
runBtn.addEventListener('click', runDetection);

async function runDetection() {
  if (!currentImage?._file) return;

  showLoading(true);
  runBtn.disabled = true;

  const formData = new FormData();
  formData.append('image', currentImage._file);
  formData.append('conf', (confSlider.value / 100).toFixed(2));

  try {
    // ─────────────────────────────────────────────────────────────
    // API CALL — POST image to your backend
    // Response format (JSON array):
    // [
    //   { "classId": 2, "className": "Bottle",
    //     "conf": 0.87, "x": 120, "y": 55, "w": 210, "h": 180 },
    //   ...
    // ]
    // x, y = top-left corner in pixels; w, h = box width/height
    // ─────────────────────────────────────────────────────────────
    const response = await fetch(DETECT_ENDPOINT, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) throw new Error(`Server error ${response.status}`);

    const detections = await response.json();
    renderAll(currentImage, detections);

  } catch (err) {
    alert('Detection failed: ' + err.message + '\n\nMake sure your backend is running at:\n' + API_BASE);
  } finally {
    showLoading(false);
    runBtn.disabled = false;
  }
}

// ── Draw bounding boxes on canvas ────────────────────
function drawBoxes(img, dets) {
  const ctx = resultCanvas.getContext('2d');
  resultCanvas.width  = img.width;
  resultCanvas.height = img.height;
  ctx.drawImage(img, 0, 0);

  const scale  = img.width / 900;  // scale labels to image size
  const fSize  = Math.max(13, Math.min(22, 14 * scale));
  const lw     = Math.max(2, 2.5 * scale);

  dets.forEach(det => {
    const color = CLASS_COLORS[det.classId] ?? '#888';
    const label = `${det.className}  ${(det.conf * 100).toFixed(0)}%`;

    // Box stroke
    ctx.strokeStyle = color;
    ctx.lineWidth   = lw;
    ctx.strokeRect(det.x, det.y, det.w, det.h);

    // Box fill (semi-transparent)
    ctx.fillStyle = color + '1A';
    ctx.fillRect(det.x, det.y, det.w, det.h);

    // Label background
    ctx.font = `600 ${fSize}px Outfit, sans-serif`;
    const tw = ctx.measureText(label).width;
    const th = fSize * 1.7;
    const lx = det.x;
    const ly = det.y >= th + 4 ? det.y - th - 4 : det.y + 4;

    ctx.fillStyle = color;
    roundRect(ctx, lx, ly, tw + 16, th, 4);
    ctx.fill();

    // Label text
    ctx.fillStyle = '#fff';
    ctx.fillText(label, lx + 8, ly + th * 0.7);
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── Render results panel ──────────────────────────────
function renderAll(img, dets) {
  drawBoxes(img, dets);

  // Show canvas
  canvasEmpty.style.display  = 'none';
  resultCanvas.style.display = 'block';
  canvasToolbar.style.display = '';

  // Counts
  const classCounts = {};
  dets.forEach(d => { classCounts[d.classId] = (classCounts[d.classId] || 0) + 1; });
  const numClasses = Object.keys(classCounts).length;

  totalBadge.textContent = `${dets.length} object${dets.length !== 1 ? 's' : ''}`;
  classBadge.textContent = `${numClasses} class${numClasses !== 1 ? 'es' : ''}`;
  detectionsPanel.style.display = '';

  // Detection list
  const sorted = [...dets].sort((a, b) => b.conf - a.conf);
  detList.innerHTML = sorted.map((d, i) => {
    const c = d.conf;
    const cls = c >= 0.7 ? 'hi' : c >= 0.5 ? 'mid' : 'lo';
    return `
      <div class="det-item">
        <span class="det-n">${i + 1}</span>
        <span class="det-swatch" style="background:${CLASS_COLORS[d.classId] ?? '#888'}"></span>
        <span class="det-name">${d.className}</span>
        <span class="det-conf ${cls}">${(c * 100).toFixed(0)}%</span>
      </div>`;
  }).join('') || '<div style="padding:24px;text-align:center;color:#8c8880;font-size:13px">No objects detected above threshold</div>';

  // Distribution bars
  const sorted2 = Object.entries(classCounts).sort((a, b) => b[1] - a[1]);
  const maxC    = sorted2[0]?.[1] || 1;
  distBars.innerHTML = sorted2.map(([cid, cnt]) => `
    <div class="dist-row">
      <span class="dist-name">${CLASS_NAMES[+cid]}</span>
      <div class="dist-track">
        <div class="dist-fill" style="width:${(cnt / maxC * 100).toFixed(0)}%;background:${CLASS_COLORS[+cid] ?? '#888'}"></div>
      </div>
      <span class="dist-count">${cnt}</span>
    </div>`).join('');

  // Class chips
  const detectedIds = new Set(Object.keys(classCounts).map(Number));
  buildClassGrid(detectedIds);

  // Scroll to results
  resultCanvas.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Class chips ───────────────────────────────────────
function buildClassGrid(activeIds = new Set()) {
  classesGrid.innerHTML = CLASS_NAMES.map((name, i) => `
    <div class="class-chip ${activeIds.has(i) ? 'active' : ''}">
      <span class="chip-dot" style="background:${CLASS_COLORS[i]}"></span>
      ${name}
    </div>`).join('');
}
buildClassGrid();

// ── Download ──────────────────────────────────────────
downloadBtn.addEventListener('click', () => {
  const a = document.createElement('a');
  a.download = `wastevision_${Date.now()}.png`;
  a.href = resultCanvas.toDataURL('image/png');
  a.click();
});

// ── Utility ───────────────────────────────────────────
function showLoading(on) {
  loadingOverlay.classList.toggle('active', on);
}
