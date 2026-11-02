import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import VoicePanel from "../components/VoicePanel";
import { useAuth } from "../context/AuthContext";
import { useVoice } from "../hooks/useVoice";
import { parseAppIntent } from "../voice/appIntent";
import { speak } from "../voice/speech";

export default function LoginPage() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState("");

  useEffect(() => {
    if (user?.role === "admin") navigate("/admin", { replace: true });
    if (user?.role === "student") navigate("/student", { replace: true });
  }, [user, navigate]);

  useEffect(() => {
    speak("Welcome to AdaptIQ. Please say your username or student ID, then enter your password. Admins may sign in with their credentials.");
  }, []);

  const submit = async (userName, pass) => {
    setBusy(true);
    setError("");
    try {
      const next = await login(userName, pass);
      const msg =
        next.role === "admin"
          ? `Welcome ${next.display_name}. Opening the admin dashboard.`
          : `Welcome ${next.display_name}. Opening your student dashboard.`;
      setResponse(msg);
      await speak(msg);
      navigate(next.role === "admin" ? "/admin" : "/student");
    } catch (err) {
      const msg = err.message || "Login failed.";
      setError(msg);
      await speak(msg);
    } finally {
      setBusy(false);
    }
  };

  const voice = useVoice({
    onFinalTranscript: async (text) => {
      const parsed = parseAppIntent(text);
      if (parsed.intent === "LOGIN_STUDENT") {
        setResponse("Student sign-in selected. Enter your registered credentials and submit the form.");
        await speak("Student sign-in selected. Enter your registered credentials and submit the form.");
        return;
      }
      if (parsed.intent === "LOGIN_ADMIN") {
        setResponse("Administrator sign-in selected. Enter your registered credentials and submit the form.");
        await speak("Administrator sign-in selected. Enter your registered credentials and submit the form.");
        return;
      }
      if (parsed.intent === "HELP") {
        const msg = "Say student login or admin login. You can also type your username and password.";
        setResponse(msg);
        await speak(msg);
        return;
      }
      if (/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,49}$/.test(text.trim())) {
        setUsername(text.trim());
        const msg = `Student username or ID recognized as ${text.trim()}. Enter your password to continue.`;
        setResponse(msg);
        await speak(msg);
        return;
      }
      const msg = "I couldn't recognize that as a username. Please repeat your username or type it.";
      setResponse(msg);
      await speak(msg);
    },
  });

  return (
    <div className="login-split">
      <section className="login-hero" aria-label="AdaptIQ introduction">
        <div className="brand-mark">AQ</div>
        <p className="pill" style={{ background: "rgba(255,255,255,0.18)", color: "white", width: "fit-content" }}>
          AdaptIQ
        </p>
        <h1>Voice-first examinations for independent learning.</h1>
        <p>
          A hands-free adaptive examination system designed for visually impaired students.
          Hear questions, answer by voice, and navigate any item without needing the screen.
        </p>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <h2>Sign in</h2>
          <p className="muted">Use your AdaptIQ username or student ID and password.</p>
          <VoicePanel
            status={voice.status}
            enabled={voice.enabled}
            transcript={voice.transcript}
            interim={voice.interim}
            response={response}
            error={voice.error}
            available={voice.available}
            onToggle={() => (voice.enabled ? voice.disable() : voice.enable())}
          />
          {error ? <div className="alert" role="alert">{error}</div> : null}
          <form onSubmit={(e) => {
            e.preventDefault();
            submit(username, password);
          }}>
            <label className="field">
              Username or student ID
              <input
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </label>
            <label className="field">
              Password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <button className="btn" type="submit" disabled={busy} style={{ width: "100%" }}>
              {busy ? "Signing in…" : "Login"}
            </button>
          </form>
          <p className="muted" style={{ marginTop: 16 }}>
            Student accounts are created by an administrator. Voice option: say your username or student ID, then enter your password manually.
          </p>
        </div>
      </section>
    </div>
  );
}
