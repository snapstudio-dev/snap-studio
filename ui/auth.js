/* Claude account: the sign-in of the AI conversations, on this Mac and in
   the sandbox. Opened from Settings, or by the chat when Claude cannot sign
   in. The sign-in commands (`claude auth login`, `claude setup-token`) run
   in a small terminal of the window; the sandbox token printed by
   `setup-token` is caught and stored by the app (see auth.rs). */

const AUTH_TERM = "auth";

const AUTH = {
  term: null,
  fit: null,
  /* "login" or "setup" while the terminal runs. */
  kind: null,
};

function authMsg(text, kind = "") {
  const el = $("auth-msg");
  el.textContent = text || "";
  el.className = "pf-test" + (kind ? " " + kind : "");
}

/* What Claude reports on this Mac. Fast: no model call. */
async function authLocalState() {
  const el = $("auth-local-state");
  el.textContent = tr("auth.reading");
  try {
    const s = await invoke("auth_status", { engine: "local" });
    if (s.error) el.textContent = s.error;
    else if (!s.logged_in) el.textContent = tr("auth.signed_out");
    else el.textContent = [tr("auth.signed_in"), s.email, s.plan].filter(Boolean).join(" · ");
  } catch (e) {
    el.textContent = String(e);
  }
}

/* The sandbox: its own token, or a copy of this Mac's sign-in. Asking
   Claude would start a container: the token's presence says enough. */
async function authSandboxState() {
  let own = false;
  try {
    own = await invoke("auth_sandbox_present");
  } catch {}
  $("auth-box-state").textContent = tr(own ? "auth.sandbox.own" : "auth.sandbox.copy");
  $("auth-box-sub").textContent = tr(own ? "auth.sandbox.own.sub" : "auth.sandbox.copy.sub");
  $("auth-box-setup").textContent = tr(own ? "auth.setup_again" : "auth.setup");
  $("auth-box-clear").classList.toggle("hidden", !own);
}

function authRefresh() {
  authLocalState();
  authSandboxState();
  // The container's own token only matters with yolobox: the built-in
  // sandbox signs in as this computer.
  const yolobox = aiYoloboxScope();
  $("auth-box-title").classList.toggle("hidden", !yolobox);
  $("auth-box-group").classList.toggle("hidden", !yolobox);
}

/* `engine`: the conversation that failed, to say which side to fix. */
function authOpen({ engine = null } = {}) {
  const reason = $("auth-reason");
  if (engine) {
    reason.textContent = tr(engine === "container" ? "auth.failed.container" : "auth.failed.local");
    reason.classList.remove("hidden");
  } else {
    reason.classList.add("hidden");
  }
  authMsg("");
  const modal = $("authmodal");
  if (!modal.classList.contains("hidden") && !modal.classList.contains("closing")) {
    authRefresh();
    return;
  }
  openSheet(modal);
  authRefresh();
}

async function authClose() {
  if (AUTH.kind) await invoke("pty_close", { id: AUTH_TERM }).catch(() => {});
  AUTH.kind = null;
  $("auth-term-wrap").classList.add("hidden");
  closeSheet($("authmodal"));
  // The sign-in may have changed: whoever shows it checks again.
  window.dispatchEvent(new Event("authchange"));
}

/* A real check: one tiny call to the model, on either side. */
async function authCheck(engine, btn) {
  btn.disabled = true;
  authMsg(tr(engine === "container" ? "auth.checking.container" : "auth.checking"));
  try {
    const r = await invoke("auth_verify", { engine });
    authMsg(r.ok ? tr("auth.check_ok") : tr("auth.check_failed", { msg: r.message }), r.ok ? "ok" : "err");
  } catch (e) {
    authMsg(String(e), "err");
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------ terminal */

function authTerm() {
  if (AUTH.term) return AUTH.term;
  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    fontSize: 11.5,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 1000,
    theme: iaTheme(),
  });
  AUTH.fit = new FitAddon.FitAddon();
  term.loadAddon(AUTH.fit);
  term.onData((d) => invoke("pty_write", { id: AUTH_TERM, data: d }).catch(() => {}));
  term.open($("auth-term"));
  AUTH.term = term;
  return term;
}

window.addEventListener("themechange", () => {
  if (AUTH.term) AUTH.term.options.theme = iaTheme();
});

/* Runs a sign-in command in the window's small terminal. */
async function authRun(kind) {
  if (AUTH.kind) await invoke("pty_close", { id: AUTH_TERM }).catch(() => {});
  $("auth-term-wrap").classList.remove("hidden");
  $("auth-term-hint").textContent = tr(kind === "setup" ? "auth.term.setup" : "auth.term.login");
  authMsg("");
  const term = authTerm();
  term.reset();
  AUTH.kind = kind;
  requestAnimationFrame(async () => {
    try {
      AUTH.fit.fit();
    } catch {}
    // The token is printed on one line: as wide as the backend's terminal,
    // the view scrolls sideways.
    if (kind === "setup" && term.cols < 140) term.resize(140, term.rows);
    try {
      await invoke("auth_term_open", { kind, cols: term.cols, rows: term.rows });
    } catch (e) {
      AUTH.kind = null;
      term.writeln(`\x1b[31m${String(e)}\x1b[0m`);
    }
    term.focus();
  });
}

listen("ia-pty", (e) => {
  if (e.payload.id !== AUTH_TERM || !AUTH.term) return;
  const bin = atob(e.payload.b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  AUTH.term.write(bytes);
});

listen("ia-exit", (e) => {
  if (e.payload.id !== AUTH_TERM) return;
  const kind = AUTH.kind;
  AUTH.kind = null;
  if (kind === "login") {
    authLocalState();
    authMsg(tr("auth.login_done"));
  }
});

/* The sandbox token, caught as `setup-token` printed it. */
listen("auth-token", (e) => {
  if (e.payload.ok) {
    authMsg(tr("auth.token_saved"), "ok");
    authSandboxState();
  } else {
    authMsg(e.payload.error || "", "err");
  }
});

/* ------------------------------------------------------------ actions */

$("opt-auth").addEventListener("click", () => authOpen());
$("auth-close").addEventListener("click", authClose);
$("auth-local-check").addEventListener("click", (e) => authCheck("local", e.currentTarget));
$("auth-box-check").addEventListener("click", (e) => authCheck("container", e.currentTarget));
$("auth-local-login").addEventListener("click", () => authRun("login"));
$("auth-box-setup").addEventListener("click", () => authRun("setup"));

$("auth-box-clear").addEventListener("click", async () => {
  try {
    await invoke("auth_sandbox_clear");
    authMsg(tr("auth.token_cleared"));
  } catch (e) {
    authMsg(String(e), "err");
  }
  authSandboxState();
});

$("auth-token-save").addEventListener("click", async () => {
  const input = $("auth-token");
  try {
    await invoke("auth_sandbox_set", { token: input.value });
    input.value = "";
    authMsg(tr("auth.token_saved"), "ok");
  } catch (e) {
    authMsg(String(e), "err");
  }
  authSandboxState();
});

window.addEventListener("langchange", () => {
  if (!$("authmodal").classList.contains("hidden")) authRefresh();
});
