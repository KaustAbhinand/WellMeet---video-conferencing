import { supabase } from "./supabase.js";

const form = document.getElementById("username-form");
const input = document.getElementById("username");
const errorEl = document.getElementById("username-error");
const saveBtn = document.getElementById("save-btn");

// Only signed-in users belong here
const { data: { session } } = await supabase.auth.getSession();
if (!session) {
    window.location.replace("login.html");
}

input.addEventListener("input", () => {
    errorEl.textContent = "";
});

form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const username = input.value.trim();

    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
        errorEl.textContent =
            "Use 3-20 characters: letters, numbers and underscores only.";
        input.focus();
        return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";

    const { error } = await supabase.rpc("set_username", { p_username: username });

    if (error) {
        console.error("set_username error:", error);
        errorEl.textContent =
            error.code === "23505" || /taken/i.test(error.message || "")
                ? "That username is already taken."
                : "Could not save your username. Please try again.";
        saveBtn.disabled = false;
        saveBtn.textContent = "Continue";
        return;
    }

    window.location.replace("dashboard.html");
});