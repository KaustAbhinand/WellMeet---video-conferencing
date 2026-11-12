import "dotenv/config";
import crypto from "crypto";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { Server } from "socket.io";
import { createClient } from "@supabase/supabase-js";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  TURN_USERNAME,
  TURN_PASSWORD,
  PORT = 3000,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in server/.env");
  process.exit(1);
}
if (!TURN_USERNAME || !TURN_PASSWORD) {
  console.warn("TURN_USERNAME / TURN_PASSWORD are not set. Calls may fail on restrictive networks.");
}

console.log(
  "TURN env keys:",
  Object.keys(process.env)
    .filter((k) => /turn/i.test(k))
    .map((k) => `${JSON.stringify(k)} length=${process.env[k]?.length}`)
);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_PEERS = 6; // mesh limit
const ID_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/* ---------------- helpers ---------------- */

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const randomPart = (n) =>
  Array.from({ length: n }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
const generateMeetingId = () => `${randomPart(3)}-${randomPart(4)}-${randomPart(3)}`;

async function getUserFromToken(token) {
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  return error ? null : data.user;
}

const bearer = (req) => (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

/* ---------------- HTTP ---------------- */

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public"))); // only public/ is served
app.get("/", (req, res) => res.redirect("/login.html"));

// ICE (STUN/TURN) settings, only for signed-in users.
// The TURN credentials live in environment variables, never in public files.
app.get("/api/ice", async (req, res) => {
  const user = await getUserFromToken(bearer(req));
  if (!user) return res.status(401).json({ error: "Please sign in again." });

  const iceServers = [
    { urls: "stun:stun.relay.metered.ca:80" },
    { urls: "stun:stun.l.google.com:19302" },
  ];

  if (TURN_USERNAME && TURN_PASSWORD) {
    for (const urls of [
      "turn:global.relay.metered.ca:80",
      "turn:global.relay.metered.ca:80?transport=tcp",
      "turn:global.relay.metered.ca:443",
      "turns:global.relay.metered.ca:443?transport=tcp",
    ]) {
      iceServers.push({ urls, username: TURN_USERNAME, credential: TURN_PASSWORD });
    }
  }

  res.json({ iceServers });
});

// Create a meeting (host)
app.post("/api/meetings", async (req, res) => {
  const user = await getUserFromToken(bearer(req));
  if (!user) return res.status(401).json({ error: "Please sign in again." });

  const name = String(req.body?.name ?? "").trim();
  if (!name || name.length > 80) {
    return res.status(400).json({ error: "Meeting name must be 1-80 characters." });
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const meeting_id = generateMeetingId();
    const { data, error } = await supabase
      .from("meetings")
      .insert({ meeting_id, name, host_id: user.id })
      .select("meeting_id, name")
      .single();

    if (!error) return res.status(201).json(data);
    if (error.code !== "23505") {
      console.error("Create meeting error:", error);
      return res.status(500).json({ error: "Could not create the meeting." });
    }
    // 23505 = unique violation on meeting_id -> try a new ID
  }
  res.status(500).json({ error: "Could not generate a unique meeting ID." });
});

// Look up a meeting before joining
app.get("/api/meetings/:id", async (req, res) => {
  const user = await getUserFromToken(bearer(req));
  if (!user) return res.status(401).json({ error: "Please sign in again." });

  const id = req.params.id.toLowerCase();
  if (!ID_RE.test(id)) return res.status(404).json({ error: "Meeting not found." });

  const { data, error } = await supabase
    .from("meetings")
    .select("meeting_id, name, status")
    .eq("meeting_id", id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: "Could not look up the meeting." });
  if (!data) return res.status(404).json({ error: "Meeting not found." });
  res.json(data);
});

/* ---------------- Signaling (Socket.IO) ---------------- */

const server = http.createServer(app);
const io = new Server(server);

// rooms: meetingId -> Map(socketId -> { name, isHost })
const rooms = new Map();

io.use(async (socket, next) => {
  try {
    const user = await getUserFromToken(socket.handshake.auth?.token);
    if (!user) {
      console.log("auth rejected: bad or expired token");
      return next(new Error("unauthorized"));
    }

    const { data: profile } = await supabase
      .from("users")
      .select("username")
      .eq("id", user.id)
      .maybeSingle();

    socket.data.user = user;
    socket.data.name = profile?.username || user.email?.split("@")[0] || "Guest";
    next();
  } catch (err) {
    console.log("auth error", err);
    next(new Error("auth failed"));
  }
});

function leaveRoom(socket) {
  const id = socket.data.meetingId;
  if (!id) return;
  console.log("leaveRoom", socket.id, socket.data.name, id);
  socket.data.meetingId = null;

  const room = rooms.get(id);
  if (room) {
    room.delete(socket.id);
    if (room.size === 0) rooms.delete(id);
  }
  socket.leave(id);
  io.to(id).emit("peer-left", { id: socket.id });
}

io.on("connection", (socket) => {
  console.log("connected", socket.id, socket.data.name);

  socket.on("join-room", async ({ meetingId } = {}, ack) => {
    console.log("join-room request", socket.id, socket.data.name, meetingId);

    if (typeof ack !== "function") return console.log("join-room: no ack function");
    const id = String(meetingId ?? "").toLowerCase();
    if (!ID_RE.test(id)) {
      console.log("join-room: invalid id", id);
      return ack({ ok: false, error: "Invalid meeting ID." });
    }
    if (socket.data.meetingId) {
      console.log("join-room: already in meeting", socket.data.meetingId);
      return ack({ ok: false, error: "Already in a meeting." });
    }

    const { data: meeting, error } = await supabase
      .from("meetings")
      .select("meeting_id, name, host_id, status")
      .eq("meeting_id", id)
      .maybeSingle();

    if (error) {
      console.log("join-room: supabase error", error);
      return ack({ ok: false, error: "Could not look up the meeting." });
    }
    if (!meeting) {
      console.log("join-room: meeting not found", id);
      return ack({ ok: false, error: "Meeting not found." });
    }
    if (meeting.status === "ended") {
      console.log("join-room: meeting ended", id);
      return ack({ ok: false, error: "This meeting has ended." });
    }

    const room = rooms.get(id) ?? new Map();
    console.log("join-room: room size before join", room.size);
    if (room.size >= MAX_PEERS) {
      console.log("join-room: room full");
      return ack({ ok: false, error: "This meeting is full." });
    }

    const isHost = meeting.host_id === socket.data.user.id;
    const peers = [...room.entries()].map(([pid, p]) => ({ id: pid, name: p.name, isHost: p.isHost }));

    room.set(socket.id, { name: socket.data.name, isHost });
    rooms.set(id, room);
    socket.data.meetingId = id;
    socket.join(id);
    console.log("join-room: joined", id, socket.data.name, "isHost:", isHost, "room size now", room.size);

    // Existing members just prepare to answer; the newcomer sends the offers.
    socket.to(id).emit("peer-joined", { id: socket.id, name: socket.data.name, isHost });
    ack({ ok: true, selfId: socket.id, isHost, peers });
  });

  // offer / answer / ICE candidate, relayed to one peer in the same room
  socket.on("signal", ({ to, data } = {}) => {
    const room = rooms.get(socket.data.meetingId);
    if (!room || !room.has(to) || !data) return;
    io.to(to).emit("signal", { from: socket.id, data });
  });

  // student -> host only: attention score (no video, just numbers)
  socket.on("attention", (p = {}) => {
    const room = rooms.get(socket.data.meetingId);
    const me = room?.get(socket.id);
    if (!me || me.isHost) return;

    const now = Date.now();
    if (now - (socket.data.lastAttention || 0) < 1000) return; // throttle
    socket.data.lastAttention = now;

    const num = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    const payload = {
      id: socket.id,
      name: me.name,
      score: num(p.score),
      confidence: num(p.confidence),
      low: !!p.low,
    };

    for (const [pid, peer] of room) {
      if (peer.isHost) io.to(pid).emit("attention", payload);
    }
  });

  // host -> specific participant: nudge reminder
  socket.on("nudge-participant", ({ targetId } = {}, ack) => {
    if (typeof ack !== "function") ack = () => {};
    const meetingId = socket.data.meetingId;
    if (!meetingId) {
      return ack({ ok: false, error: "Not in a meeting." });
    }

    const room = rooms.get(meetingId);
    if (!room) {
      return ack({ ok: false, error: "Meeting room not found." });
    }

    const sender = room.get(socket.id);
    if (!sender || !sender.isHost) {
      return ack({ ok: false, error: "Unauthorized: only the meeting host can send nudges." });
    }

    if (!targetId || typeof targetId !== "string") {
      return ack({ ok: false, error: "Invalid participant ID." });
    }

    if (targetId === socket.id) {
      return ack({ ok: false, error: "Cannot nudge yourself." });
    }

    const target = room.get(targetId);
    if (!target) {
      return ack({ ok: false, error: "Participant is no longer in the meeting." });
    }

    // Cooldown check on backend (60 seconds per target from this host)
    if (!socket.data.nudgeCooldowns) {
      socket.data.nudgeCooldowns = new Map();
    }
    const now = Date.now();
    const lastNudge = socket.data.nudgeCooldowns.get(targetId) || 0;
    const elapsed = now - lastNudge;
    if (elapsed < 60000) {
      const remainingSecs = Math.ceil((60000 - elapsed) / 1000);
      return ack({
        ok: false,
        error: `Please wait ${remainingSecs}s before nudging ${target.name} again.`,
        cooldownRemaining: remainingSecs,
      });
    }

    socket.data.nudgeCooldowns.set(targetId, now);

    const message = "You seem to be losing focus. Please pay attention to the meeting.";
    io.to(targetId).emit("nudge", {
      from: sender.name,
      message,
      timestamp: now,
    });

    ack({ ok: true, targetId, targetName: target.name });
  });

  // host -> specific participant: ask their client to turn the camera on.
  // The student's client does the work and replies; the server only relays.
  socket.on("request-video", ({ targetId } = {}, ack) => {
    if (typeof ack !== "function") ack = () => {};

    const room = rooms.get(socket.data.meetingId);
    const sender = room?.get(socket.id);
    if (!sender || !sender.isHost) {
      return ack({ ok: false, error: "Only the meeting host can do this." });
    }
    if (!targetId || typeof targetId !== "string" || targetId === socket.id) {
      return ack({ ok: false, error: "Invalid participant ID." });
    }

    const target = room.get(targetId);
    const targetSocket = io.sockets.sockets.get(targetId);
    if (!target || !targetSocket) {
      return ack({ ok: false, error: "Participant is no longer in the meeting." });
    }

    targetSocket.timeout(5000).emit("request-video", { by: sender.name }, (err, res) => {
      if (err || !res) {
        return ack({ ok: false, error: `${target.name} did not respond.` });
      }
      ack({ ...res, targetName: target.name });
    });
  });

  socket.on("end-meeting", async () => {
    const id = socket.data.meetingId;
    if (!id || !rooms.get(id)?.get(socket.id)?.isHost) return;

    await supabase
      .from("meetings")
      .update({ status: "ended", end_time: new Date().toISOString() })
      .eq("meeting_id", id);

    io.to(id).emit("meeting-ended");
    io.in(id).disconnectSockets(true);
    rooms.delete(id);
  });

  socket.on("leave-room", () => leaveRoom(socket));
  socket.on("disconnect", (reason) => {
    console.log("disconnect", socket.id, socket.data.name, reason);
    leaveRoom(socket);
  });
});

server.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));