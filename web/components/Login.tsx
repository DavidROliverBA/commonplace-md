// Sign in, or create an account. On a fresh server (needsSetup) it opens on "create account" and
// the first account becomes the admin; SETUP_TOKEN, when the server sets one, must be typed too.

import { useState } from "react";
import { api, type Session } from "../lib/api";

export function Login({ session, onDone }: { session: Session; onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "register">(session.needsSetup ? "register" : "login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(mode === "login" ? "/login" : "/register", { body: { email, password, name, ...(session.setupTokenRequired ? { setupToken } : {}) } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">
          <img src="/icon.svg" alt="" width="44" height="44" />
          <h1>Commonplace</h1>
        </div>
        {session.needsSetup && <p className="notice">Welcome. The first account you create is the admin.</p>}
        {error && <div className="error">{error}</div>}
        {mode === "register" && <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required autoFocus />
        <input
          type="password"
          placeholder={mode === "register" ? "Password (8+ characters)" : "Password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "register" ? "new-password" : "current-password"}
          minLength={mode === "register" ? 8 : undefined}
          required
        />
        {session.setupTokenRequired && (
          <input
            type="password"
            placeholder="Setup token (SETUP_TOKEN on the server)"
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
            autoComplete="off"
            required
          />
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? (mode === "login" ? "Signing in…" : "Creating account…") : mode === "login" ? "Sign in" : "Create account"}
        </button>
        {!session.needsSetup && session.allowSignup && (
          <button type="button" className="link" onClick={() => setMode(mode === "login" ? "register" : "login")}>
            {mode === "login" ? "New here? Create an account" : "Have an account? Sign in"}
          </button>
        )}
        {!session.allowSignup && mode === "login" && <p className="muted small">Accounts are invite-only — ask an admin.</p>}
      </form>
    </div>
  );
}
