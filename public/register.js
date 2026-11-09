import { supabase } from "./supabase.js";

// ---------- DOM ----------
const form = document.getElementById("register-form");
const registerBtn = document.getElementById("register-btn");
const googleBtn = document.getElementById("google-btn");

const fullNameInput = document.getElementById("fullname");
const usernameInput = document.getElementById("username");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");

const registerStep = document.getElementById("register-step");
const verifyStep = document.getElementById("verify-step");
const verifyForm = document.getElementById("verify-form");
const verifyEmailText = document.getElementById("verify-email");
const codeInput = document.getElementById("code");
const verifyBtn = document.getElementById("verify-btn");
const verifyError = document.getElementById("verify-error");
const verifyInfo = document.getElementById("verify-info");
const resendBtn = document.getElementById("resend-btn");
const changeEmailBtn = document.getElementById("change-email-btn");

const RESEND_COOLDOWN_SECONDS = 60; // Supabase also enforces ~60s between emails
const MAX_CODE_ATTEMPTS = 5;
const OTP_LENGTH = 8; // must match Supabase: Authentication -> Providers -> Email -> OTP length

let pendingEmail = "";
let attempts = 0;
let cooldownTimer = null;

// ---------- Validation ----------
function isValidEmail(email) {
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailPattern.test(email)) {
        return false;
    }

    const domain = email.split("@")[1].toLowerCase();

    const blockedDomains = [
        "example.com",
        "abc.com"
    ];

    return !blockedDomains.some(
        blocked =>
            domain === blocked ||
            domain.endsWith("." + blocked)
    );
}

function isValidPassword(password) {
    const hasMinimumLength = password.length >= 8;
    const hasNumber = /\d/.test(password);
    const hasSpecialCharacter = /[^A-Za-z0-9]/.test(password);

    return hasMinimumLength && hasNumber && hasSpecialCharacter;
}

codeInput.maxLength = OTP_LENGTH;

// ---------- Verification step UI ----------
function startCooldown() {
    clearInterval(cooldownTimer);
    let left = RESEND_COOLDOWN_SECONDS;
    resendBtn.disabled = true;
    resendBtn.textContent = `Resend code (${left}s)`;

    cooldownTimer = setInterval(() => {
        left -= 1;
        if (left <= 0) {
            clearInterval(cooldownTimer);
            resendBtn.disabled = false;
            resendBtn.textContent = "Resend code";
        } else {
            resendBtn.textContent = `Resend code (${left}s)`;
        }
    }, 1000);
}

function showVerifyStep(email) {
    pendingEmail = email;
    attempts = 0;
    verifyEmailText.textContent = email;
    verifyError.textContent = "";
    verifyInfo.textContent = "";
    codeInput.value = "";

    registerStep.hidden = true;
    verifyStep.hidden = false;
    startCooldown();
    codeInput.focus();
}

function showRegisterStep() {
    clearInterval(cooldownTimer);
    verifyStep.hidden = true;
    registerStep.hidden = false;
    emailInput.focus();
}

// ---------- Registration ----------
form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const fullName = fullNameInput.value.trim();
    const username = usernameInput.value.trim();
    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;

    if (!fullName || !username || !email || !password) {
        alert("Please fill in all the fields.");
        return;
    }

    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
        alert(
            "Username must be 3-20 characters long " +
            "and contain only letters, numbers and underscores."
        );
        return;
    }

    if (!isValidEmail(email)) {
        alert("Please enter a valid email address.");
        return;
    }

    if (!isValidPassword(password)) {
        alert(
            "Password must contain at least 8 characters, " +
            "one number and one special character."
        );
        return;
    }

    registerBtn.disabled = true;
    registerBtn.textContent = "Creating account...";

    try {
        // Check the username before sending any email
        const { data: available, error: availError } =
            await supabase.rpc("username_available", { p_username: username });

        if (availError) {
            // Function not installed yet: the database trigger still rejects duplicates
            console.warn("username_available check skipped:", availError.message);
        } else if (available === false) {
            alert("That username is already taken. Please choose another.");
            return;
        }

        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: {
                    full_name: fullName,
                    username: username
                }
            }
        });

        if (error) {
            throw error;
        }

        // Email confirmation is off: a session exists straight away
        if (data.session) {
            window.location.replace("dashboard.html");
            return;
        }

        // With confirmation on, an already-registered email comes back
        // as a user with no identities (and no email is sent)
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
            alert("An account with this email already exists. Please sign in instead.");
            return;
        }

        showVerifyStep(email);

    } catch (error) {
        console.error("Registration error:", error);

        const message = error.message?.toLowerCase() || "";

        if (
            message.includes("duplicate key") ||
            message.includes("unique constraint") ||
            message.includes("database error saving new user") ||
            error.code === "23505"
        ) {
            alert("This username or email is already registered.");
        } else if (
            message.includes("already registered") ||
            message.includes("already been registered")
        ) {
            alert("An account with this email already exists.");
        } else {
            alert(error.message || "Registration failed. Please try again.");
        }

    } finally {
        registerBtn.disabled = false;
        registerBtn.textContent = "Register";
    }
});

// ---------- Verify the code ----------
verifyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    verifyError.textContent = "";

    const code = codeInput.value.replace(/\D/g, "");

    if (code.length !== OTP_LENGTH) {
        verifyError.textContent = `Enter the ${OTP_LENGTH}-digit code from your email.`;
        codeInput.focus();
        return;
    }

    if (attempts >= MAX_CODE_ATTEMPTS) {
        verifyError.textContent = "Too many incorrect attempts. Request a new code.";
        return;
    }

    verifyBtn.disabled = true;
    verifyBtn.textContent = "Verifying…";

    try {
        const { data, error } = await supabase.auth.verifyOtp({
            email: pendingEmail,
            token: code,
            type: "email"
        });

        if (error || !data.session) {
            attempts += 1;
            verifyError.textContent = "That code is incorrect or has expired.";
            codeInput.select();
            return;
        }

        window.location.replace("dashboard.html");
    } catch (error) {
        console.error("Verification error:", error);
        verifyError.textContent = "Something went wrong. Please try again.";
    } finally {
        verifyBtn.disabled = false;
        verifyBtn.textContent = "Verify";
    }
});

codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, OTP_LENGTH);
    verifyError.textContent = "";
});

// ---------- Resend ----------
async function sendNewCode() {
    const { error } = await supabase.auth.resend({
        type: "signup",
        email: pendingEmail
    });
    return error;
}

resendBtn.addEventListener("click", async () => {
    verifyError.textContent = "";
    verifyInfo.textContent = "";
    resendBtn.disabled = true;

    const error = await sendNewCode();

    if (error) {
        console.error("Resend error:", error);
        verifyError.textContent = error.message || "Could not send a new code.";
        resendBtn.disabled = false;
        return;
    }

    attempts = 0;
    codeInput.value = "";
    verifyInfo.textContent = "A new code has been sent. Older codes no longer work.";
    startCooldown();
    codeInput.focus();
});

changeEmailBtn.addEventListener("click", showRegisterStep);

// ---------- Google ----------
googleBtn.addEventListener("click", async () => {
    googleBtn.disabled = true;

    const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        // login.js finishes the sign-in once Google redirects back
        options: { redirectTo: window.location.origin + "/login.html" }
    });

    if (error) {
        console.error("Google sign-up error:", error);
        alert(error.message || "Google sign-up failed. Please try again.");
        googleBtn.disabled = false;
    }
});

// ---------- Coming from the login page with an unconfirmed email ----------
(async function resumeVerification() {
    const params = new URLSearchParams(window.location.search);
    const email = sessionStorage.getItem("pendingVerifyEmail");

    if (params.get("verify") !== "1" || !email) return;

    sessionStorage.removeItem("pendingVerifyEmail");
    showVerifyStep(email);

    const error = await sendNewCode();
    if (error) {
        verifyInfo.textContent = "If you already have a code from earlier, you can still enter it.";
    } else {
        verifyInfo.textContent = "We sent you a new code.";
    }
})();