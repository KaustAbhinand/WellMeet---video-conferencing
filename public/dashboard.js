import { supabase } from "./supabase.js";

// DOM elements
const usernameElement = document.getElementById("username");
const profileUsername = document.getElementById("profile-username");
const profileAvatar = document.getElementById("profile-avatar");

const logoutBtn = document.getElementById("logout-btn");

const hostMeetingBtn = document.getElementById("host-meeting-btn");
const createMeetingBtn = document.getElementById("create-meeting-btn");

const createModal = document.getElementById("create-modal");
const createForm = document.getElementById("create-form");
const meetingNameInput = document.getElementById("meeting-name");
const createError = document.getElementById("create-error");
const createSubmit = document.getElementById("create-submit");
const createCancel = document.getElementById("create-cancel");

const joinForm = document.getElementById("join-form");
const joinInput = document.getElementById("join-input");
const joinError = document.getElementById("join-error");

let currentUsername = "";

function showName(name) {
    currentUsername = name;
    usernameElement.textContent = name;
    profileUsername.textContent = name;
    profileAvatar.textContent = name.charAt(0).toUpperCase();
}

// Fetch authenticated user
async function loadDashboard() {
    try {
        const { data: { user }, error: authError } =
            await supabase.auth.getUser();

        if (authError || !user) {
            window.location.href = "login.html";
            return;
        }

        const meta = user.user_metadata || {};
        const isGoogle = user.app_metadata?.provider === "google";

        // Google users: use the name from their Google account
        if (isGoogle) {
            showName(
                meta.full_name ||
                meta.name ||
                user.email.split("@")[0]
            );
            return;
        }

        // Email signups: use the username from public.users
        const { data: profile, error: profileError } =
            await supabase
                .from("users")
                .select("username")
                .eq("id", user.id)
                .maybeSingle();

        if (profileError) {
            throw profileError;
        }

        showName(
            (profile && profile.username) ||
            meta.username ||
            user.email.split("@")[0]
        );

    } catch (error) {
        console.error("Dashboard loading error:", error);
        usernameElement.textContent = "User";
        profileUsername.textContent = "User";
    }
}

// ---------- Meetings ----------

async function createMeeting(name) {
    const { data: { session } } = await supabase.auth.getSession();

    if (!session) {
        window.location.href = "login.html";
        throw new Error("Please sign in again.");
    }

    const res = await fetch("/api/meetings", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ name })
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
        throw new Error(body.error || "Could not create the meeting.");
    }

    return body.meeting_id;
}

function enterMeeting(meetingId) {
    window.location.href = `meeting.html?id=${encodeURIComponent(meetingId)}`;
}

// Create modal
function openCreateModal() {
    createError.textContent = "";
    meetingNameInput.value = "";
    createModal.hidden = false;
    meetingNameInput.focus();
}

function closeCreateModal() {
    createModal.hidden = true;
}

createForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const name = meetingNameInput.value.trim();

    if (!name) {
        createError.textContent = "Enter a meeting name.";
        meetingNameInput.focus();
        return;
    }

    createSubmit.disabled = true;
    createSubmit.textContent = "Creating…";
    createError.textContent = "";

    try {
        const meetingId = await createMeeting(name);
        enterMeeting(meetingId); // the host joins the room straight away
    } catch (error) {
        createError.textContent = error.message;
        createSubmit.disabled = false;
        createSubmit.textContent = "Create and join";
    }
});

createCancel.addEventListener("click", closeCreateModal);

createModal.addEventListener("click", (event) => {
    if (event.target === createModal) closeCreateModal();
});

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !createModal.hidden) closeCreateModal();
});

createMeetingBtn.addEventListener("click", openCreateModal);

// Instant meeting: same flow, default name
hostMeetingBtn.addEventListener("click", async () => {
    hostMeetingBtn.disabled = true;

    try {
        const name = currentUsername
            ? `${currentUsername}'s meeting`
            : "Instant meeting";
        enterMeeting(await createMeeting(name));
    } catch (error) {
        alert(error.message);
        hostMeetingBtn.disabled = false;
    }
});

// Join by ID or invite link
joinForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const match = joinInput.value
        .toLowerCase()
        .match(/[a-z]{3}-[a-z]{4}-[a-z]{3}/);

    if (!match) {
        joinError.textContent =
            "Enter a meeting ID like abc-defg-hij, or paste the invite link.";
        return;
    }

    joinError.textContent = "";
    enterMeeting(match[0]);
});

// ---------- Sign out ----------

logoutBtn.addEventListener("click", async (event) => {
    event.preventDefault();

    const { error } = await supabase.auth.signOut();

    if (error) {
        alert("Unable to sign out. Please try again.");
        console.error(error);
        return;
    }

    window.location.href = "login.html";
});

// ---------- Navigation ----------

document.getElementById("host-nav").addEventListener("click", (event) => {
    event.preventDefault();
    hostMeetingBtn.click();
});

document.getElementById("create-nav").addEventListener("click", (event) => {
    event.preventDefault();
    openCreateModal();
});

document.getElementById("settings-nav").addEventListener("click", (event) => {
    event.preventDefault();
    alert("Settings functionality coming soon!");
});

// Initialize
loadDashboard();