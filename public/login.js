import { supabase } from "./supabase.js";

(function () {
  "use strict";

  var NEXT_PAGE = "dashboard.html";
  var LOGIN_PAGE = "login.html";

  /* ---------------- DOM ---------------- */
  var form = document.getElementById("login-form");
  var emailInput = document.getElementById("email");
  var passwordInput = document.getElementById("password");
  var emailField = emailInput.closest(".field");
  var errorEl = document.getElementById("email-error");
  var nextBtn = document.getElementById("sign-in-btn");
  var googleBtn = document.getElementById("google-btn");

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /* ---------------- UI helpers ---------------- */
  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
    emailField.dataset.invalid = "true";
    emailInput.setAttribute("aria-invalid", "true");
  }

  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = "";
    delete emailField.dataset.invalid;
    emailInput.removeAttribute("aria-invalid");
  }

  function setBusy(busy) {
    nextBtn.disabled = busy;
    googleBtn.disabled = busy;
    nextBtn.textContent = busy ? "Signing in…" : "Sign in";
  }

  // Load the signed-in user's profile row (RLS lets them read their own) and continue.
  async function finishLogin(user) {
    var profile = null;
    var res = await supabase
      .from("users")
      .select("id, email, username, full_name")
      .eq("id", user.id)
      .maybeSingle();
    if (!res.error) profile = res.data;

    sessionStorage.setItem(
      "currentUser",
      JSON.stringify({
        id: user.id,
        email: user.email,
        username: profile ? profile.username : null,
        full_name: profile ? profile.full_name : null
      })
    );
    var redirect = sessionStorage.getItem("postLoginRedirect");
    sessionStorage.removeItem("postLoginRedirect");
    // Only follow same-site relative paths
    var safe = redirect && redirect.charAt(0) === "/" && redirect.charAt(1) !== "/";
    window.location.replace(safe ? redirect : NEXT_PAGE);
  }

  /* ---------------- Email/username + password ---------------- */
  async function resolveEmail(identifier) {
    if (identifier.indexOf("@") !== -1) return identifier.toLowerCase();

    // Username login: needs the email_for_username() SQL function (see notes).
    var res = await supabase.rpc("email_for_username", { p_username: identifier });
    if (res.error || !res.data) {
      throw new Error("Incorrect email/username or password.");
    }
    return res.data;
  }

  async function handleLogin() {
    var identifier = emailInput.value.trim();
    var password = passwordInput.value;

    if (!identifier) {
      showError("Enter your email or username.");
      emailInput.focus();
      return;
    }
    if (identifier.indexOf("@") !== -1 && !EMAIL_RE.test(identifier)) {
      showError("Enter a valid email address, like name@example.com.");
      emailInput.focus();
      return;
    }
    if (!password) {
      showError("Enter your password.");
      passwordInput.focus();
      return;
    }

    setBusy(true);
    try {
      var email = await resolveEmail(identifier);

      var res = await supabase.auth.signInWithPassword({
        email: email,
        password: password
      });

      if (res.error) {
        var msg = (res.error.message || "").toLowerCase();
        if (msg.includes("email not confirmed")) {
          sessionStorage.setItem("pendingVerifyEmail", email);
          window.location.href = "register.html?verify=1";
          return;
        }
        // Same message for "no user" and "wrong password" on purpose.
        throw new Error("Incorrect email/username or password.");
      }

      await finishLogin(res.data.user);
    } catch (err) {
      console.error("Login error:", err);
      showError(err.message || "Something went wrong. Try again.");
      setBusy(false);
    }
  }

  /* ---------------- Google sign-in ---------------- */
  googleBtn.addEventListener("click", async function () {
    setBusy(true);
    try {
      var res = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin + "/" + LOGIN_PAGE }
      });
      console.log("OAuth response:", res);
      if (res.error) throw res.error;
    } catch (err) {
      console.error("Google sign-in error:", err);
      showError(err.message || "Google sign-in failed. Try again.");
      setBusy(false);
    }
  });

  /* ---------------- Events ---------------- */
  emailInput.addEventListener("input", clearError);
  passwordInput.addEventListener("input", clearError);

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (!nextBtn.disabled) handleLogin();
  });

  /* ---------------- Errors passed back in the URL ---------------- */
  function showUrlError() {
    var params = new URLSearchParams(window.location.search);
    var hash = new URLSearchParams(window.location.hash.slice(1));
    var msg = params.get("error_description") || hash.get("error_description");
    if (msg) showError(msg.replace(/\+/g, " "));
  }

  /* ---------------- Existing session check ---------------- */
  // Runs on page load: if a session exists (e.g. returning from Google), continue.
  async function checkExistingSession() {
    var res = await supabase.auth.getSession();
    if (!res.data || !res.data.session) return;

    // getUser() asks the server, so deleted users are rejected
    var userRes = await supabase.auth.getUser();
    if (userRes.error || !userRes.data.user) {
      await supabase.auth.signOut();
      return;
    }

    setBusy(true);
    try {
      await finishLogin(userRes.data.user);
    } catch (err) {
      showError("Sign-in failed. Try again.");
      setBusy(false);
    }
  }

  showUrlError();
  checkExistingSession();
})();