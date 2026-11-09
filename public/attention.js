// attention.js
// Student side: runs MediaPipe Face Landmarker locally, scores attention,
//               sends ONLY { score, confidence, low } to the server.
// Host side:    shows a small live panel with each student's score.
//
// Usage (from meeting.js, after a successful join):
//   import { startAttention } from "./attention.js";
//   startAttention({ socket, isHost: ack.isHost });

/* ---------------- Tunables ---------------- */

const VISION_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const SAMPLE_MS = 200;          // ~5 frames per second
const REPORT_MS = 2000;         // send one score every 2 seconds
const CALIBRATION_FRAMES = 15;  // learn the student's "looking at screen" pose
const LOW_CONF = 50;            // confidence below this counts as low
const LOW_TO_ALERT = 3;         // consecutive low windows before alerting
const OK_TO_CLEAR = 2;          // consecutive good windows before clearing
const STALE_MS = 8000;          // host panel: no update for this long = no data

// Head pose tolerance (degrees, after calibration)
const YAW_FREE = 15, YAW_RANGE = 30;
const PITCH_FREE = 15, PITCH_RANGE = 25;

// Eye aspect ratio: closed below EAR_CLOSED, fully open above EAR_OPEN
const EAR_CLOSED = 0.15, EAR_OPEN = 0.22;

// Face width as a fraction of the frame; smaller = too far away
const MIN_FACE_WIDTH = 0.18;

/* ---------------- Helpers ---------------- */

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const RAD = 180 / Math.PI;

const LEFT_EYE = [33, 160, 158, 133, 153, 144];
const RIGHT_EYE = [362, 385, 387, 263, 373, 380];

function dist(a, b, w, h) {
  return Math.hypot((a.x - b.x) * w, (a.y - b.y) * h);
}

function eyeAspectRatio(lm, idx, w, h) {
  const [p1, p2, p3, p4, p5, p6] = idx.map((i) => lm[i]);
  const horizontal = dist(p1, p4, w, h) || 1;
  return (dist(p2, p6, w, h) + dist(p3, p5, w, h)) / (2 * horizontal);
}

// 4x4 column-major transform -> yaw / pitch in degrees
function headPose(matrix) {
  if (!matrix || !matrix.data) return { yaw: 0, pitch: 0 };
  const m = matrix.data;
  const yaw = Math.atan2(-m[2], Math.hypot(m[0], m[1])) * RAD;
  let pitch = Math.atan2(m[6], m[10]) * RAD;
  if (pitch > 90) pitch -= 180;
  else if (pitch < -90) pitch += 180;
  return { yaw, pitch };
}

function frameScore(yaw, pitch, ear) {
  const yawOk = 1 - clamp01((Math.abs(yaw) - YAW_FREE) / YAW_RANGE);
  const pitchOk = 1 - clamp01((Math.abs(pitch) - PITCH_FREE) / PITCH_RANGE);
  const headFacing = Math.min(yawOk, pitchOk);
  const eyesOpen = clamp01((ear - EAR_CLOSED) / (EAR_OPEN - EAR_CLOSED));
  return 100 * (0.6 * headFacing + 0.4 * eyesOpen);
}

function injectStyles() {
  if (document.getElementById("attention-styles")) return;
  const style = document.createElement("style");
  style.id = "attention-styles";
  style.textContent = `
    .att-alert {
      position: fixed; top: 76px; left: 50%; transform: translateX(-50%);
      z-index: 30; max-width: 90vw; padding: 10px 16px; border-radius: 10px;
      background: #d93025; color: #fff; font: 600 14px "Segoe UI", system-ui, Arial, sans-serif;
      box-shadow: 0 4px 16px rgba(0,0,0,.25);
    }
    .att-alert[hidden] { display: none; }
    .att-panel {
      position: fixed; top: 80px; right: 16px; z-index: 20; width: 270px;
      max-height: 60vh; overflow-y: auto; padding: 12px; border-radius: 12px;
      background: #fff; color: #232333; border: 1px solid #e5e5ea;
      box-shadow: 0 6px 24px rgba(0,0,0,.18);
      font: 14px "Segoe UI", system-ui, Arial, sans-serif;
    }
    .att-panel h3 { margin: 0 0 8px; font-size: 14px; }
    .att-empty { margin: 0; color: #777783; font-size: 13px; }
    .att-row {
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px; padding: 7px 0; border-top: 1px solid #e5e5ea;
    }
    .att-row:first-of-type { border-top: 0; }
    .att-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .att-value { font-weight: 700; flex-shrink: 0; }
    .att-value--good { color: #1e8e3e; }
    .att-value--mid { color: #b26a00; }
    .att-value--bad { color: #d93025; }
    .att-value--muted { color: #777783; font-weight: 500; }
    .att-badge {
      padding: 2px 8px; border-radius: 6px; background: #fdecea;
      color: #d93025; font-size: 12px; font-weight: 600; flex-shrink: 0;
    }
  `;
  document.head.appendChild(style);
}

/* ---------------- Student side ---------------- */

async function createLandmarker() {
  const { FaceLandmarker, FilesetResolver } = await import(
    `${VISION_URL}/vision_bundle.mjs`
  );
  const fileset = await FilesetResolver.forVisionTasks(`${VISION_URL}/wasm`);

  const make = (delegate) =>
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFacialTransformationMatrixes: true
    });

  try {
    return await make("GPU");
  } catch {
    return await make("CPU");
  }
}

function waitForVideo(videoEl) {
  return new Promise((resolve) => {
    const tick = () => {
      const v = videoEl || document.querySelector(".tile--self video");
      if (v && v.readyState >= 2 && v.videoWidth > 0) resolve(v);
      else setTimeout(tick, 300);
    };
    tick();
  });
}

async function startStudentMonitor(socket, videoEl) {
  injectStyles();

  const alertEl = document.createElement("div");
  alertEl.className = "att-alert";
  alertEl.hidden = true;
  alertEl.setAttribute("role", "alert");
  alertEl.textContent =
    "We can't see you clearly. Please check your camera, lighting and position.";
  document.body.appendChild(alertEl);

  let landmarker;
  try {
    landmarker = await createLandmarker();
  } catch (err) {
    console.error("Attention model failed to load:", err);
    return () => alertEl.remove();
  }

  const video = await waitForVideo(videoEl);

  // calibration: learn the student's normal head pose
  let calN = 0;
  const calSum = { yaw: 0, pitch: 0 };
  let offset = { yaw: 0, pitch: 0 };

  // per-window accumulators
  let win = { total: 0, face: 0, scoreSum: 0, sizeSum: 0 };
  let smooth = null;
  let lowRun = 0;
  let okRun = 0;
  let low = false;

  function sample() {
    if (video.readyState < 2) return;

    let res;
    try {
      res = landmarker.detectForVideo(video, performance.now());
    } catch (err) {
      return;
    }

    win.total++;
    const lm = res.faceLandmarks && res.faceLandmarks[0];
    if (!lm) return;

    const w = video.videoWidth;
    const h = video.videoHeight;

    // face width as a fraction of the frame
    let minX = 1, maxX = 0;
    for (const p of lm) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
    }

    const ear =
      (eyeAspectRatio(lm, LEFT_EYE, w, h) +
        eyeAspectRatio(lm, RIGHT_EYE, w, h)) / 2;

    let { yaw, pitch } = headPose(
      res.facialTransformationMatrixes && res.facialTransformationMatrixes[0]
    );

    if (calN < CALIBRATION_FRAMES) {
      calSum.yaw += yaw;
      calSum.pitch += pitch;
      calN++;
      if (calN === CALIBRATION_FRAMES) {
        offset = { yaw: calSum.yaw / calN, pitch: calSum.pitch / calN };
      }
      yaw = 0;
      pitch = 0;
    } else {
      yaw -= offset.yaw;
      pitch -= offset.pitch;
    }

    win.face++;
    win.scoreSum += frameScore(yaw, pitch, ear);
    win.sizeSum += maxX - minX;
  }

  function report() {
    const presence = win.total ? win.face / win.total : 0;
    const avgSize = win.face ? win.sizeSum / win.face : 0;
    const confidence = Math.round(
      100 * presence * clamp01(avgSize / MIN_FACE_WIDTH)
    );

    if (win.face) {
      const raw = win.scoreSum / win.face;
      smooth = smooth === null ? raw : 0.6 * smooth + 0.4 * raw;
    }

    // debounce / hysteresis for the low-confidence alert
    if (confidence < LOW_CONF) {
      lowRun++;
      okRun = 0;
    } else {
      okRun++;
      lowRun = 0;
    }
    if (!low && lowRun >= LOW_TO_ALERT) low = true;
    if (low && okRun >= OK_TO_CLEAR) low = false;
    alertEl.hidden = !low;

    socket.emit("attention", {
      score: Math.round(smooth === null ? 0 : smooth),
      confidence,
      low
    });

    win = { total: 0, face: 0, scoreSum: 0, sizeSum: 0 };
  }

  const sampleTimer = setInterval(sample, SAMPLE_MS);
  const reportTimer = setInterval(report, REPORT_MS);

  return function stop() {
    clearInterval(sampleTimer);
    clearInterval(reportTimer);
    alertEl.remove();
    landmarker.close();
  };
}

/* ---------------- Host side ---------------- */

function startHostPanel(socket) {
  injectStyles();

  const panel = document.createElement("aside");
  panel.className = "att-panel";
  panel.innerHTML = "<h3>Attention</h3>";
  const empty = document.createElement("p");
  empty.className = "att-empty";
  empty.textContent = "Waiting for students…";
  panel.appendChild(empty);
  document.body.appendChild(panel);

  const rows = new Map(); // socket id -> { row, valueEl, badgeEl, lastSeen }

  function ensureRow(id, name) {
    let entry = rows.get(id);
    if (entry) return entry;

    const row = document.createElement("div");
    row.className = "att-row";

    const nameEl = document.createElement("span");
    nameEl.className = "att-name";
    nameEl.textContent = name; // textContent: names are user-supplied

    const right = document.createElement("span");
    right.style.display = "flex";
    right.style.alignItems = "center";
    right.style.gap = "8px";

    const badgeEl = document.createElement("span");
    badgeEl.className = "att-badge";
    badgeEl.textContent = "Check manually";
    badgeEl.hidden = true;

    const valueEl = document.createElement("span");
    valueEl.className = "att-value att-value--muted";
    valueEl.textContent = "—";

    right.append(badgeEl, valueEl);
    row.append(nameEl, right);
    panel.appendChild(row);

    entry = { row, valueEl, badgeEl, lastSeen: 0 };
    rows.set(id, entry);
    empty.hidden = true;
    return entry;
  }

  function onAttention(p) {
    if (!p || !p.id) return;
    const entry = ensureRow(p.id, p.name || "Student");
    entry.lastSeen = Date.now();
    entry.badgeEl.hidden = !p.low;
    entry.valueEl.textContent = String(p.score);
    entry.valueEl.className =
      "att-value " +
      (p.low
        ? "att-value--muted"
        : p.score >= 70
        ? "att-value--good"
        : p.score >= 40
        ? "att-value--mid"
        : "att-value--bad");
  }

  function onPeerLeft({ id } = {}) {
    const entry = rows.get(id);
    if (!entry) return;
    entry.row.remove();
    rows.delete(id);
    empty.hidden = rows.size > 0;
  }

  socket.on("attention", onAttention);
  socket.on("peer-left", onPeerLeft);

  // mark rows with no recent update
  const staleTimer = setInterval(() => {
    const now = Date.now();
    for (const entry of rows.values()) {
      if (entry.lastSeen && now - entry.lastSeen > STALE_MS) {
        entry.valueEl.textContent = "no data";
        entry.valueEl.className = "att-value att-value--muted";
        entry.badgeEl.hidden = true;
      }
    }
  }, 2000);

  return function stop() {
    clearInterval(staleTimer);
    socket.off("attention", onAttention);
    socket.off("peer-left", onPeerLeft);
    panel.remove();
  };
}

/* ---------------- Entry point ---------------- */

export function startAttention({ socket, isHost, videoEl } = {}) {
  if (!socket) throw new Error("startAttention: socket is required");
  return isHost ? startHostPanel(socket) : startStudentMonitor(socket, videoEl);
}