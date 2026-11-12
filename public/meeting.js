
import { supabase } from "./supabase.js";
import { startAttention, showToast } from "./attention.js";

const meetingId = (new URLSearchParams(location.search).get("id") || "").toLowerCase();

const $ = (id) => document.getElementById(id);
const grid = $("grid");
const micBtn = $("mic-btn");
const camBtn = $("cam-btn");
const leaveBtn = $("leave-btn");
const endBtn = $("end-btn");
const attentionBtn = $("attention-btn");
const copyBtn = $("copy-btn");
const banner = $("banner");

let socket = null;
let iceConfig = null;
let localStream = null;
let leaving = false;
let stopAttention = null;
let attentionStarted = false;
let selfIsHost = false;
let sendVideoToAll = false;
let wakeLock = null;
let connBannerShown = false;
const peers = new Map();
const participantVideoStates = new Map();

/* ---------------- UI helpers ---------------- */

function showNotice(title, text) {
  $("notice-title").textContent = title;
  $("notice-text").textContent = text;
  $("notice").hidden = false;
}

function addTile(id, label, stream, isSelf = false) {
  if ($(`tile-${id}`)) return;

  const tile = document.createElement("div");
  tile.className = "tile" + (isSelf ? " tile--self" : "");
  tile.id = `tile-${id}`;
  tile.style.backgroundColor = "#000";

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = isSelf;
  video.srcObject = stream;

  const tag = document.createElement("span");
  tag.className = "tile__tag";
  tag.textContent = label;

  const state = document.createElement("span");
  state.className = "tile__state";

  tile.append(video, tag, state);
  grid.append(tile);

  // A video-state notification can arrive before this tile is created.
  if (participantVideoStates.get(id) === false) {
    video.style.setProperty("display", "none", "important");
  }
}

function setTileState(id, text) {
  const el = document.querySelector(`#tile-${CSS.escape(id)} .tile__state`);
  if (el) el.textContent = text;
}

// Explicitly show or hide a participant's remote video.
// Hiding the video element exposes the tile's black background instead of
// leaving the last decoded frame visible.
function setParticipantVideoVisibility(id, enabled) {
  participantVideoStates.set(id, enabled);

  const tile = $(`tile-${id}`);
  if (!tile) return;

  tile.style.backgroundColor = "#000";

  const video = tile.querySelector("video");
  if (!video) return;

  if (enabled) {
    video.style.removeProperty("display");
  } else {
    video.style.setProperty("display", "none", "important");
  }
}

function removeTile(id) {
  $(`tile-${id}`)?.remove();
}

/* ---------------- Local media ---------------- */

async function getLocalMedia() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });
  } catch {
    try {
      const audioOnly = await navigator.mediaDevices.getUserMedia({
        audio: true
      });

      banner.textContent = "Camera unavailable. You joined with audio only.";
      banner.hidden = false;
      return audioOnly;
    } catch {
      banner.textContent =
        "Camera and microphone unavailable. You can see and hear others, but they can't see or hear you.";

      banner.hidden = false;
      return new MediaStream();
    }
  }
}

/* ---------------- WebRTC peers ---------------- */

function createPeer(id, name, isHost) {
  if (peers.has(id)) return peers.get(id);

  const pc = new RTCPeerConnection(iceConfig);
  const peer = {
    pc,
    stream: new MediaStream(),
    pending: []
  };

  peers.set(id, peer);

  // Students send audio by default, but video only after a host request.
  for (const kind of ["audio", "video"]) {
    const track = localStream.getTracks().find((t) => t.kind === kind);

    const sendThis =
      track && (kind === "audio" || selfIsHost || sendVideoToAll);

    if (sendThis) {
      pc.addTrack(track, localStream);
    } else {
      pc.addTransceiver(kind, { direction: "recvonly" });
    }
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      console.log(
        `[${id}] local ICE candidate:`,
        e.candidate.type,
        e.candidate.protocol
      );

      socket.emit("signal", {
        to: id,
        data: { candidate: e.candidate }
      });
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`[${id}] ICE state:`, pc.iceConnectionState);
  };

  pc.ontrack = (e) => {
    peer.stream.addTrack(e.track);
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;

    console.log(`[${id}] Connection state:`, s);

    if (s === "connected") setTileState(id, "");
    else if (s === "connecting") setTileState(id, "Connecting…");
    else if (s === "disconnected") setTileState(id, "Reconnecting…");
    else if (s === "failed") setTileState(id, "Connection failed");
  };

  addTile(id, isHost ? `${name} (Host)` : name, peer.stream);
  setTileState(id, "Connecting…");

  return peer;
}

function closePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;

  peer.pc.onicecandidate = null;
  peer.pc.ontrack = null;
  peer.pc.close();

  peers.delete(id);
  removeTile(id);
}

// Newcomer -> existing peer: send an offer
async function callPeer({ id, name, isHost }) {
  const { pc } = createPeer(id, name, isHost);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.emit("signal", {
    to: id,
    data: { description: pc.localDescription }
  });
}

async function handleSignal({ from, data }) {
  const peer =
    peers.get(from) ?? createPeer(from, "Participant", false);

  const { pc } = peer;

  if (data.description) {
    await pc.setRemoteDescription(data.description);

    if (data.description.type === "offer") {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit("signal", {
        to: from,
        data: { description: pc.localDescription }
      });
    }

    for (const c of peer.pending.splice(0)) {
      await pc.addIceCandidate(c).catch(console.warn);
    }
  } else if (data.candidate) {
    if (pc.remoteDescription) {
      await pc.addIceCandidate(data.candidate).catch(console.warn);
    } else {
      peer.pending.push(data.candidate);
    }
  }
}

/* ---------------- Host-requested video ---------------- */

// Start sending our camera to every peer.
async function startSendingVideo() {
  sendVideoToAll = true;

  const track = localStream.getVideoTracks()[0];
  if (!track) return;

  for (const [id, { pc }] of peers) {
    try {
      const transceiver = pc
        .getTransceivers()
        .find(
          (t) =>
            t.receiver.track &&
            t.receiver.track.kind === "video"
        );

      if (!transceiver) continue;

      if (
        transceiver.direction === "sendrecv" &&
        transceiver.sender.track === track
      ) {
        continue;
      }

      await transceiver.sender.replaceTrack(track);
      transceiver.direction = "sendrecv";

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socket.emit("signal", {
        to: id,
        data: { description: pc.localDescription }
      });
    } catch (err) {
      console.warn(
        `[${id}] could not start sending video:`,
        err
      );
    }
  }
}

// Stop sending video without stopping the local camera.
// Attention monitoring can continue using the local camera.
async function stopSendingVideo() {
  sendVideoToAll = false;

  for (const [id, { pc }] of peers) {
    try {
      const transceiver = pc
        .getTransceivers()
        .find(
          (t) =>
            t.receiver.track &&
            t.receiver.track.kind === "video"
        );

      if (transceiver && transceiver.sender.track) {
        await transceiver.sender.replaceTrack(null);
      }
    } catch (err) {
      console.warn(
        `[${id}] could not stop sending video:`,
        err
      );
    }
  }
}

// Turn the local camera on when requested by the host.
function enableVideo() {
  const tracks = localStream.getVideoTracks();

  if (!tracks.length || tracks[0].readyState === "ended") {
    return {
      ok: false,
      error: "No camera available."
    };
  }

  tracks.forEach((t) => (t.enabled = true));

  camBtn.setAttribute("aria-pressed", "false");

  const label = camBtn.querySelector(".ctrl-btn__label");

  if (label) label.textContent = "Stop video";
  else camBtn.textContent = "Stop video";

  return { ok: true };
}

/* ---------------- Leaving ---------------- */

let nudgeDismissTimer = null;

function cleanup() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;

  if (nudgeDismissTimer) clearTimeout(nudgeDismissTimer);

  const nudgeBanner = $("nudge-banner");
  if (nudgeBanner) nudgeBanner.hidden = true;

  if (stopAttention) {
    stopAttention();
    stopAttention = null;
  }

  for (const id of [...peers.keys()]) {
    closePeer(id);
  }

  localStream?.getTracks().forEach((t) => t.stop());
}

function leave() {
  if (leaving) return;

  leaving = true;
  socket?.emit("leave-room");
  socket?.disconnect();

  cleanup();
  location.href = "dashboard.html";
}

/* ---------------- Controls ---------------- */

function toggleTracks(kind, button, onLabel, offLabel) {
  if (!localStream) return;

  const tracks =
    kind === "audio"
      ? localStream.getAudioTracks()
      : localStream.getVideoTracks();

  if (!tracks.length) return;

  const enable = !tracks[0].enabled;

  tracks.forEach((t) => (t.enabled = enable));

  button.setAttribute("aria-pressed", String(!enable));
  button.textContent = enable ? onLabel : offLabel;
}

micBtn.addEventListener("click", () =>
  toggleTracks("audio", micBtn, "Mute", "Unmute")
);

camBtn.addEventListener("click", () =>
  toggleTracks("video", camBtn, "Stop video", "Start video")
);

leaveBtn.addEventListener("click", leave);

endBtn.addEventListener("click", () => {
  if (confirm("End this meeting for everyone?")) {
    socket.emit("end-meeting");
  }
});

copyBtn.addEventListener("click", async () => {
  const link = `${location.origin}/meeting.html?id=${meetingId}`;

  try {
    await navigator.clipboard.writeText(link);
    copyBtn.textContent = "Copied";
  } catch {
    prompt("Copy this invite link:", link);
  }

  setTimeout(
    () => (copyBtn.textContent = "Copy invite link"),
    1500
  );
});

window.addEventListener("beforeunload", () =>
  socket?.disconnect()
);

/* ---------------- Reconnect support (phones) ---------------- */

function setConnectionBanner(text) {
  if (text) {
    banner.textContent = text;
    banner.hidden = false;
    connBannerShown = true;
  } else if (connBannerShown) {
    banner.hidden = true;
    connBannerShown = false;
  }
}

// Keeps the screen awake during a meeting.
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");

      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    }
  } catch {
    // Not supported or denied.
  }
}

// If phone media tracks ended, get fresh ones.
async function ensureLocalMedia() {
  const tracks = localStream.getTracks();

  if (!tracks.some((t) => t.readyState === "ended")) return;

  tracks.forEach((t) => t.stop());

  localStream = await getLocalMedia();

  const localVideo = document.querySelector("#tile-local video");

  if (localVideo) localVideo.srcObject = localStream;

  micBtn.setAttribute("aria-pressed", "false");
  micBtn.textContent = "Mute";

  camBtn.setAttribute("aria-pressed", "false");
  camBtn.textContent = "Stop video";
}

// Runs on the first connection and after every automatic reconnect.
async function joinRoom() {
  if (leaving) return;

  for (const id of [...peers.keys()]) {
    closePeer(id);
  }

  await ensureLocalMedia();

  socket.emit("join-room", { meetingId }, async (res) => {
    if (!res?.ok) {
      leaving = true;
      cleanup();

      return showNotice(
        "Can't join",
        res?.error || "Something went wrong."
      );
    }

    selfIsHost = !!res.isHost;

    if (res.isHost) {
      endBtn.hidden = false;
      if (attentionBtn) attentionBtn.hidden = false;
    } else {
      if (attentionBtn) attentionBtn.hidden = true;
    }

    requestWakeLock();

    // Attention monitoring.
    if (!attentionStarted) {
      attentionStarted = true;

      Promise.resolve(
        startAttention({
          socket,
          isHost: res.isHost,
          peers: res.peers
        })
      )
        .then((stop) => {
          if (typeof stop === "function") {
            if (leaving) stop();
            else stopAttention = stop;
          }
        })
        .catch((err) =>
          console.error(
            "Attention monitoring failed to start:",
            err
          )
        );
    } else if (res.isHost && stopAttention?.syncPeers) {
      stopAttention.syncPeers(res.peers);
    }

    for (const peer of res.peers) {
      if (typeof peer.videoEnabled === "boolean") {
        participantVideoStates.set(peer.id, peer.videoEnabled);
      }
      await callPeer(peer).catch(console.error);
    }
  });
}

/* ---------------- Init ---------------- */

async function init() {
  if (!/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(meetingId)) {
    return showNotice(
      "Invalid meeting link",
      "Check the meeting ID and try again."
    );
  }

  const {
    data: { session }
  } = await supabase.auth.getSession();

  if (!session) {
    sessionStorage.setItem(
      "postLoginRedirect",
      location.pathname + location.search
    );

    location.replace("login.html");
    return;
  }

  const token = session.access_token;

  // TURN/STUN settings come from the server.
  try {
    const iceRes = await fetch("/api/ice", {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!iceRes.ok) throw new Error("ice");

    iceConfig = await iceRes.json();
  } catch {
    return showNotice(
      "Can't start the meeting",
      "Could not load connection settings. Sign in again and retry."
    );
  }

  let meeting;

  try {
    const res = await fetch(`/api/meetings/${meetingId}`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (res.status === 404) {
      return showNotice(
        "Meeting not found",
        "Check the meeting ID and try again."
      );
    }

    if (!res.ok) {
      return showNotice(
        "Can't open this meeting",
        "Sign in again and retry."
      );
    }

    meeting = await res.json();
  } catch {
    return showNotice(
      "Can't reach the server",
      "Make sure the Meet server is running."
    );
  }

  if (meeting.status === "ended") {
    return showNotice(
      "This meeting has ended",
      "Ask the host to create a new one."
    );
  }

  $("meeting-title").textContent = meeting.name;
  $("meeting-code").textContent = meetingId;

  document.title = `${meeting.name} | Meet`;

  localStream = await getLocalMedia();

  addTile("local", "You", localStream, true);

  // Fetch a fresh token on every reconnect.
  socket = io({
    auth: (cb) => {
      supabase.auth
        .getSession()
        .then(({ data }) =>
          cb({
            token: data.session?.access_token || token
          })
        )
        .catch(() => cb({ token }));
    }
  });

  socket.on("connect_error", (err) => {
    if (
      err.message === "unauthorized" ||
      err.message === "auth failed"
    ) {
      showNotice(
        "Connection failed",
        "Sign in again and retry."
      );
    } else {
      console.warn(
        "Socket connect error (retrying):",
        err.message
      );

      setConnectionBanner("Connection problem. Retrying…");
    }
  });

  socket.on("peer-joined", ({ id, name, isHost, videoEnabled }) => {
    if (typeof videoEnabled === "boolean") {
      participantVideoStates.set(id, videoEnabled);
    }
    createPeer(id, name, isHost);
  });

  socket.on("peer-left", ({ id }) => {
    participantVideoStates.delete(id);
    closePeer(id);
  });

  // The server broadcasts the host-approved video state to every meeting member.
  socket.on("participant-video-state", ({ participantId, videoEnabled } = {}) => {
    if (!participantId || typeof videoEnabled !== "boolean") return;
    setParticipantVideoVisibility(participantId, videoEnabled);
  });

  socket.on("signal", (msg) =>
    handleSignal(msg).catch(console.error)
  );

  socket.on("meeting-ended", () => {
    leaving = true;
    cleanup();

    showNotice(
      "Meeting ended",
      "The host ended this meeting."
    );
  });

  function showNudgeNotification(message, senderName) {
    const banner = $("nudge-banner");
    const msgEl = $("nudge-message");
    const senderEl = $("nudge-sender");
    const dismissBtn = $("nudge-dismiss-btn");

    if (!banner || !msgEl) return;

    msgEl.textContent =
      message ||
      "You seem to be losing focus. Please pay attention to the meeting.";

    if (senderEl) {
      senderEl.textContent = senderName
        ? `from ${senderName}`
        : "from Host";
    }

    if (nudgeDismissTimer) {
      clearTimeout(nudgeDismissTimer);
    }

    banner.classList.remove("nudge-banner--fadeout");
    banner.hidden = false;

    function dismiss() {
      if (nudgeDismissTimer) {
        clearTimeout(nudgeDismissTimer);
      }

      banner.classList.add("nudge-banner--fadeout");

      setTimeout(() => {
        banner.hidden = true;
        banner.classList.remove("nudge-banner--fadeout");
      }, 300);
    }

    if (dismissBtn) dismissBtn.onclick = dismiss;

    nudgeDismissTimer = setTimeout(dismiss, 8000);
  }

  socket.on("nudge", ({ message, from } = {}) => {
    showNudgeNotification(message, from);
  });

  // Host requests the participant to turn their camera on.
  socket.on("request-video", async ({ by } = {}, reply) => {
    if (typeof reply !== "function") return;

    const firstTime = !sendVideoToAll;
    const r = enableVideo();

    if (r.ok) {
      await startSendingVideo();

      if (firstTime) {
        showToast({
          type: "info",
          title: "Camera turned on",
          message: `${
            by || "The host"
          } turned on your camera because your attention was low. Everyone in the meeting can see you.`,
          duration: 8000
        });
      }
    }

    reply(r);
  });

  // Host requests the participant to turn their video off.
  socket.on("request-video-off", async (_payload = {}, reply) => {
    await stopSendingVideo();
    if (typeof reply === "function") reply({ ok: true });
  });

  socket.on("disconnect", (reason) => {
    if (leaving) return;

    if (reason === "io server disconnect") {
      showNotice(
        "Disconnected",
        "The server closed your connection. Rejoin from the dashboard."
      );

      return;
    }

    setConnectionBanner("Connection lost. Reconnecting…");
  });

  socket.on("connect", () => {
    setConnectionBanner(null);
    joinRoom();
  });

  // Coming back to the tab: reconnect and keep the screen awake.
  document.addEventListener("visibilitychange", () => {
    if (
      document.visibilityState !== "visible" ||
      leaving
    ) {
      return;
    }

    if (socket && !socket.connected) {
      socket.connect();
    }

    requestWakeLock();
  });
}

init();
