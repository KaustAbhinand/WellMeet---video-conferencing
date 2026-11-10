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

/* ---------------- Toast Notification Utility ---------------- */

export function showToast({ type = "info", title = "", message = "", duration = 4000 } = {}) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;
  toast.setAttribute("role", "status");

  const iconSvg =
    type === "success"
      ? '<svg class="toast__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>'
      : '<svg class="toast__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';

  const titleHtml = title ? `<div class="toast__title">${title}</div>` : "";
  toast.innerHTML = `
    ${iconSvg}
    <div class="toast__body">
      ${titleHtml}
      <p class="toast__message"></p>
    </div>
  `;
  const msgEl = toast.querySelector(".toast__message");
  if (msgEl) msgEl.textContent = message;

  container.appendChild(toast);

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    toast.classList.add("toast--out");
    setTimeout(() => toast.remove(), 250);
  };

  const timer = setTimeout(remove, duration);
  toast.addEventListener("click", () => {
    clearTimeout(timer);
    remove();
  });
}

/* ---------------- Host side (Attention Dashboard) ---------------- */

function startHostDashboard({ socket, initialPeers = [] } = {}) {
  const drawer = document.getElementById("attention-drawer");
  const backdrop = document.getElementById("attention-backdrop");
  const attentionBtn = document.getElementById("attention-btn");
  const closeBtn = document.getElementById("attention-close-btn");
  const alertDot = document.getElementById("attention-alert-dot");

  const statTotal = document.getElementById("stat-total");
  const statAvg = document.getElementById("stat-avg");
  const statAttentive = document.getElementById("stat-attentive");
  const statNeedsAtt = document.getElementById("stat-needs-att");
  const rosterCount = document.getElementById("roster-count");
  const rosterList = document.getElementById("roster-list");
  const emptyEl = document.getElementById("attention-empty");

  // Show host-only Attention Dashboard button
  if (attentionBtn) {
    attentionBtn.hidden = false;
  }

  function toggleDrawer(force) {
    if (!drawer) return;
    const shouldOpen = typeof force === "boolean" ? force : drawer.hidden;
    drawer.hidden = !shouldOpen;
    if (backdrop) backdrop.hidden = !shouldOpen;
    if (attentionBtn) {
      attentionBtn.setAttribute("aria-expanded", String(shouldOpen));
      attentionBtn.classList.toggle("btn--active", shouldOpen);
    }
  }

  function onAttentionBtnClick() {
    toggleDrawer();
  }

  function onCloseBtnClick() {
    toggleDrawer(false);
  }

  function onBackdropClick() {
    toggleDrawer(false);
  }

  function onKeyDown(e) {
    if (e.key === "Escape" && drawer && !drawer.hidden) {
      toggleDrawer(false);
    }
  }

  attentionBtn?.addEventListener("click", onAttentionBtnClick);
  closeBtn?.addEventListener("click", onCloseBtnClick);
  backdrop?.addEventListener("click", onBackdropClick);
  window.addEventListener("keydown", onKeyDown);

  // Participant state: socketId -> { id, name, score, confidence, low, status, lastSeen }
  // Status: "pending" | "attentive" | "needs-attention" | "stale"
  const participants = new Map();
  const STALE_MS = 8000;

  // Nudge cooldown tracking: targetId -> { until: number, timer: number }
  const nudgeCooldowns = new Map();

  function startCooldown(targetId, seconds = 60) {
    if (nudgeCooldowns.has(targetId)) {
      clearInterval(nudgeCooldowns.get(targetId).timer);
    }

    const until = Date.now() + seconds * 1000;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      const card = document.getElementById(`participant-${targetId}`);
      const btn = card?.querySelector(".btn-nudge");
      const textEl = card?.querySelector(".btn-nudge__text");

      if (remaining <= 0) {
        clearInterval(timer);
        nudgeCooldowns.delete(targetId);
        const cur = participants.get(targetId);
        if (cur) renderCard(cur);
        return;
      }

      if (btn && textEl) {
        btn.disabled = true;
        textEl.textContent = `Nudge (${remaining}s)`;
      }
    };

    const timer = setInterval(tick, 1000);
    nudgeCooldowns.set(targetId, { until, timer });
    tick();
  }

  function onNudgeClick(targetId, targetName, btn, textEl) {
    if (!btn || btn.disabled) return;

    btn.disabled = true;
    btn.classList.add("btn-nudge--loading");
    if (textEl) textEl.textContent = "Sending…";

    socket.emit("nudge-participant", { targetId }, (res) => {
      btn.classList.remove("btn-nudge--loading");

      if (!res?.ok) {
        showToast({
          type: "error",
          title: "Nudge Failed",
          message: res?.error || "Could not deliver nudge.",
        });
        if (res?.cooldownRemaining) {
          startCooldown(targetId, res?.cooldownRemaining);
        } else {
          const cur = participants.get(targetId);
          if (cur) renderCard(cur);
        }
        return;
      }

      showToast({
        type: "success",
        title: "Nudge Sent",
        message: `Nudge delivered to ${targetName || res.targetName || "participant"}.`,
      });

      startCooldown(targetId, 60);
    });
  }

  function updateStats() {
    const total = participants.size;
    let sum = 0;
    let countWithScore = 0;
    let attentive = 0;
    let needsAttention = 0;

    for (const p of participants.values()) {
      if (p.score !== null && p.status !== "pending" && p.status !== "stale") {
        sum += p.score;
        countWithScore++;
        // Rule: Score >= 70 is Attentive, Score < 70 is Needs Attention
        if (p.score >= 70) {
          attentive++;
        } else {
          needsAttention++;
        }
      }
    }

    if (statTotal) statTotal.textContent = String(total);
    if (rosterCount) rosterCount.textContent = String(total);
    if (statAvg) statAvg.textContent = countWithScore > 0 ? `${Math.round(sum / countWithScore)}%` : "—";
    if (statAttentive) statAttentive.textContent = String(attentive);
    if (statNeedsAtt) statNeedsAtt.textContent = String(needsAttention);
    if (alertDot) alertDot.hidden = needsAttention === 0;
    if (emptyEl) emptyEl.hidden = total > 0;
  }

  function renderCard(p) {
    if (!rosterList) return;
    let card = document.getElementById(`participant-${p.id}`);
    if (!card) {
      card = document.createElement("div");
      card.id = `participant-${p.id}`;
      card.className = "participant-card";

      card.innerHTML = `
        <div class="participant-card__top">
          <div class="participant-card__user">
            <div class="participant-avatar"></div>
            <div class="participant-card__details">
              <span class="participant-name"></span>
              <span class="participant-meta"></span>
            </div>
          </div>
          <span class="status-badge">
            <span class="status-badge__dot"></span>
            <span class="status-badge__text"></span>
          </span>
        </div>
        <div class="participant-card__score">
          <span class="score-label">Attention Score</span>
          <div class="score-action-group">
            <span class="score-value"></span>
            <button class="btn-nudge" type="button" aria-label="Nudge participant" title="Send focus reminder" hidden>
              <svg class="btn-nudge__icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
                <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
              </svg>
              <span class="btn-nudge__text">Nudge</span>
            </button>
          </div>
        </div>
        <div class="score-bar-track">
          <div class="score-bar-fill"></div>
        </div>
      `;

      const newNudgeBtn = card.querySelector(".btn-nudge");
      const newNudgeText = card.querySelector(".btn-nudge__text");
      newNudgeBtn?.addEventListener("click", () => {
        const cur = participants.get(p.id);
        onNudgeClick(p.id, cur?.name || p.name, newNudgeBtn, newNudgeText);
      });

      rosterList.appendChild(card);
    }

    const avatar = card.querySelector(".participant-avatar");
    const nameEl = card.querySelector(".participant-name");
    const metaEl = card.querySelector(".participant-meta");
    const badge = card.querySelector(".status-badge");
    const badgeText = card.querySelector(".status-badge__text");
    const scoreVal = card.querySelector(".score-value");
    const barFill = card.querySelector(".score-bar-fill");
    const nudgeBtn = card.querySelector(".btn-nudge");
    const nudgeText = card.querySelector(".btn-nudge__text");

    if (nameEl) nameEl.textContent = p.name || "Participant";
    if (avatar) avatar.textContent = (p.name || "P").charAt(0).toUpperCase();

    // Meta notes
    if (metaEl) {
      if (p.low) {
        metaEl.innerHTML = '<span class="tag-warn">Low visibility / Check camera</span>';
      } else if (p.status === "stale") {
        metaEl.innerHTML = '<span style="color:var(--muted)">No recent signal</span>';
      } else {
        metaEl.textContent = "";
      }
    }

    const cd = nudgeCooldowns.get(p.id);
    const isCooldown = cd && cd.until > Date.now();
    const remaining = isCooldown ? Math.max(0, Math.ceil((cd.until - Date.now()) / 1000)) : 0;

    if (p.status === "pending") {
      card.className = "participant-card participant-card--pending";
      if (avatar) avatar.className = "participant-avatar";
      if (badge) badge.className = "status-badge status-badge--pending";
      if (badgeText) badgeText.textContent = "Waiting for data";
      if (scoreVal) {
        scoreVal.className = "score-value score-value--muted";
        scoreVal.textContent = "—";
      }
      if (barFill) {
        barFill.className = "score-bar-fill score-bar-fill--pending";
        barFill.style.width = "0%";
      }
      if (nudgeBtn) {
        nudgeBtn.hidden = true;
        nudgeBtn.disabled = true;
      }
    } else if (p.status === "stale") {
      card.className = "participant-card participant-card--pending";
      if (avatar) avatar.className = "participant-avatar";
      if (badge) badge.className = "status-badge status-badge--stale";
      if (badgeText) badgeText.textContent = "Unavailable";
      if (scoreVal) {
        scoreVal.className = "score-value score-value--muted";
        scoreVal.textContent = "—";
      }
      if (barFill) {
        barFill.className = "score-bar-fill score-bar-fill--pending";
        barFill.style.width = "0%";
      }
      if (nudgeBtn) {
        nudgeBtn.hidden = true;
        nudgeBtn.disabled = true;
      }
    } else {
      // Real score from existing detection system
      const isAttentive = p.score >= 70;
      if (isAttentive) {
        card.className = "participant-card participant-card--attentive";
        if (avatar) avatar.className = "participant-avatar participant-avatar--attentive";
        if (badge) badge.className = "status-badge status-badge--attentive";
        if (badgeText) badgeText.textContent = "Attentive";
        if (scoreVal) {
          scoreVal.className = "score-value score-value--attentive";
          scoreVal.textContent = `${p.score} / 100`;
        }
        if (barFill) {
          barFill.className = "score-bar-fill score-bar-fill--attentive";
          barFill.style.width = `${p.score}%`;
        }
        // Score is 70 or above: Nudge button must be hidden/disabled
        if (nudgeBtn) {
          nudgeBtn.hidden = true;
          nudgeBtn.disabled = true;
        }
      } else {
        card.className = "participant-card participant-card--needs-attention";
        if (avatar) avatar.className = "participant-avatar participant-avatar--needs-attention";
        if (badge) badge.className = "status-badge status-badge--needs-attention";
        if (badgeText) badgeText.textContent = "Needs Attention";
        if (scoreVal) {
          scoreVal.className = "score-value score-value--needs-attention";
          scoreVal.textContent = `${p.score} / 100`;
        }
        if (barFill) {
          barFill.className = "score-bar-fill score-bar-fill--needs-attention";
          barFill.style.width = `${p.score}%`;
        }
        // Score is below 70: Display Nudge button
        if (nudgeBtn) {
          nudgeBtn.hidden = false;
          if (isCooldown) {
            nudgeBtn.disabled = true;
            if (nudgeText) nudgeText.textContent = `Nudge (${remaining}s)`;
          } else if (!nudgeBtn.classList.contains("btn-nudge--loading")) {
            nudgeBtn.disabled = false;
            if (nudgeText) nudgeText.textContent = "Nudge";
          }
        }
      }
    }
  }

  function addOrUpdateParticipant(id, name, scoreData = null) {
    let p = participants.get(id);
    if (!p) {
      p = {
        id,
        name: name || "Participant",
        score: null,
        confidence: null,
        low: false,
        status: "pending",
        lastSeen: null,
      };
      participants.set(id, p);
    }
    if (name) p.name = name;
    if (scoreData) {
      p.score = Math.max(0, Math.min(100, Math.round(Number(scoreData.score) || 0)));
      p.confidence = Math.max(0, Math.min(100, Math.round(Number(scoreData.confidence) || 0)));
      p.low = !!scoreData.low;
      p.status = p.score >= 70 ? "attentive" : "needs-attention";
      p.lastSeen = Date.now();
    }
    renderCard(p);
    updateStats();
  }

  function removeParticipant(id) {
    if (nudgeCooldowns.has(id)) {
      clearInterval(nudgeCooldowns.get(id).timer);
      nudgeCooldowns.delete(id);
    }
    const card = document.getElementById(`participant-${id}`);
    if (card) card.remove();
    participants.delete(id);
    updateStats();
  }

  function syncPeers(peersList = []) {
    const activeIds = new Set(peersList.filter((p) => p && !p.isHost).map((p) => p.id));
    for (const id of [...participants.keys()]) {
      if (!activeIds.has(id)) {
        removeParticipant(id);
      }
    }
    for (const peer of peersList) {
      if (!peer || peer.isHost) continue;
      addOrUpdateParticipant(peer.id, peer.name);
    }
    updateStats();
  }

  // Populate initial peers
  if (Array.isArray(initialPeers)) {
    syncPeers(initialPeers);
  }

  function onAttention(payload) {
    if (!payload || !payload.id) return;
    addOrUpdateParticipant(payload.id, payload.name, payload);
  }

  function onPeerJoined(peer) {
    if (!peer || !peer.id || peer.isHost) return;
    addOrUpdateParticipant(peer.id, peer.name);
  }

  function onPeerLeft({ id } = {}) {
    if (!id) return;
    removeParticipant(id);
  }

  socket.on("attention", onAttention);
  socket.on("peer-joined", onPeerJoined);
  socket.on("peer-left", onPeerLeft);

  const staleTimer = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const p of participants.values()) {
      if (p.lastSeen && p.status !== "stale" && now - p.lastSeen > STALE_MS) {
        p.status = "stale";
        renderCard(p);
        changed = true;
      }
    }
    if (changed) updateStats();
  }, 2000);

  updateStats();

  const stop = function stop() {
    clearInterval(staleTimer);
    for (const { timer } of nudgeCooldowns.values()) {
      clearInterval(timer);
    }
    nudgeCooldowns.clear();

    socket.off("attention", onAttention);
    socket.off("peer-joined", onPeerJoined);
    socket.off("peer-left", onPeerLeft);

    attentionBtn?.removeEventListener("click", onAttentionBtnClick);
    closeBtn?.removeEventListener("click", onCloseBtnClick);
    backdrop?.removeEventListener("click", onBackdropClick);
    window.removeEventListener("keydown", onKeyDown);

    if (attentionBtn) {
      attentionBtn.hidden = true;
      attentionBtn.classList.remove("btn--active");
      attentionBtn.setAttribute("aria-expanded", "false");
    }
    if (drawer) drawer.hidden = true;
    if (backdrop) backdrop.hidden = true;
    for (const p of participants.values()) {
      document.getElementById(`participant-${p.id}`)?.remove();
    }
    participants.clear();
  };

  stop.syncPeers = syncPeers;
  return stop;
}

/* ---------------- Entry point ---------------- */

export function startAttention({ socket, isHost, videoEl, peers = [] } = {}) {
  if (!socket) throw new Error("startAttention: socket is required");
  return isHost ? startHostDashboard({ socket, initialPeers: peers }) : startStudentMonitor(socket, videoEl);
}