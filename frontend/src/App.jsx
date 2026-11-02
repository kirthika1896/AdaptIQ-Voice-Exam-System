import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, getToken, setToken } from "./api/client";
import {
  speak,
  cancelSpeech,
  isSpeaking,
  subscribeSpeech,
} from "./voice/speech";
import { formatMathDisplay } from "./voice/mathFormat";
import { matchExamByTitle, parseAppIntent } from "./voice/appIntent";

const APP_NAME = "AdaptIQ";

function getRecognition() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[?.,!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatClock(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(value / 60);
  const s = value % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* ============================================================
   ROOT APP COMPONENT
============================================================ */

export default function App() {
  const [screen, setScreen] = useState("login");
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  const [selectedExam, setSelectedExam] = useState(null);
  const [results, setResults] = useState(null);
  const [booting, setBooting] = useState(true);

  // Restore session on page reload using GET /api/auth/me and active session check
  useEffect(() => {
    const token = getToken();
    if (!token) {
      setBooting(false);
      return;
    }
    api
      .me()
      .then(async (res) => {
        setUser(res.user);
        if (res.user.role === "admin") {
          setScreen("admin-dashboard");
        } else {
          try {
            const activeRes = await api.activeSession();
            if (activeRes?.session && !activeRes.session.is_submitted) {
              setSession(activeRes);
              setSelectedExam(activeRes.exam);
              setScreen("exam");
              return;
            }
          } catch {
            /* ignore activeSession lookup failure on boot */
          }
          setScreen("student-dashboard");
        }
      })
      .catch(() => {
        setToken(null);
        setUser(null);
        setScreen("login");
      })
      .finally(() => {
        setBooting(false);
      });
  }, []);

  const logout = useCallback(async () => {
    cancelSpeech();
    try {
      if (getToken()) {
        await api.logout();
      }
    } catch {
      /* ignore network errors on logout */
    }
    setToken(null);
    setUser(null);
    setSession(null);
    setSelectedExam(null);
    setResults(null);
    setScreen("login");
    speak("You have been logged out.");
  }, []);

  if (booting) {
    return (
      <div className="fullscreen-loading" role="status" aria-live="polite">
        <div className="loader large" />
        <h2>Starting AdaptIQ...</h2>
        <p>Connecting to accessible voice examination services.</p>
      </div>
    );
  }

  if (screen === "login") {
    return (
      <LoginPage
        onLogin={(loggedUser) => {
          setUser(loggedUser);
          if (loggedUser.role === "admin") {
            setScreen("admin-dashboard");
          } else {
            setScreen("student-dashboard");
          }
        }}
      />
    );
  }

  if (screen === "admin-dashboard" && user?.role === "admin") {
    return (
      <AdminDashboard
        user={user}
        onLogout={logout}
      />
    );
  }

  if (screen === "student-dashboard" && user?.role === "student") {
    return (
      <StudentDashboard
        user={user}
        onLogout={logout}
        onStartExam={(examData, sessionData) => {
          setSelectedExam(examData);
          setSession(sessionData);
          setScreen("exam");
        }}
      />
    );
  }

  if (screen === "exam" && user?.role === "student") {
    return (
      <ExamScreen
        user={user}
        exam={selectedExam}
        existingSession={session}
        onSessionChange={setSession}
        onGoReview={() => setScreen("review")}
        onExit={() => setScreen("student-dashboard")}
        onResults={(resultData) => {
          setResults(resultData);
          setScreen("results");
        }}
      />
    );
  }

  if (screen === "review" && user?.role === "student") {
    return (
      <ReviewScreen
        user={user}
        session={session}
        onSessionChange={setSession}
        onReturnToExam={() => setScreen("exam")}
        onResults={(resultData) => {
          setResults(resultData);
          setScreen("results");
        }}
      />
    );
  }

  if (screen === "results" && user?.role === "student") {
    return (
      <ResultsScreen
        user={user}
        session={session}
        results={results}
        onDashboard={() => {
          setSession(null);
          setSelectedExam(null);
          setResults(null);
          setScreen("student-dashboard");
        }}
      />
    );
  }

  return null;
}

/* ============================================================
   AUTHENTICATION: LOGIN PAGE
============================================================ */

function LoginPage({ onLogin }) {
  const [role, setRole] = useState("student");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [listening, setListening] = useState(false);
  const [voiceStage, setVoiceStage] = useState("idle");

  const recognitionRef = useRef(null);
  const voiceStageRef = useRef("idle");
  const voiceUsernameRef = useRef("");

  const updateVoiceStage = (stage) => {
    voiceStageRef.current = stage;
    setVoiceStage(stage);
  };

  // Switch default demo credentials on role change
  const handleRoleChange = (newRole) => {
    setRole(newRole);
  };

  useEffect(() => {
    speak(
      "Welcome to AdaptIQ. You can sign in by saying your username or student ID, then saying your password, or enter both in the form."
    );
    return () => {
      cancelSpeech();
      voiceStageRef.current = "idle";
      try {
        recognitionRef.current?.abort();
      } catch {}
    };
  }, []);

  const login = async (u = username, p = password) => {
    setError("");
    const targetUser = String(u || "").trim();
    if (!targetUser) {
      setError("Please enter your username.");
      speak("Please enter your username.");
      return;
    }

    setBusy(true);

    try {
      const data = await api.login(targetUser, p);
      setToken(data.token);
      const loggedUser = data.user;
      onLogin(loggedUser);

      speak(
        loggedUser.role === "admin"
          ? `Admin login successful. Welcome ${loggedUser.display_name}. Opening the administration dashboard.`
          : `Student login successful. Welcome ${loggedUser.display_name}. Opening your examination dashboard.`
      );
    } catch (err) {
      const msg = err.message || "Invalid username or password.";
      setError(msg);
      speak(`Login failed. ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const startVoiceLogin = () => {
    const Recognition = getRecognition();

    if (!Recognition) {
      setError("Voice recognition is unavailable. Please use Chrome or Edge, or enter your credentials manually.");
      speak("Voice recognition is unavailable in this browser. Please use Chrome or Edge.");
      return;
    }

    if (voiceStageRef.current !== "idle") {
      voiceStageRef.current = "idle";
      setVoiceStage("idle");
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      setListening(false);
      return;
    }

    const beginCapture = (stage) => {
      const recognition = new Recognition();
      recognitionRef.current = recognition;
      updateVoiceStage(stage);
      recognition.lang = "en-IN";
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        setListening(true);
        setError("");
      };

      recognition.onresult = async (event) => {
        const transcript = (event.results?.[0]?.[0]?.transcript || "").trim();
        recognitionRef.current = null;
        setListening(false);

        if (!transcript) {
          updateVoiceStage("idle");
          setError("I couldn't understand that. Please try voice sign-in again.");
          speak("Sorry, I couldn't understand that. Please try again.");
          return;
        }

        if (stage === "username") {
          const identity = transcript
            .replace(/^(?:my\s+)?(?:username|student\s+id|user\s+id)\s+(?:is\s+)?/i, "")
            .trim();
          if (!identity) {
            updateVoiceStage("idle");
            setError("I couldn't recognize your username or student ID. Please try again.");
            speak("I couldn't recognize your username or student ID. Please try again.");
            return;
          }

          voiceUsernameRef.current = identity;
          setUsername(identity);
          updateVoiceStage("password");
          await speak("Username captured. Now say your password.");
          if (voiceStageRef.current === "password") {
            beginCapture("password");
          }
          return;
        }

        updateVoiceStage("idle");
        await login(voiceUsernameRef.current, transcript);
      };

      recognition.onerror = (event) => {
        if (event.error !== "aborted") {
          setError(
            event.error === "no-speech"
              ? "No speech was detected. Please try voice sign-in again."
              : "Voice sign-in failed. Please try again or enter your credentials manually."
          );
        }
        setListening(false);
        if (voiceStageRef.current === stage) {
          updateVoiceStage("idle");
        }
      };

      recognition.onend = () => {
        setListening(false);
      };

      cancelSpeech();
      try {
        recognition.start();
      } catch {
        recognitionRef.current = null;
        updateVoiceStage("idle");
        setError("Could not start voice recognition. Please try again or enter your credentials manually.");
        setListening(false);
      }
    };

    cancelSpeech();
    setPassword("");
    voiceUsernameRef.current = "";
    updateVoiceStage("username");
    beginCapture("username");
  };

  return (
    <div className="login-page">
      <div className="login-decoration decoration-one" />
      <div className="login-decoration decoration-two" />

      <div className="login-card">
        <div className="brand-large">
          <div className="brand-icon">AQ</div>
          <div>
            <div className="brand-name">AdaptIQ</div>
            <div className="brand-tagline">AI Voice Examination System</div>
          </div>
        </div>

        <div className="login-heading">
          <div className="eyebrow">ACCESSIBLE EXAMINATION PLATFORM</div>
          <h1>
            Welcome to
            <br />
            <span>AdaptIQ Voice Exam</span>
          </h1>
          <p>
            100% hands-free examination for visually impaired students. Complete
            tests independently using natural voice interaction.
          </p>
        </div>

        <div className="role-switch" role="tablist" aria-label="Select User Role">
          <button
            type="button"
            role="tab"
            aria-selected={role === "student"}
            className={role === "student" ? "active" : ""}
            onClick={() => handleRoleChange("student")}
          >
            Student
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={role === "admin"}
            className={role === "admin" ? "active" : ""}
            onClick={() => handleRoleChange("admin")}
          >
            Administrator
          </button>
        </div>

        <form
          className="login-form"
          onSubmit={(e) => {
            e.preventDefault();
            login();
          }}
        >
          <label htmlFor="login-username">Username</label>
          <input
            id="login-username"
            type="text"
            autoComplete="username"
            value={username}
            placeholder={role === "student" ? "student" : "admin"}
            onChange={(e) => setUsername(e.target.value)}
          />

          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            placeholder="Enter your password"
            onChange={(e) => setPassword(e.target.value)}
          />

          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="primary-button full-width"
            disabled={busy}
          >
            {busy ? "Signing in..." : `Sign in as ${role === "admin" ? "Administrator" : "Student"}`}
          </button>

          <button
            type="button"
            className={`voice-login-button ${listening ? "listening" : ""}`}
            onClick={startVoiceLogin}
            aria-label={voiceStage === "idle" ? "Sign in by saying username and password" : "Cancel voice sign-in"}
          >
            <span className="mic-circle" aria-hidden="true">🎙</span>
            {voiceStage === "username"
              ? "Listening for username..."
              : voiceStage === "password"
                ? listening
                  ? "Listening for password..."
                  : "Preparing password capture..."
                : "Sign in with voice (username, then password)"}
          </button>
        </form>

        <p className="login-accessibility" role="note">
          Voice password privacy: browser speech recognition may process microphone audio using its speech service. Password transcripts are not displayed or repeated.
        </p>

        <div className="login-accessibility">
          <span>●</span>
          WCAG 2.2 Accessible
          <span>•</span>
          Voice-First Architecture
          <span>•</span>
          FastAPI & SQLite
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   APP SHELL NAVIGATION
============================================================ */

function AppShell({
  user,
  active,
  navItems = [],
  onNavigate,
  onLogout,
  onReturnAdmin,
  children,
}) {
  const isStudent = user?.role === "student";
  const defaultNavItems = isStudent
    ? [
        { id: "exams", label: "Available Exams", icon: "📝" },
        { id: "attempts", label: "Past Attempts & Results", icon: "📊" },
        { id: "guide", label: "Talk Naturally", icon: "🎙" },
        { id: "accessibility", label: "Accessibility & Tips", icon: "♿" },
      ]
    : [
        { id: "exams", label: "Manage Exams & Questions", icon: "📚" },
        { id: "create", label: "Create Examination", icon: "➕" },
        { id: "paper", label: "Scanned Paper (PDF)", icon: "📄" },
        { id: "attempts", label: "Student Attempts", icon: "👥" },
        { id: "activity", label: "Recent Activity Feed", icon: "📈" },
      ];

  const items = navItems.length > 0 ? navItems : defaultNavItems;

  return (
    <div className="app-layout">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      {/* Main Workspace Layout */}
      <div className="app-workspace" style={{ display: "flex", flex: 1, minHeight: "100vh" }}>
        <aside
          className="sidebar"
          aria-label="Portal Navigation"
          style={{ paddingTop: 20 }}
        >
          <header className="sidebar-header" role="banner">
            <div className="sidebar-app-brand">
              <div
                className="brand-icon"
                aria-hidden="true"
                style={{ width: 36, height: 36, fontSize: 16 }}
              >
                AQ
              </div>
              <div>
                <strong>AdaptIQ</strong>
                <span className="sidebar-app-badge">Voice Examination System</span>
              </div>
            </div>

            <div className="sidebar-user-chip">
              <span
                className="voice-status-dot"
                style={{ background: "#22c55e", width: 8, height: 8 }}
                title="Backend Online"
                aria-hidden="true"
              />
              <span className="sidebar-user-name">
                {user?.display_name || user?.username || "User"}
              </span>
              <span className="sidebar-user-username">
                @{user?.username || "user"}
              </span>
              <span
                className={`role-pill ${
                  user?.role === "admin" ? "role-admin" : "role-student"
                }`}
              >
                {user?.role === "admin" ? "Administrator" : "Student"}
              </span>
            </div>

            <button
              type="button"
              className="sidebar-logout-btn"
              onClick={onLogout}
              aria-label="Log out of AdaptIQ"
            >
              Log Out
            </button>

            {onReturnAdmin && (
              <button
                type="button"
                className="outline-button"
                style={{ padding: "6px 12px", fontSize: 12 }}
                onClick={onReturnAdmin}
              >
                ← Admin Gateway
              </button>
            )}
          </header>

          <div className="sidebar-section-label">
            {isStudent ? "STUDENT PORTAL" : "ADMINISTRATION GATEWAY"}
          </div>

          <nav aria-label="Sidebar Navigation">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={active === item.id ? "nav-item active" : "nav-item"}
                onClick={() => onNavigate(item.id)}
                aria-current={active === item.id ? "page" : undefined}
              >
                <span aria-hidden="true">{item.icon}</span>
                {item.label}
                {item.badge != null && (
                  <span
                    style={{
                      marginLeft: "auto",
                      background:
                        active === item.id
                          ? "rgba(108,92,231,0.2)"
                          : "#ebe8f2",
                      color: active === item.id ? "#6c5ce7" : "#656075",
                      padding: "2px 8px",
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 800,
                    }}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            ))}
          </nav>

        </aside>

        <main id="main-content" className="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}

/* ============================================================
   STUDENT DASHBOARD
============================================================ */

function StudentDashboard({ user, onLogout, onStartExam, onReturnAdmin }) {
  const [exams, setExams] = useState([]);
  const [activeSession, setActiveSession] = useState(null);
  const [pastAttempts, setPastAttempts] = useState([]);
  const [selectedAttemptResult, setSelectedAttemptResult] = useState(null);
  const [activeTab, setActiveTab] = useState("exams");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [listening, setListening] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState("");

  const recognitionRef = useRef(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const [examData, activeData, resultsData] = await Promise.all([
        api.listExams(),
        api.activeSession().catch(() => ({ ok: true, session: null })),
        api.myResults().catch(() => ({ ok: true, attempts: [] })),
      ]);

      const publishedExams = examData.exams || [];
      const studentAttempts = resultsData.attempts || [];

      setExams(publishedExams);
      setActiveSession(activeData.session || null);
      setPastAttempts(studentAttempts);

      const count = publishedExams.length;
      let intro = `Welcome ${user?.display_name || "Student"}. You have ${count} available examination${
        count === 1 ? "" : "s"
      }.`;
      if (activeData.session) {
        intro += " You have an active examination in progress. Say resume exam to continue.";
      } else if (publishedExams[0]) {
        intro += ` Say start exam to begin ${publishedExams[0].title}.`;
      }
      speak(intro);
    } catch (err) {
      setError(err.message || "Failed to connect to examination services.");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadData();
    return () => {
      cancelSpeech();
      try {
        recognitionRef.current?.abort();
      } catch {}
    };
  }, [loadData]);

  const handleStartExam = async (exam, forceNew = false) => {
    try {
      cancelSpeech();
      const telemetry = await api.startSession(exam.id, forceNew);
      onStartExam(exam, telemetry);
    } catch (err) {
      setError(err.message);
      speak(`Could not start examination. ${err.message}`);
    }
  };

  const handleResumeActive = async () => {
    if (!activeSession) return;
    try {
      cancelSpeech();
      const exam = exams.find((e) => e.id === activeSession.exam_id) || {
        id: activeSession.exam_id,
        title: "Examination",
      };
      const telemetry = await api.getSession(activeSession.session_id);
      onStartExam(exam, telemetry);
    } catch (err) {
      setError(err.message);
      speak(`Could not resume examination. ${err.message}`);
    }
  };

  // Interpret a natural-language request from the dashboard.
  const startVoiceCommand = () => {
    const Recognition = getRecognition();
    if (!Recognition) {
      speak("Voice recognition is not supported in this browser.");
      return;
    }

    if (listening) {
      recognitionRef.current?.abort();
      setListening(false);
      return;
    }

    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.lang = "en-IN";
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onstart = () => {
      setListening(true);
    };

    recognition.onresult = async (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript || "";
      const parsed = parseAppIntent(transcript);
      setVoiceNotice(`“${transcript}”`);

      if (parsed.intent === "RESUME_EXAM" && activeSession) {
        speak("Resuming your active examination.");
        await handleResumeActive();
      } else if (
        parsed.intent === "START_EXAM" ||
        parsed.intent === "START_EXAM_INDEX" ||
        parsed.intent === "START_EXAM_NAMED"
      ) {
        if (parsed.intent === "START_EXAM") {
          setActiveTab("exams");
          speak(
            exams.length
              ? `Which examination would you like to take? Available exams are: ${exams.map((exam) => exam.title).join(", ")}. Please choose one by name.`
              : "There are no published examinations available right now."
          );
          return;
        }
        const target =
          parsed.intent === "START_EXAM_NAMED"
            ? matchExamByTitle(exams, parsed.title)
            : exams[parsed.index];
        if (!target) {
          setActiveTab("exams");
          speak(
            parsed.intent === "START_EXAM_NAMED"
              ? `I couldn't identify one unique exam matching ${parsed.title}. Please choose an exam by its full name.`
              : "I couldn't identify that exam. Please choose one from the available exams."
          );
          return;
        }
        speak(`Opening ${target.title} for you.`);
        await handleStartExam(target);
      } else if (parsed.intent === "MY_RESULTS" || parsed.intent === "READ_RESULT") {
        setActiveTab("attempts");
        speak(`Displaying your past examination results. You have completed ${pastAttempts.length} examinations.`);
      } else if (parsed.intent === "LIST_EXAMS") {
        setActiveTab("exams");
        speak(
          exams.length
            ? `You have ${exams.length} available examinations. You can ask to take one by its name.`
            : "There are no published examinations available right now."
        );
      } else if (parsed.intent === "VOICE_GUIDE") {
        setActiveTab("guide");
        speak("Here are some natural ways to talk to AdaptIQ.");
      } else if (/\b(accessibility|shortcut|keyboard)\b/i.test(transcript)) {
        setActiveTab("accessibility");
        speak("Displaying accessibility tips and keyboard shortcuts.");
      } else if (parsed.intent === "LOGOUT") {
        onLogout();
      } else {
        speak("I didn't understand what you wanted to do. You can ask naturally to take an exam, continue an exam, or see your results.");
      }
    };

    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);

    cancelSpeech();
    try {
      recognition.start();
    } catch {
      setListening(false);
    }
  };

  // Performance calculation from real backend results
  const completedCount = pastAttempts.length;
  const avgScore = completedCount
    ? Math.round(
        pastAttempts.reduce(
          (acc, a) => acc + (a.results?.percentage || 0),
          0
        ) / completedCount
      )
    : 0;
  const bestScore = completedCount
    ? Math.round(
        Math.max(...pastAttempts.map((a) => a.results?.percentage || 0))
      )
    : 0;
  const totalQuestionsAnswered = pastAttempts.reduce(
    (acc, a) => acc + (a.results?.answered || 0),
    0
  );

  const navItems = [
    { id: "exams", label: "Available Exams", icon: "📝", badge: exams.length },
    { id: "attempts", label: "Past Attempts & Results", icon: "📊", badge: completedCount },
    { id: "guide", label: "Talk Naturally", icon: "🎙" },
    { id: "accessibility", label: "Accessibility & Tips", icon: "♿" },
  ];

  return (
    <AppShell
      user={user}
      active={activeTab}
      navItems={navItems}
      onNavigate={setActiveTab}
      onLogout={onLogout}
      onReturnAdmin={onReturnAdmin}
    >
      <div className="page-header">
        <div>
          <div className="eyebrow">ACCESSIBLE EXAMINATION PORTAL</div>
          <h1 style={{ margin: "6px 0 10px" }}>
            Welcome, {user?.display_name || "Student"} 👋
          </h1>
          <p style={{ color: "#635c75", margin: 0 }}>
            100% Hands-Free Voice-Native Examination System for Visually Impaired Students.
          </p>
        </div>

        <button
          type="button"
          className={`primary-button voice-command-pill ${listening ? "active" : ""}`}
          onClick={startVoiceCommand}
          aria-label={
            listening
              ? "Listening. Click to stop."
              : "Speak naturally to interact with the student dashboard"
          }
        >
          <span aria-hidden="true">🎙</span>
          {listening ? "Listening. Speak naturally..." : "Talk to AdaptIQ"}
        </button>
      </div>

      {voiceNotice && (
        <div className="voice-notice" aria-live="polite">
          Voice recognized: <strong>{voiceNotice}</strong>
        </div>
      )}

      {error && (
        <div className="error-box" role="alert">
          <div>{error}</div>
          <button
            type="button"
            className="outline-button"
            style={{ marginTop: 8, padding: "6px 14px", fontSize: 13 }}
            onClick={loadData}
          >
            Retry Connection
          </button>
        </div>
      )}

      {/* Active Examination Resumption Banner */}
      {activeSession && (
        <div
          className="resumable-card"
          role="region"
          aria-label="Active Examination in Progress"
          style={{ marginBottom: 24 }}
        >
          <div className="resumable-header">
            <span className="live-dot" aria-hidden="true" />
            <strong>Active Examination in Progress</strong>
          </div>
          <p>
            You have an unfinished examination session. Your answers, marked
            questions, and remaining time (
            {formatClock(activeSession.time_remaining_seconds)}) are securely preserved.
          </p>
          <div className="resumable-actions">
            <button
              type="button"
              className="primary-button"
              onClick={handleResumeActive}
            >
              Resume Examination Now →
            </button>
          </div>
        </div>
      )}

      {/* Subnavigation Tabs */}
      <div className="subnav-tabs" role="tablist" aria-label="Student Portal Sections">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "exams"}
          className={`subnav-btn ${activeTab === "exams" ? "active" : ""}`}
          onClick={() => setActiveTab("exams")}
        >
          📝 Available Exams ({exams.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "attempts"}
          className={`subnav-btn ${activeTab === "attempts" ? "active" : ""}`}
          onClick={() => setActiveTab("attempts")}
        >
          📊 Past Attempts & Results ({completedCount})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "guide"}
          className={`subnav-btn ${activeTab === "guide" ? "active" : ""}`}
          onClick={() => setActiveTab("guide")}
        >
          🎙 Talk Naturally
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "accessibility"}
          className={`subnav-btn ${activeTab === "accessibility" ? "active" : ""}`}
          onClick={() => setActiveTab("accessibility")}
        >
          ♿ Accessibility & Shortcuts
        </button>
      </div>

      {/* TAB 1: AVAILABLE EXAMINATIONS */}
      {activeTab === "exams" && (
        <div>
          <div className="section-heading">
            <div>
              <h2 style={{ margin: 0 }}>Available Examinations</h2>
              <p style={{ color: "#635c75", margin: "4px 0 0" }}>
                Select an examination paper to start your hands-free voice test session.
              </p>
            </div>
            <span className="badge badge-published">
              {exams.length} Ready & Published
            </span>
          </div>

          {loading ? (
            <div className="loading-card" role="status" aria-live="polite">
              <div className="loader" /> Loading available examination papers...
            </div>
          ) : exams.length === 0 ? (
            <div className="empty-card">
              <div className="empty-icon" aria-hidden="true">📝</div>
              <h3>No examinations published yet</h3>
              <p>
                Your institution or instructor has not published any examinations yet.
                Check back shortly.
              </p>
            </div>
          ) : (
            <div className="exam-card-grid">
              {exams.map((exam) => {
                const isCurrentActive = activeSession?.exam_id === exam.id;

                return (
                  <div key={exam.id} className="exam-card">
                    <div className="exam-card-header">
                      <span className="exam-tag">{exam.subject || "General"}</span>
                      <span className="exam-duration">⏱ {exam.duration_minutes} min</span>
                    </div>

                    <h3 style={{ margin: "14px 0 8px" }}>{exam.title}</h3>
                    <p style={{ color: "#635c75", fontSize: 14, minHeight: 40 }}>
                      {exam.description ||
                        "Voice-adaptive accessible examination with automated speech parsing."}
                    </p>

                    <div className="exam-meta">
                      <span>📝 {exam.question_count || 0} Questions</span>
                      <span>•</span>
                      <span style={{ color: "#16a34a", fontWeight: 700 }}>
                        ✓ {exam.status === "published" ? "Published & Ready" : "Draft"}
                      </span>
                      <span>•</span>
                      <span>🎙 Voice-Native</span>
                    </div>

                    <div className="exam-card-actions" style={{ marginTop: 18 }}>
                      {isCurrentActive ? (
                        <button
                          type="button"
                          className="primary-button full-width"
                          onClick={handleResumeActive}
                          aria-label={`Resume active examination ${exam.title}`}
                        >
                          Resume Active Exam →
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="primary-button full-width"
                          onClick={() => handleStartExam(exam)}
                          aria-label={`Start examination ${exam.title}`}
                        >
                          Start Examination →
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: PAST ATTEMPTS & RESULTS */}
      {activeTab === "attempts" && (
        <div>
          <div className="section-heading">
            <div>
              <h2 style={{ margin: 0 }}>My Examination Attempts & Results</h2>
              <p style={{ color: "#635c75", margin: "4px 0 0" }}>
                Official score history and detailed question performance records.
              </p>
            </div>
            <span className="badge badge-published">
              {completedCount} Completed
            </span>
          </div>

          {completedCount > 0 && (
            <div className="metrics-summary-grid">
              <div className="metric-stat-card">
                <div className="metric-stat-num">{completedCount}</div>
                <div className="metric-stat-lbl">Exams Completed</div>
              </div>
              <div className="metric-stat-card">
                <div className="metric-stat-num">{avgScore}%</div>
                <div className="metric-stat-lbl">Average Score</div>
              </div>
              <div className="metric-stat-card">
                <div className="metric-stat-num">{bestScore}%</div>
                <div className="metric-stat-lbl">Highest Score</div>
              </div>
              <div className="metric-stat-card">
                <div className="metric-stat-num">{totalQuestionsAnswered}</div>
                <div className="metric-stat-lbl">Questions Answered</div>
              </div>
            </div>
          )}

          {loading ? (
            <div className="loading-card" role="status" aria-live="polite">
              <div className="loader" /> Loading attempt history...
            </div>
          ) : completedCount === 0 ? (
            <div className="empty-card">
              <div className="empty-icon" aria-hidden="true">📊</div>
              <h3>No examination attempts recorded yet</h3>
              <p>
                Once you complete and submit an examination, your scores, percentage,
                and question reviews will be safely archived here.
              </p>
              <button
                type="button"
                className="outline-button"
                style={{ marginTop: 14 }}
                onClick={() => setActiveTab("exams")}
              >
                Go to Available Exams →
              </button>
            </div>
          ) : (
            <div className="review-table-card">
              <table className="review-table">
                <thead>
                  <tr>
                    <th scope="col">Examination Paper</th>
                    <th scope="col">Subject</th>
                    <th scope="col">Submitted On</th>
                    <th scope="col">Score</th>
                    <th scope="col">Result</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pastAttempts.map((attempt) => {
                    const r = attempt.results;
                    const dateStr = attempt.ended_at
                      ? new Date(attempt.ended_at * 1000).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "Recently";

                    return (
                      <tr key={attempt.session_id}>
                        <td>
                          <strong>{attempt.exam?.title || attempt.exam_id}</strong>
                        </td>
                        <td>{attempt.exam?.subject || "General"}</td>
                        <td>{dateStr}</td>
                        <td>
                          <strong>
                            {r ? `${r.score} / ${r.total_marks}` : "—"}
                          </strong>
                        </td>
                        <td>
                          {r ? (
                            <span
                              className={`status-tag ${
                                r.percentage >= 50 ? "answered" : "unanswered"
                              }`}
                            >
                              {r.percentage}%
                            </span>
                          ) : (
                            <span className="status-tag">Submitted</span>
                          )}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="outline-button"
                            style={{ padding: "5px 12px", fontSize: 13 }}
                            onClick={() => setSelectedAttemptResult(attempt)}
                            aria-label={`View detailed score for ${attempt.exam?.title}`}
                          >
                            View Results Breakdown →
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: VOICE COMMAND GUIDE */}
      {activeTab === "guide" && (
        <div>
          <div className="section-heading">
            <div>
              <h2 style={{ margin: 0 }}>Voice Assistant & Spoken Commands Guide</h2>
              <p style={{ color: "#635c75", margin: "4px 0 0" }}>
                AdaptIQ responds naturally to conversational English across the entire exam flow.
              </p>
            </div>
            <button
              type="button"
              className={`primary-button ${listening ? "active" : ""}`}
              onClick={startVoiceCommand}
            >
              🎙 {listening ? "Listening..." : "Test Voice Listener"}
            </button>
          </div>

          <div className="voice-guide-grid">
            <div className="voice-guide-card">
              <h3>
                <span aria-hidden="true">🧭</span> Navigation Commands
              </h3>
              <div className="voice-cmd-list">
                <div className="voice-cmd-item">
                  <code>“Next question”</code>
                  <span>Moves to subsequent question</span>
                </div>
                <div className="voice-cmd-item">
                  <code>“Previous question”</code>
                  <span>Returns to earlier question</span>
                </div>
                <div className="voice-cmd-item">
                  <code>“Go to question 17”</code>
                  <span>Jumps directly to target number</span>
                </div>
                <div className="voice-cmd-item">
                  <code>“Take me to question 5”</code>
                  <span>Instant random-access navigation</span>
                </div>
              </div>
            </div>

            <div className="voice-guide-card">
              <h3>
                <span aria-hidden="true">✍️</span> Answering Commands
              </h3>
              <div className="voice-cmd-list">
                <div className="voice-cmd-item">
                  <code>“Option A / B / C / D”</code>
                  <span>Selects multiple-choice option</span>
                </div>
                <div className="voice-cmd-item">
                  <code>“My answer is 50”</code>
                  <span>Submits numerical solution</span>
                </div>
                <div className="voice-cmd-item">
                  <code>“x squared plus 5x equals 0”</code>
                  <span>Compiles into LaTeX math</span>
                </div>
                <div className="voice-cmd-item">
                  <code>“Dictate descriptive text”</code>
                  <span>Full speech-to-text recording</span>
                </div>
              </div>
            </div>

            <div className="voice-guide-card">
              <h3>
                <span aria-hidden="true">🔍</span> Review & Status Commands
              </h3>
              <div className="voice-cmd-list">
                <div className="voice-cmd-item">
                  <code>“Repeat the question”</code>
                  <span>Re-reads prompt and options</span>
                </div>
                <div className="voice-cmd-item">
                  <code>“Read my answer”</code>
                  <span>Dictates recorded answer</span>
                </div>
                <div className="voice-cmd-item">
                  <code>“Clear my answer”</code>
                  <span>Erases current question answer</span>
                </div>
                <div className="voice-cmd-item">
                  <code>“Mark this question”</code>
                  <span>Flags question for later review</span>
                </div>
                <div className="voice-cmd-item">
                  <code>“Unmark this question”</code>
                  <span>Removes review flag</span>
                </div>
                <div className="voice-cmd-item">
                  <code>“What is unanswered?”</code>
                  <span>Lists all missing questions</span>
                </div>
                <div className="voice-cmd-item">
                  <code>“How much time is left?”</code>
                  <span>Announces remaining minutes</span>
                </div>
              </div>
            </div>

            <div className="voice-guide-card">
              <h3>
                <span aria-hidden="true">🚀</span> Finalizing Commands
              </h3>
              <div className="voice-cmd-list">
                <div className="voice-cmd-item">
                  <code>“Review my exam”</code>
                  <span>Opens paper summary table</span>
                </div>
                <div className="voice-cmd-item">
                  <code>“Submit my exam”</code>
                  <span>Initiates final confirmation</span>
                </div>
                <div className="voice-cmd-item">
                  <code>“Yes / Confirm”</code>
                  <span>Confirms final submission</span>
                </div>
                <div className="voice-cmd-item">
                  <code>“Cancel / No”</code>
                  <span>Cancels submission prompt</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: ACCESSIBILITY & SHORTCUTS */}
      {activeTab === "accessibility" && (
        <div>
          <div className="section-heading">
            <div>
              <h2 style={{ margin: 0 }}>Accessibility Architecture & Keyboard Fallbacks</h2>
              <p style={{ color: "#635c75", margin: "4px 0 0" }}>
                AdaptIQ is built to WCAG 2.1 AA accessibility standards for complete hands-free or keyboard-only use.
              </p>
            </div>
          </div>

          <div className="dashboard-card full-card">
            <h3>Standard Keyboard Navigation</h3>
            <p style={{ color: "#635c75", marginBottom: 18 }}>
              Students can operate the examination using keyboard navigation alongside or instead of speech recognition:
            </p>

            <table className="review-table">
              <thead>
                <tr>
                  <th scope="col">Keystroke</th>
                  <th scope="col">Function</th>
                  <th scope="col">Behavior</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><strong>Tab / Shift+Tab</strong></td>
                  <td>Navigate interactive elements</td>
                  <td>Moves sequential focus with high-visibility purple ring</td>
                </tr>
                <tr>
                  <td><strong>Enter / Space</strong></td>
                  <td>Activate control</td>
                  <td>Selects options, clicks buttons, toggles switches</td>
                </tr>
                <tr>
                  <td><strong>Alt + M</strong></td>
                  <td>Toggle microphone</td>
                  <td>Pauses or resumes hands-free voice loop</td>
                </tr>
                <tr>
                  <td><strong>Escape</strong></td>
                  <td>Close dialogs</td>
                  <td>Dismisses open modals or cancels submit dialogs</td>
                </tr>
              </tbody>
            </table>

            <h3 style={{ marginTop: 24 }}>Screen Reader & Voice Loop Integration</h3>
            <ul style={{ color: "#4b455c", lineHeight: 1.8, paddingLeft: 22 }}>
              <li>
                <strong>Automatic Voice Turn Taking:</strong> When the speech synthesizer finishes reading a question, the microphone automatically resumes listening without requiring manual mouse clicks.
              </li>
              <li>
                <strong>Audio Echo Protection:</strong> Speech synthesis automatically mutes the microphone while reading questions to prevent audio feedback loops.
              </li>
              <li>
                <strong>Semantic Landmarks & ARIA Live Regions:</strong> Real-time announcements, time updates, and transcript results are relayed via ARIA live regions for screen readers like NVDA, JAWS, and VoiceOver.
              </li>
            </ul>
          </div>
        </div>
      )}

      {/* PAST ATTEMPT RESULT BREAKDOWN MODAL */}
      {selectedAttemptResult && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="attempt-modal-title"
          onClick={() => setSelectedAttemptResult(null)}
        >
          <div
            className="modal-container"
            onClick={(e) => e.stopPropagation()}
            style={{ width: "min(800px, 95%)" }}
          >
            <div className="modal-header">
              <h3 id="attempt-modal-title" className="modal-title">
                Attempt Result: {selectedAttemptResult.exam?.title || "Examination"}
              </h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setSelectedAttemptResult(null)}
                aria-label="Close attempt details dialog"
              >
                ✕
              </button>
            </div>

            <div className="modal-body">
              {selectedAttemptResult.results ? (
                <>
                  <div style={{ textAlign: "center", marginBottom: 20 }}>
                    <div className="score-circle" style={{ margin: "0 auto 12px" }}>
                      <strong>{selectedAttemptResult.results.percentage}%</strong>
                      <small>
                        {selectedAttemptResult.results.score} /{" "}
                        {selectedAttemptResult.results.total_marks} pts
                      </small>
                    </div>
                  </div>

                  <div className="results-stats-grid" style={{ marginBottom: 20 }}>
                    <div className="results-stat-box">
                      <strong>{selectedAttemptResult.results.correct}</strong>
                      <span>Correct</span>
                    </div>
                    <div className="results-stat-box">
                      <strong>{selectedAttemptResult.results.incorrect}</strong>
                      <span>Incorrect</span>
                    </div>
                    <div className="results-stat-box">
                      <strong>{selectedAttemptResult.results.answered}</strong>
                      <span>Answered</span>
                    </div>
                    <div className="results-stat-box">
                      <strong>{selectedAttemptResult.results.unanswered}</strong>
                      <span>Unanswered</span>
                    </div>
                  </div>

                  {/* Topic breakdown */}
                  {selectedAttemptResult.results.topic_performance?.length > 0 && (
                    <div style={{ margin: "20px 0", padding: 16, background: "#f8f7fc", borderRadius: 12 }}>
                      <strong style={{ display: "block", marginBottom: 10, color: "#32294f" }}>
                        Topic Competency Breakdown
                      </strong>
                      {selectedAttemptResult.results.topic_performance.map((tp) => (
                        <div
                          key={tp.topic}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            margin: "6px 0",
                            fontSize: 13,
                          }}
                        >
                          <span>{tp.topic}</span>
                          <strong>
                            {tp.percentage}% ({tp.score}/{tp.total_marks})
                          </strong>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Question review */}
                  {selectedAttemptResult.results.review?.length > 0 && (
                    <div style={{ marginTop: 20 }}>
                      <strong style={{ display: "block", marginBottom: 10, color: "#32294f" }}>
                        Question Review & Correct Keys
                      </strong>
                      <table className="review-table">
                        <thead>
                          <tr>
                            <th scope="col">#</th>
                            <th scope="col">Your Answer</th>
                            <th scope="col">Official Key</th>
                            <th scope="col">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedAttemptResult.results.review.map((item) => (
                            <tr key={item.q_number}>
                              <td>{item.q_number}</td>
                              <td>{item.recorded_answer ? formatMathDisplay(item.recorded_answer) : "None"}</td>
                              <td>{item.correct_answer ? formatMathDisplay(item.correct_answer) : "—"}</td>
                              <td>
                                <span
                                  className={`status-tag ${
                                    item.status === "correct" ? "answered" : "unanswered"
                                  }`}
                                >
                                  {item.status}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              ) : (
                <div className="empty-card compact">
                  Results data is not available for this session.
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="primary-button"
                onClick={() => setSelectedAttemptResult(null)}
              >
                Close Results
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

/* ============================================================
   EXAMINATION SCREEN: 100% HANDS-FREE AUTOMATIC VOICE LOOP (REQ 8)
============================================================ */

function ExamScreen({
  user,
  exam,
  existingSession,
  onSessionChange,
  onGoReview,
  onExit,
  onResults,
}) {
  const [payload, setPayload] = useState(existingSession);
  const [remaining, setRemaining] = useState(
    existingSession?.session?.time_remaining_seconds || 5400
  );
  const [typedAnswer, setTypedAnswer] = useState("");
  const [loading, setLoading] = useState(!existingSession);
  const [error, setError] = useState("");

  // Hands-free voice state machine: LISTENING | PROCESSING | SPEAKING | PAUSED | MICROPHONE UNAVAILABLE
  const [handsFree, setHandsFree] = useState(true);
  const [voiceStatus, setVoiceStatus] = useState("PAUSED");
  const [transcript, setTranscript] = useState("");
  const [pendingSubmit, setPendingSubmit] = useState(false);
  const [autoSubmitted, setAutoSubmitted] = useState(false);

  const recognitionRef = useRef(null);
  const restartTimerRef = useRef(null);
  const restartDelayRef = useRef(400);
  const mountedRef = useRef(true);
  const isProcessingRef = useRef(false);
  const handsFreeRef = useRef(handsFree);
  const sessionSubmittedRef = useRef(Boolean(payload?.session?.is_submitted));
  const startListeningLoopRef = useRef(null);
  const sessionId = payload?.session?.session_id;

  // Process and apply incoming backend telemetry
  const applyTelemetry = useCallback(
    (data, { announce = true } = {}) => {
      setPayload(data);
      onSessionChange?.(data);
      sessionSubmittedRef.current = Boolean(data.session?.is_submitted);

      if (data.session?.time_remaining_seconds != null) {
        setRemaining(data.session.time_remaining_seconds);
      }

      setPendingSubmit(Boolean(data.session?.pending_submit_confirmation));

      if (data.response?.recorded_answer) {
        setTypedAnswer(data.response.recorded_answer);
      } else {
        setTypedAnswer("");
      }

      // Check for review or submit events from backend intent parser
      if (data.event === "review_exam") {
        if (announce && data.speak) {
          speak(data.speak);
        }
        onGoReview();
        return;
      }

      if (data.event === "exam_submitted") {
        if (announce && data.speak) {
          speak(data.speak);
        }
        onResults(data.results || data);
        return;
      }

      if (announce && data.speak) {
        setVoiceStatus("SPEAKING");
        speak(data.speak);
      }
    },
    [onGoReview, onResults, onSessionChange]
  );

  // Core natural voice transmitter -> POST /api/session/{sessionId}/transcript
  const handleVoiceTranscript = useCallback(
    async (text) => {
      if (!sessionId || !text.trim()) return;
      setTranscript(text);

      try {
        const data = await api.sendTranscript(sessionId, text.trim());
        applyTelemetry(data);
      } catch (err) {
        setError(err.message);
        speak(`I couldn't process what you said. ${err.message}`);
      }
    },
    [sessionId, applyTelemetry]
  );

  const scheduleListeningRestart = useCallback((delay = 400) => {
    clearTimeout(restartTimerRef.current);
    if (
      !mountedRef.current ||
      !handsFreeRef.current ||
      sessionSubmittedRef.current
    ) {
      return;
    }

    restartTimerRef.current = setTimeout(() => {
      restartTimerRef.current = null;
      if (
        mountedRef.current &&
        handsFreeRef.current &&
        !sessionSubmittedRef.current &&
        !isSpeaking() &&
        !isProcessingRef.current
      ) {
        startListeningLoopRef.current?.();
      }
    }, delay);
  }, []);

  // Automatic Hands-Free Speech Recognition loop
  const startListeningLoop = useCallback(() => {
    if (
      !mountedRef.current ||
      !handsFreeRef.current ||
      sessionSubmittedRef.current ||
      recognitionRef.current ||
      isSpeaking() ||
      isProcessingRef.current
    ) {
      return;
    }

    const Recognition = getRecognition();
    if (!Recognition) {
      setVoiceStatus("MICROPHONE UNAVAILABLE");
      setError("Speech recognition is unavailable in this browser. Please use Chrome or Edge, or enter your answer manually.");
      handsFreeRef.current = false;
      setHandsFree(false);
      return;
    }

    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.lang = "en-IN";
    recognition.continuous = false; // single utterance per conversational turn
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      if (!mountedRef.current) return;
      restartDelayRef.current = 400;
      setVoiceStatus("LISTENING");
    };

    recognition.onresult = async (event) => {
      if (!mountedRef.current) return;
      const heard = event.results?.[0]?.[0]?.transcript || "";
      if (!heard.trim() || isProcessingRef.current) return;

      isProcessingRef.current = true;
      setVoiceStatus("PROCESSING");
      try {
        await handleVoiceTranscript(heard);
      } finally {
        isProcessingRef.current = false;
        scheduleListeningRestart(350);
      }
    };

    recognition.onerror = (e) => {
      if (!mountedRef.current) return;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setVoiceStatus("MICROPHONE UNAVAILABLE");
        setError("Microphone permission denied. Please allow microphone access.");
        handsFreeRef.current = false;
        setHandsFree(false);
        clearTimeout(restartTimerRef.current);
        return;
      }
      if (e.error === "audio-capture") {
        setVoiceStatus("MICROPHONE UNAVAILABLE");
        setError("No microphone was found. Check that one is connected and enabled.");
        handsFreeRef.current = false;
        setHandsFree(false);
        clearTimeout(restartTimerRef.current);
        return;
      }
      if (e.error === "aborted") {
        return;
      }
      if (e.error !== "no-speech") {
        const detail = e.error === "network"
          ? "Speech recognition could not connect. Check your internet connection."
          : `Speech recognition failed (${e.error}).`;
        setError(detail);
        restartDelayRef.current = Math.min(restartDelayRef.current * 2, 5000);
      }
    };

    recognition.onend = () => {
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
      }
      scheduleListeningRestart(restartDelayRef.current);
    };

    try {
      recognition.start();
    } catch (err) {
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
      }
      setError(`Unable to start microphone listening. ${err.message || "Please try again."}`);
      scheduleListeningRestart(1000);
    }
  }, [handleVoiceTranscript, scheduleListeningRestart]);
  startListeningLoopRef.current = startListeningLoop;

  // Listen to speech synthesis status changes to stop/resume microphone
  useEffect(() => {
    const unsubscribe = subscribeSpeech((speaking) => {
      if (!mountedRef.current) return;
      if (speaking) {
        setVoiceStatus("SPEAKING");
        clearTimeout(restartTimerRef.current);
        try {
          recognitionRef.current?.abort();
        } catch {}
      } else {
        if (handsFreeRef.current && !isProcessingRef.current) {
          scheduleListeningRestart(350);
        } else if (!handsFreeRef.current) {
          setVoiceStatus("PAUSED");
        }
      }
    });

    return () => unsubscribe();
  }, [scheduleListeningRestart]);

  useEffect(() => {
    if (
      !handsFree ||
      payload?.session?.is_submitted ||
      isSpeaking() ||
      isProcessingRef.current ||
      !["PAUSED", "SPEAKING"].includes(voiceStatus)
    ) {
      return undefined;
    }
    scheduleListeningRestart(350);
    return () => clearTimeout(restartTimerRef.current);
  }, [handsFree, payload?.session?.is_submitted, scheduleListeningRestart, voiceStatus]);

  // Initial load or session hydration
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    async function init() {
      if (!existingSession && exam?.id) {
        try {
          setLoading(true);
          const data = await api.startSession(exam.id);
          if (!cancelled) {
            applyTelemetry(data);
          }
        } catch (err) {
          if (!cancelled) setError(err.message);
        } finally {
          if (!cancelled) setLoading(false);
        }
      } else if (existingSession) {
        applyTelemetry(existingSession, { announce: true });
        setLoading(false);
      }
    }

    init();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      handsFreeRef.current = false;
      cancelSpeech();
      clearTimeout(restartTimerRef.current);
      try {
        recognitionRef.current?.abort();
      } catch {}
      recognitionRef.current = null;
    };
  }, [exam, existingSession, applyTelemetry]);

  // Local clock decrement & periodic server sync
  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining((prev) => Math.max(0, prev - 1));
    }, 1000);

    const sync = setInterval(async () => {
      if (sessionId) {
        try {
          const synced = await api.getSession(sessionId);
          applyTelemetry(synced, { announce: false });
        } catch {
          /* ignore periodic network hiccups */
        }
      }
    }, 25000);

    return () => {
      clearInterval(timer);
      clearInterval(sync);
    };
  }, [sessionId, applyTelemetry]);

  // Auto-submit when time expires
  useEffect(() => {
    if (remaining === 0 && sessionId && !autoSubmitted && !payload?.session?.is_submitted) {
      setAutoSubmitted(true);
      speak("Time has expired. Your examination is being submitted automatically.");
      api
        .confirmSubmit(sessionId)
        .then((data) => {
          applyTelemetry(data);
        })
        .catch((err) => setError(err.message));
    }
  }, [remaining, sessionId, autoSubmitted, payload, applyTelemetry]);

  // Toggle Hands-Free Microphone mode
  const toggleHandsFree = () => {
    if (handsFree) {
      handsFreeRef.current = false;
      setHandsFree(false);
      setVoiceStatus("PAUSED");
      clearTimeout(restartTimerRef.current);
      try {
        recognitionRef.current?.abort();
      } catch {}
      recognitionRef.current = null;
    } else {
      handsFreeRef.current = true;
      setError("");
      setVoiceStatus("PAUSED");
      setHandsFree(true);
    }
  };

  // Direct actions
  const selectOption = async (key) => {
    if (!sessionId) return;
    try {
      const data = await api.saveAnswer(sessionId, key);
      applyTelemetry(data);
    } catch (err) {
      setError(err.message);
    }
  };

  const saveManualAnswer = async () => {
    if (!sessionId || !typedAnswer.trim()) return;
    try {
      const data = await api.saveAnswer(sessionId, typedAnswer.trim(), typedAnswer.trim());
      applyTelemetry(data);
    } catch (err) {
      setError(err.message);
    }
  };

  const jumpToQuestion = async (qNumber) => {
    if (!sessionId) return;
    try {
      const data = await api.gotoQuestion(sessionId, qNumber);
      applyTelemetry(data);
    } catch (err) {
      setError(err.message);
    }
  };

  const requestSubmit = async () => {
    if (!sessionId) return;
    try {
      const data = await api.requestSubmit(sessionId);
      applyTelemetry(data);
    } catch (err) {
      setError(err.message);
    }
  };

  const confirmSubmit = async () => {
    if (!sessionId) return;
    try {
      const data = await api.confirmSubmit(sessionId);
      applyTelemetry(data);
    } catch (err) {
      setError(err.message);
    }
  };

  const cancelSubmit = async () => {
    if (!sessionId) return;
    try {
      const data = await api.cancelSubmit(sessionId);
      applyTelemetry(data);
    } catch (err) {
      setError(err.message);
    }
  };

  const currentQ = payload?.question;
  const sessionData = payload?.session;
  const questionNumbers = payload?.question_numbers || [];
  const unanswered = payload?.unanswered || [];
  const currentAnswer = payload?.response?.recorded_answer;

  const currentIndex = questionNumbers.indexOf(sessionData?.current_question || 1);
  const totalQuestions = questionNumbers.length || 1;

  if (loading) {
    return (
      <div className="fullscreen-loading" role="status" aria-live="polite">
        <div className="loader large" />
        <h2>Preparing your examination...</h2>
        <p>Connecting to session gateway.</p>
      </div>
    );
  }

  return (
    <div className="exam-screen">
      <header className="exam-header">
        <div className="exam-brand">
          <div className="sidebar-logo">AQ</div>
          <div>
            <strong>AdaptIQ</strong>
            <small>{payload?.exam?.title || exam?.title || "Examination"}</small>
          </div>
        </div>

        <div className="exam-header-center">
          <div className="exam-progress-label">
            Question {sessionData?.current_question || 1} of {totalQuestions}
          </div>
          <div className="progress-bar" role="progressbar" aria-valuenow={currentIndex + 1} aria-valuemin="1" aria-valuemax={totalQuestions}>
            <div
              style={{
                width: `${totalQuestions ? (((currentIndex >= 0 ? currentIndex : 0) + 1) / totalQuestions) * 100 : 0}%`,
              }}
            />
          </div>
        </div>

        <div className="exam-header-actions">
          <div className="timer-pill" aria-live="polite" aria-label={`Time remaining ${formatClock(remaining)}`}>
            ⏱ {formatClock(remaining)}
          </div>
          <button type="button" className="outline-button" onClick={onGoReview}>
            Review Paper
          </button>
          <button type="button" className="exit-button" onClick={onExit}>
            Exit
          </button>
        </div>
      </header>

      <div className="exam-body">
        {/* Question Navigator Sidebar */}
        <aside className="question-sidebar" aria-label="Question Navigator Palette">
          <div className="question-sidebar-title">EXAM PALETTE</div>
          <div className="question-grid">
            {questionNumbers.map((n) => {
              const isCurrent = n === sessionData?.current_question;
              const isAnswered = !unanswered.includes(n);
              const isMarked = sessionData?.marked_questions?.includes(n);

              return (
                <button
                  key={n}
                  type="button"
                  className={[
                    isCurrent ? "current" : "",
                    isAnswered ? "answered" : "",
                    isMarked ? "marked" : "",
                  ]
                    .join(" ")
                    .trim()}
                  onClick={() => jumpToQuestion(n)}
                  aria-label={`Question ${n}${isCurrent ? ", current question" : ""}${isAnswered ? ", answered" : ", unanswered"}${isMarked ? ", marked for review" : ""}`}
                >
                  {n}
                </button>
              );
            })}
          </div>

          <div className="question-legend" aria-hidden="true">
            <div>
              <span className="legend current" /> Current
            </div>
            <div>
              <span className="legend answered" /> Answered
            </div>
            <div>
              <span className="legend unanswered" /> Unanswered
            </div>
          </div>
        </aside>

        {/* Question and Interactive Voice Main Area */}
        <main className="question-main">
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}

          {/* Submission Confirmation Banner */}
          {pendingSubmit && (
            <div className="confirmation-banner" role="alertdialog" aria-modal="true">
              <strong>Submit your examination now?</strong>
              <span>
                You have answered {totalQuestions - unanswered.length} of {totalQuestions} questions.
                {unanswered.length > 0 && ` (${unanswered.length} unanswered).`}
                {" "}Say “yes” to submit or “no” to continue.
              </span>
              <div>
                <button type="button" className="primary-button" onClick={confirmSubmit}>
                  Yes, Submit Exam
                </button>
                <button type="button" className="outline-button" onClick={cancelSubmit}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="question-number">
            QUESTION {currentQ?.q_number || sessionData?.current_question || 1}
          </div>

          <div className="question-card">
            <div className="question-type">
              {currentQ?.type || "Question"} • {currentQ?.marks || 1} mark{(currentQ?.marks || 1) === 1 ? "" : "s"}
              {currentQ?.topic ? ` • ${currentQ.topic}` : ""}
            </div>

            <h1>{currentQ?.prompt || "Loading question..."}</h1>

            {/* MCQ Options */}
            {currentQ?.options && currentQ.options.length > 0 ? (
              <div className="answer-options" role="radiogroup" aria-label="Multiple choice options">
                {currentQ.options.map((opt) => {
                  const isSelected =
                    String(currentAnswer).toUpperCase() === String(opt.key).toUpperCase();
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      role="radio"
                      className={isSelected ? "selected" : ""}
                      onClick={() => selectOption(opt.key)}
                      aria-checked={isSelected}
                      aria-label={`Option ${opt.key}: ${opt.text}`}
                    >
                      <span>{opt.key}</span>
                      {opt.text}
                    </button>
                  );
                })}
              </div>
            ) : (
              /* Non-MCQ Spoken / Manual Input Area */
              <div style={{ marginTop: 18 }}>
                <div className="spoken-answer-box">
                  <div className="spoken-answer-icon" aria-hidden="true">🎙</div>
                  <div>
                    <strong>Voice or Text Submission</strong>
                    <p>
                      Speak your numerical, mathematical, or descriptive answer, or enter it below.
                    </p>
                  </div>
                </div>

                {/* Math steps preview if available */}
                {payload?.response?.math_steps_json?.length > 0 && (
                  <div style={{ margin: "14px 0", padding: "12px", background: "#f8f6fd", borderRadius: 12 }}>
                    <small style={{ color: "#6c5ce7", fontWeight: 700 }}>Recorded Math Steps:</small>
                    <ol style={{ margin: "6px 0 0 18px", padding: 0 }}>
                      {payload.response.math_steps_json.map((step, idx) => (
                        <li key={idx} style={{ margin: "4px 0", fontSize: 13 }}>
                          Step {idx + 1}: <code>{formatMathDisplay(step.latex || step.spoken)}</code>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                  <input
                    type="text"
                    value={typedAnswer}
                    placeholder="Type or dictate your answer..."
                    onChange={(e) => setTypedAnswer(e.target.value)}
                    style={{ flex: 1, padding: "12px", borderRadius: 10, border: "1px solid #dcd6e8" }}
                    aria-label="Answer input field"
                  />
                  <button type="button" className="primary-button" onClick={saveManualAnswer}>
                    Save Answer
                  </button>
                </div>
              </div>
            )}

            <div className="current-answer">
              <span>Recorded Answer:</span>
              <strong>{currentAnswer ? formatMathDisplay(currentAnswer) : "Not answered yet"}</strong>
            </div>
          </div>

          {/* Voice Orb Interaction Area with Status Indicators */}
          <div className="voice-control-area">
            {/* Status badge: LISTENING | PROCESSING | SPEAKING | PAUSED | MICROPHONE UNAVAILABLE */}
            <div>
              <div
                className={`voice-status-pill status-${voiceStatus.toLowerCase().replace(/\s+/g, "-")}`}
                role="status"
                aria-live="polite"
              >
                <span className="voice-status-dot" aria-hidden="true" />
                {voiceStatus}
              </div>
            </div>

            <div
              className={`voice-orb ${voiceStatus === "LISTENING" ? "active" : ""}`}
              onClick={toggleHandsFree}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") toggleHandsFree();
              }}
              title={handsFree ? "Click to pause hands-free voice loop" : "Click to resume hands-free voice loop"}
              aria-label={`Microphone status: ${voiceStatus}. Click to toggle hands-free voice mode.`}
            >
              <div className="voice-orb-inner">
                <span aria-hidden="true">🎙</span>
              </div>
            </div>

            <h2>
              {voiceStatus === "LISTENING"
                ? "Listening for your voice..."
                : voiceStatus === "PROCESSING"
                ? "Processing your answer..."
                : voiceStatus === "SPEAKING"
                ? "AdaptIQ is speaking..."
                : voiceStatus === "PAUSED"
                ? "Voice Interaction Paused"
                : "Microphone Unavailable"}
            </h2>
            <p>
              {handsFree
                ? "Hands-free mode is active. The microphone listens again after each spoken response. Speak naturally; you do not need to use exact commands."
                : voiceStatus === "MICROPHONE UNAVAILABLE"
                  ? "Microphone access is unavailable. Allow microphone access or use a supported browser, then click to try again."
                  : "Microphone is paused. Click the microphone button to resume hands-free mode."}
            </p>

            {transcript && <div className="transcript" aria-live="polite">“{transcript}”</div>}

            <button
              type="button"
              className={`primary-button voice-button ${handsFree ? "" : "outline-button"}`}
              onClick={toggleHandsFree}
            >
              {handsFree ? "Pause Hands-Free Voice" : "Resume Hands-Free Voice"}
            </button>
          </div>

          <div className="voice-examples">
            <strong>For example, you can say:</strong>
            <div>
              <span>“I think the answer is option C”</span>
              <span>“Could we move on to the next question?”</span>
              <span>“Can you repeat that question?”</span>
              <span>“I would like to go back one question”</span>
              <span>“My answer is seven times eight minus six”</span>
              <span>“How much time do I have left?”</span>
              <span>“I am ready to hand in my exam”</span>
            </div>
          </div>

          {/* Bottom Exam Navigation */}
          <div className="exam-navigation">
            <button
              type="button"
              className="outline-button"
              disabled={currentIndex <= 0}
              onClick={() => {
                const prev = questionNumbers[currentIndex - 1];
                if (prev) jumpToQuestion(prev);
              }}
            >
              ← Previous
            </button>

            <button
              type="button"
              className="outline-button"
              onClick={() => {
                const text = currentQ ? `Question ${currentQ.q_number}. ${currentQ.prompt}` : "";
                if (text) {
                  setVoiceStatus("SPEAKING");
                  speak(text);
                }
              }}
            >
              🔊 Read Question
            </button>

            <button
              type="button"
              className="outline-button"
              onClick={async () => {
                if (sessionId) {
                  const data = await api.clearAnswer(sessionId);
                  applyTelemetry(data);
                }
              }}
            >
              Clear Answer
            </button>

            <button type="button" className="outline-button" onClick={onGoReview}>
              Review Exam
            </button>

            {currentIndex < totalQuestions - 1 ? (
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  const next = questionNumbers[currentIndex + 1];
                  if (next) jumpToQuestion(next);
                }}
              >
                Next →
              </button>
            ) : (
              <button type="button" className="primary-button" onClick={onGoReview}>
                Review & Submit →
              </button>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

/* ============================================================
   STUDENT FLOW: REVIEW SCREEN
============================================================ */

function ReviewScreen({
  user,
  session,
  onSessionChange,
  onReturnToExam,
  onResults,
}) {
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pendingSubmit, setPendingSubmit] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");

  const recognitionRef = useRef(null);
  const sessionId = session?.session?.session_id || session?.session_id;
  const examId = session?.session?.exam_id || session?.exam_id;

  const loadReviewData = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError("");

    try {
      const [sessionData, examData, respData] = await Promise.all([
        api.getSession(sessionId),
        api.getExam(examId),
        api.getResponses(sessionId),
      ]);

      onSessionChange?.(sessionData);

      const qs = examData.questions || [];
      setQuestions(qs);

      const ansMap = {};
      for (const r of respData.responses || []) {
        ansMap[r.question_number] = r.recorded_answer || "";
      }
      setAnswers(ansMap);

      const unansweredList = sessionData.unanswered || [];
      const total = qs.length;
      const answeredCount = total - unansweredList.length;

      const reviewSpeech = `Review mode. You have answered ${answeredCount} of ${total} questions. ${
        unansweredList.length > 0
          ? `${unansweredList.length} questions are unanswered: questions ${unansweredList.join(", ")}.`
          : "All questions have been answered."
      } You can ask me to return to any question, or tell me naturally when you are ready to hand in your exam.`;

      speak(reviewSpeech);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [sessionId, examId, onSessionChange]);

  useEffect(() => {
    loadReviewData();
    return () => {
      cancelSpeech();
      try {
        recognitionRef.current?.abort();
      } catch {}
    };
  }, [loadReviewData]);

  // Interpret natural speech while the student reviews answers.
  const handleReviewVoice = async (text) => {
    if (!sessionId || !text.trim()) return;
    setTranscript(text);

    try {
      const data = await api.sendTranscript(sessionId, text.trim());
      onSessionChange?.(data);

      if (data.event === "navigated" || data.event === "repeat_prompt") {
        speak(data.speak || "Returning to question.");
        onReturnToExam();
        return;
      }

      if (data.event === "submit_confirmation_required") {
        setPendingSubmit(true);
        speak(data.speak || "Say yes to submit or no to continue.");
        return;
      }

      if (data.event === "submit_cancelled") {
        setPendingSubmit(false);
        speak(data.speak || "Submission cancelled.");
        return;
      }

      if (data.event === "exam_submitted") {
        speak(data.speak || "Examination submitted successfully.");
        onResults(data.results || data);
        return;
      }

      if (data.speak) speak(data.speak);
    } catch (err) {
      setError(err.message);
    }
  };

  const startVoice = () => {
    const Recognition = getRecognition();
    if (!Recognition) return;

    if (listening) {
      recognitionRef.current?.abort();
      setListening(false);
      return;
    }

    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.lang = "en-IN";
    recognition.continuous = false;

    recognition.onstart = () => {
      setListening(true);
    };

    recognition.onresult = async (event) => {
      const heard = event.results?.[0]?.[0]?.transcript || "";
      await handleReviewVoice(heard);
    };

    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);

    cancelSpeech();
    try {
      recognition.start();
    } catch {
      setListening(false);
    }
  };

  const jumpToQuestion = async (qNumber) => {
    if (!sessionId) return;
    try {
      const data = await api.gotoQuestion(sessionId, qNumber);
      onSessionChange?.(data);
      onReturnToExam();
    } catch (err) {
      setError(err.message);
    }
  };

  const requestSubmit = async () => {
    if (!sessionId) return;
    try {
      const data = await api.requestSubmit(sessionId);
      onSessionChange?.(data);
      setPendingSubmit(true);
      if (data.speak) speak(data.speak);
    } catch (err) {
      setError(err.message);
    }
  };

  const confirmSubmit = async () => {
    if (!sessionId) return;
    try {
      const data = await api.confirmSubmit(sessionId);
      onSessionChange?.(data);
      if (data.speak) speak(data.speak);
      onResults(data.results || data);
    } catch (err) {
      setError(err.message);
    }
  };

  const cancelSubmitAction = async () => {
    if (!sessionId) return;
    try {
      const data = await api.cancelSubmit(sessionId);
      onSessionChange?.(data);
      setPendingSubmit(false);
      if (data.speak) speak(data.speak);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="review-screen">
      <div className="review-header">
        <div className="eyebrow">EXAMINATION SUMMARY</div>
        <h1>Review Your Responses</h1>
        <p>
          Examine your recorded answers before final submission. Click or speak
          any question number to return and make changes.
        </p>
      </div>

      {error && <div className="error-box" role="alert">{error}</div>}

      {pendingSubmit && (
        <div className="confirmation-banner" role="alertdialog" aria-modal="true">
          <strong>Confirm Examination Submission</strong>
          <span>
            Are you sure you want to finalize your exam? Once submitted, no
            further modifications can be made. Say “yes” to submit, or “no” to cancel.
          </span>
          <div>
            <button type="button" className="primary-button" onClick={confirmSubmit}>
              Yes, Finalize & Submit
            </button>
            <button type="button" className="outline-button" onClick={cancelSubmitAction}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="review-table-card">
        {loading ? (
          <div className="loading-card" role="status" aria-live="polite">
            <div className="loader" /> Loading summary...
          </div>
        ) : (
          <table className="review-table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Question</th>
                <th scope="col">Type</th>
                <th scope="col">Your Answer</th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {questions.map((q) => {
                const ans = answers[q.q_number];
                const isAnswered = Boolean(ans);

                return (
                  <tr key={q.q_number}>
                    <td>
                      <strong>{q.q_number}</strong>
                    </td>
                    <td style={{ maxWidth: 380 }}>{q.prompt}</td>
                    <td>{q.type}</td>
                    <td>
                      <strong>{ans ? formatMathDisplay(ans) : "—"}</strong>
                    </td>
                    <td>
                      <span className={`status-tag ${isAnswered ? "answered" : "unanswered"}`}>
                        {isAnswered ? "● Answered" : "○ Unanswered"}
                      </span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="outline-button"
                        style={{ padding: "6px 14px", fontSize: 13 }}
                        onClick={() => jumpToQuestion(q.q_number)}
                        aria-label={`Edit question ${q.q_number}`}
                      >
                        Edit →
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16 }}>
        <button type="button" className="outline-button" onClick={onReturnToExam}>
          ← Return to Exam
        </button>

        <button
          type="button"
          className={`outline-button ${listening ? "active" : ""}`}
          onClick={startVoice}
          aria-label="Speak naturally while reviewing the exam"
        >
          <span aria-hidden="true">🎙</span> {listening ? "Listening..." : "Talk to AdaptIQ"}
        </button>

        <button type="button" className="primary-button" onClick={requestSubmit}>
          Finalize & Submit Exam →
        </button>
      </div>

      {transcript && (
        <div className="transcript" style={{ marginTop: 16 }} aria-live="polite">
          Heard: “{transcript}”
        </div>
      )}
    </div>
  );
}

/* ============================================================
   STUDENT FLOW: RESULTS SCREEN
============================================================ */

function ResultsScreen({ user, session, results, onDashboard }) {
  const [data, setData] = useState(results || null);
  const [loading, setLoading] = useState(!results);
  const [error, setError] = useState("");

  const sessionId = session?.session?.session_id || session?.session_id;

  useEffect(() => {
    if (results) {
      setData(results);
      const scoreMsg = `Well done! Your examination has been submitted. Score is ${results.score} out of ${results.total_marks}, ${results.percentage} percent.`;
      speak(scoreMsg);
      setLoading(false);
      return;
    }

    if (sessionId) {
      api
        .getResults(sessionId)
        .then((res) => {
          setData(res.results);
          const scoreMsg = `Well done! Your examination has been submitted. Score is ${res.results.score} out of ${res.results.total_marks}, ${res.results.percentage} percent.`;
          speak(scoreMsg);
        })
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false));
    }
  }, [results, sessionId]);

  const score = data?.score ?? 0;
  const totalMarks = data?.total_marks ?? 0;
  const percentage = data?.percentage ?? 0;

  return (
    <div className="results-page">
      <div className="results-card" style={{ maxWidth: 700 }}>
        <div className="result-success-icon" aria-hidden="true">✓</div>
        <div className="eyebrow">EXAMINATION COMPLETED</div>
        <h1>Official Examination Result</h1>
        <p>
          {data?.exam_title || "Examination"} • Submitted by {user?.display_name || "Student"}
        </p>

        {error && <div className="error-box" role="alert">{error}</div>}

        {loading ? (
          <div className="loading-card" role="status" aria-live="polite">
            <div className="loader" /> Calculating official score...
          </div>
        ) : (
          <>
            <div className="score-circle">
              <strong>{percentage}%</strong>
              <small>
                {score} / {totalMarks} pts
              </small>
            </div>

            <div className="results-stats-grid">
              <div className="results-stat-box">
                <strong>{data?.correct ?? 0}</strong>
                <span>Correct</span>
              </div>
              <div className="results-stat-box">
                <strong>{data?.incorrect ?? 0}</strong>
                <span>Incorrect</span>
              </div>
              <div className="results-stat-box">
                <strong>{data?.answered ?? 0}</strong>
                <span>Answered</span>
              </div>
              <div className="results-stat-box">
                <strong>{data?.unanswered ?? 0}</strong>
                <span>Unanswered</span>
              </div>
            </div>

            {/* Topic performance breakdown if available */}
            {data?.topic_performance && data.topic_performance.length > 0 && (
              <div style={{ textAlign: "left", margin: "24px 0", background: "#fdfcfe", border: "1px solid #ebe8f2", borderRadius: 14, padding: 18 }}>
                <strong style={{ display: "block", marginBottom: 12, color: "#32294f", fontSize: 14 }}>
                  Topic Competency Breakdown
                </strong>
                {data.topic_performance.map((tp) => (
                  <div key={tp.topic} style={{ display: "flex", justifyContent: "space-between", margin: "8px 0", fontSize: 13 }}>
                    <span>{tp.topic}</span>
                    <strong>
                      {tp.percentage}% ({tp.score}/{tp.total_marks})
                    </strong>
                  </div>
                ))}
              </div>
            )}

            {/* Detailed question review if provided */}
            {data?.review && data.review.length > 0 && (
              <div style={{ textAlign: "left", margin: "20px 0" }}>
                <strong style={{ display: "block", marginBottom: 10, color: "#32294f", fontSize: 14 }}>
                  Question-by-Question Review
                </strong>
                <table className="review-table">
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Your Answer</th>
                      <th scope="col">Correct Key</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.review.map((item) => (
                      <tr key={item.q_number}>
                        <td>{item.q_number}</td>
                        <td>{item.recorded_answer ? formatMathDisplay(item.recorded_answer) : "None"}</td>
                        <td>{item.correct_answer ? formatMathDisplay(item.correct_answer) : "—"}</td>
                        <td>
                          <span className={`status-tag ${item.status === "correct" ? "correct" : "incorrect"}`}>
                            {item.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="result-actions">
              <button type="button" className="primary-button" onClick={onDashboard}>
                Return to Dashboard
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   ADMINISTRATION DASHBOARD (REQS 20 & 21)
============================================================ */

function AdminDashboard({ user, onLogout }) {
  const [exams, setExams] = useState([]);
  const [stats, setStats] = useState(null);
  const [attempts, setAttempts] = useState([]);
  const [selectedExamId, setSelectedExamId] = useState(null);
  const [selectedExamData, setSelectedExamData] = useState(null);
  const [activeTab, setActiveTab] = useState("exams");
  const [studentName, setStudentName] = useState("");
  const [studentUsername, setStudentUsername] = useState("");
  const [studentRegistrationNumber, setStudentRegistrationNumber] = useState("");
  const [studentPassword, setStudentPassword] = useState("");

  // Modals state
  const [editingExam, setEditingExam] = useState(null);
  const [showAddQuestion, setShowAddQuestion] = useState(false);
  const [inspectAttempt, setInspectAttempt] = useState(null);

  // New question form state
  const [newQNum, setNewQNum] = useState(1);
  const [newQType, setNewQType] = useState("MCQ");
  const [newQPrompt, setNewQPrompt] = useState("");
  const [newQAudio, setNewQAudio] = useState("");
  const [newQMarks, setNewQMarks] = useState(1);
  const [newQTopic, setNewQTopic] = useState("");
  const [newQDiff, setNewQDiff] = useState("medium");
  const [newQKey, setNewQKey] = useState("");
  const [newQOptA, setNewQOptA] = useState("");
  const [newQOptB, setNewQOptB] = useState("");
  const [newQOptC, setNewQOptC] = useState("");
  const [newQOptD, setNewQOptD] = useState("");
  const [newQVerified, setNewQVerified] = useState(true);

  // Exam creation form state
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("Mathematics");
  const [description, setDescription] = useState("");
  const [duration, setDuration] = useState(60);

  // Scanned paper state
  const [file, setFile] = useState(null);
  const [uploadResult, setUploadResult] = useState(null);
  const [targetExamForImport, setTargetExamForImport] = useState("");

  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [statsData, examsData, attemptsData] = await Promise.all([
        api.adminStats(),
        api.adminExams(),
        api.adminAttempts(),
      ]);

      setStats(statsData);
      const examList = examsData.exams || [];
      setExams(examList);
      setAttempts(attemptsData.attempts || []);

      if (examList.length > 0 && !targetExamForImport) {
        setTargetExamForImport(examList[0].id);
      }
    } catch (err) {
      setError(err.message || "Failed to load administration dataset.");
    } finally {
      setLoading(false);
    }
  }, [targetExamForImport]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Load specific exam questions for verification
  const loadExamDetails = async (examId) => {
    if (!examId) return;
    try {
      const res = await api.adminExam(examId);
      setSelectedExamId(examId);
      setSelectedExamData(res);
      // Auto-suggest next question number
      const maxNum = (res.questions || []).reduce(
        (m, q) => Math.max(m, q.q_number || 0),
        0
      );
      setNewQNum(maxNum + 1);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleCreate = async () => {
    if (!title.trim()) {
      setError("Exam title is required.");
      return;
    }

    setBusy(true);
    setError("");
    setMessage("");

    try {
      const created = await api.createExam({
        title: title.trim(),
        subject: subject.trim() || "General",
        description: description.trim(),
        duration_minutes: Number(duration),
      });

      setTitle("");
      setDescription("");
      setDuration(60);
      setMessage("Examination created successfully in draft status.");
      speak("Examination created successfully.");
      await loadData();
      if (created.exam?.id) {
        setTargetExamForImport(created.exam.id);
        await loadExamDetails(created.exam.id);
        setActiveTab("exams");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateExam = async () => {
    if (!editingExam) return;
    setBusy(true);
    setError("");
    setMessage("");

    try {
      await api.updateExam(editingExam.id, {
        title: editingExam.title?.trim(),
        subject: editingExam.subject?.trim(),
        duration_minutes: Number(editingExam.duration_minutes),
        description: editingExam.description?.trim(),
      });

      setMessage("Examination details updated successfully.");
      speak("Examination updated successfully.");
      setEditingExam(null);
      await loadData();
      if (selectedExamId === editingExam.id) {
        await loadExamDetails(editingExam.id);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteExam = async (examId) => {
    if (!window.confirm("Are you sure you want to permanently delete this examination?")) {
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");

    try {
      await api.deleteExam(examId);
      setMessage("Examination deleted successfully.");
      speak("Examination deleted.");
      if (selectedExamId === examId) {
        setSelectedExamId(null);
        setSelectedExamData(null);
      }
      await loadData();
    } catch (err) {
      setError(err.message);
      speak(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async () => {
    if (!file) {
      setError("Please select a PDF question paper to scan.");
      return;
    }

    setBusy(true);
    setError("");
    setMessage("");

    try {
      const result = await api.uploadPaper(file);
      setUploadResult(result);
      if (result.is_scanned_image) {
        setMessage(
          "Document uploaded. Note: No embedded digital text layer was found in this PDF scan. An OCR text layer is required for automatic question recognition."
        );
      } else {
        setMessage(
          `Question paper processed successfully. ${result.line_count || 0} lines and ${
            result.extracted_questions?.length || 0
          } questions extracted. Choose destination exam below to import.`
        );
        speak("Question paper processed successfully.");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleImportExtracted = async () => {
    if (!targetExamForImport) {
      setError("Please select a destination examination.");
      return;
    }
    if (!uploadResult?.extracted_questions?.length) {
      setError("No extracted questions available to import.");
      return;
    }

    setBusy(true);
    setError("");
    setMessage("");

    try {
      await api.importQuestions(targetExamForImport, uploadResult.extracted_questions);
      setMessage(
        `Imported ${uploadResult.extracted_questions.length} questions into exam. Please review and verify questions below.`
      );
      speak("Questions imported successfully. Verification required before publishing.");
      setUploadResult(null);
      setFile(null);
      await loadData();
      await loadExamDetails(targetExamForImport);
      setActiveTab("exams");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleAddQuestionSubmit = async () => {
    if (!selectedExamId) return;
    if (!newQPrompt.trim()) {
      setError("Question prompt cannot be empty.");
      return;
    }

    setBusy(true);
    setError("");
    setMessage("");

    try {
      const options =
        newQType === "MCQ"
          ? [
              { key: "A", text: newQOptA.trim() },
              { key: "B", text: newQOptB.trim() },
              { key: "C", text: newQOptC.trim() },
              { key: "D", text: newQOptD.trim() },
            ].filter((o) => o.text)
          : [];

      const payload = {
        q_number: Number(newQNum),
        type: newQType,
        prompt: newQPrompt.trim(),
        audio_text:
          newQAudio.trim() ||
          `Question ${newQNum}. ${newQType.toLowerCase()}. ${newQPrompt.trim()}`,
        marks: Number(newQMarks) || 1,
        topic: newQTopic.trim(),
        difficulty: newQDiff,
        options,
        correct_answer: newQKey.trim() || null,
        verified: Boolean(newQVerified),
      };

      await api.upsertQuestion(selectedExamId, payload);
      setMessage(`Question ${newQNum} saved successfully.`);
      speak("Question saved.");
      setShowAddQuestion(false);

      // Reset form fields
      setNewQPrompt("");
      setNewQAudio("");
      setNewQKey("");
      setNewQOptA("");
      setNewQOptB("");
      setNewQOptC("");
      setNewQOptD("");

      await loadExamDetails(selectedExamId);
      await loadData();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteQuestion = async (questionId) => {
    if (!window.confirm("Are you sure you want to delete this question?")) return;
    setError("");
    setMessage("");
    try {
      await api.deleteQuestion(questionId);
      setMessage("Question deleted.");
      speak("Question deleted.");
      if (selectedExamId) {
        await loadExamDetails(selectedExamId);
      }
      await loadData();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleVerifyQuestion = async (questionId, verified) => {
    setError("");
    setMessage("");
    try {
      await api.verifyQuestion(questionId, verified);
      if (selectedExamId) {
        await loadExamDetails(selectedExamId);
      }
      await loadData();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleVerifyAll = async (examId) => {
    if (!examId || !selectedExamData?.questions) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      for (const q of selectedExamData.questions) {
        if (!q.verified) {
          await api.verifyQuestion(q.id, true);
        }
      }
      setMessage("All questions in this exam are verified.");
      speak("All questions have been verified.");
      await loadExamDetails(examId);
      await loadData();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handlePublish = async (examId) => {
    setError("");
    setMessage("");
    try {
      await api.publishExam(examId);
      setMessage("Examination published successfully. It is now visible to students.");
      speak("Examination published successfully.");
      await loadData();
      if (selectedExamId === examId) {
        await loadExamDetails(examId);
      }
    } catch (err) {
      setError(err.message);
      speak(err.message);
    }
  };

  const handleUnpublish = async (examId) => {
    setError("");
    setMessage("");
    try {
      await api.unpublishExam(examId);
      setMessage("Examination reverted to draft mode.");
      speak("Examination reverted to draft mode.");
      await loadData();
      if (selectedExamId === examId) {
        await loadExamDetails(examId);
      }
    } catch (err) {
      setError(err.message);
      speak(err.message);
    }
  };

  const handleCreateStudent = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const created = await api.registerStudent({
        name: studentName.trim(),
        username: studentUsername.trim(),
        registration_number: studentRegistrationNumber.trim(),
        password: studentPassword,
      });
      setMessage(
        `Student account created for ${created.student.name} (@${created.user.username}; ID ${created.student.registration_number}).`
      );
      setStudentName("");
      setStudentUsername("");
      setStudentRegistrationNumber("");
      setStudentPassword("");
      speak("Student account created successfully.");
    } catch (err) {
      setError(err.message || "Could not create student account.");
      speak(err.message || "Could not create student account.");
    } finally {
      setBusy(false);
    }
  };

  const navItems = [
    { id: "exams", label: "Manage Exams & Questions", icon: "📚", badge: exams.length },
    { id: "create", label: "Create Examination", icon: "➕" },
    { id: "students", label: "Create Student Account", icon: "👤" },
    { id: "paper", label: "Scanned Paper (PDF)", icon: "📄" },
    { id: "attempts", label: "Student Attempts", icon: "👥", badge: attempts.length },
    { id: "activity", label: "Recent Activity Feed", icon: "📈" },
  ];

  return (
    <AppShell
      user={user}
      active={activeTab}
      navItems={navItems}
      onNavigate={setActiveTab}
      onLogout={onLogout}
    >
      <div className="page-header">
        <div>
          <div className="eyebrow">ADMINISTRATION CONTROL PANEL</div>
          <h1 style={{ margin: "6px 0 10px" }}>
            Examination Management System
          </h1>
          <p style={{ color: "#635c75", margin: 0 }}>
            Author, verify, scan, monitor, and publish voice-accessible examinations.
          </p>
        </div>

      </div>

      {/* Real Statistics Grid from Backend */}
      {stats && (
        <div className="metrics-summary-grid">
          <div className="metric-stat-card">
            <div className="metric-stat-num">{stats.total_exams ?? 0}</div>
            <div className="metric-stat-lbl">Total Exams</div>
          </div>
          <div className="metric-stat-card">
            <div className="metric-stat-num" style={{ color: "#16a34a" }}>
              {stats.published_exams ?? 0}
            </div>
            <div className="metric-stat-lbl">Published & Active</div>
          </div>
          <div className="metric-stat-card">
            <div className="metric-stat-num" style={{ color: "#d97706" }}>
              {stats.draft_exams ?? 0}
            </div>
            <div className="metric-stat-lbl">Draft Exams</div>
          </div>
          <div className="metric-stat-card">
            <div className="metric-stat-num">{stats.student_attempts ?? 0}</div>
            <div className="metric-stat-lbl">Student Sessions</div>
          </div>
          <div className="metric-stat-card">
            <div className="metric-stat-num" style={{ color: "#2563eb" }}>
              {stats.submitted_attempts ?? 0}
            </div>
            <div className="metric-stat-lbl">Completed Submissions</div>
          </div>
        </div>
      )}

      {error && <div className="error-box" role="alert">{error}</div>}
      {message && <div className="success-box" role="status">✓ {message}</div>}

      {/* Subnavigation Tabs */}
      <div className="subnav-tabs" role="tablist" aria-label="Admin Navigation Tabs">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "exams"}
          className={`subnav-btn ${activeTab === "exams" ? "active" : ""}`}
          onClick={() => setActiveTab("exams")}
        >
          📚 Exams & Questions ({exams.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "create"}
          className={`subnav-btn ${activeTab === "create" ? "active" : ""}`}
          onClick={() => setActiveTab("create")}
        >
          ➕ Create New Exam
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "students"}
          className={`subnav-btn ${activeTab === "students" ? "active" : ""}`}
          onClick={() => setActiveTab("students")}
        >
          👤 Create Student Account
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "paper"}
          className={`subnav-btn ${activeTab === "paper" ? "active" : ""}`}
          onClick={() => setActiveTab("paper")}
        >
          📄 Scanned Paper (PDF Extractor)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "attempts"}
          className={`subnav-btn ${activeTab === "attempts" ? "active" : ""}`}
          onClick={() => setActiveTab("attempts")}
        >
          👥 Student Attempts ({attempts.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "activity"}
          className={`subnav-btn ${activeTab === "activity" ? "active" : ""}`}
          onClick={() => setActiveTab("activity")}
        >
          📈 Activity Feed
        </button>
      </div>

      {activeTab === "students" && (
        <section className="dashboard-card" style={{ maxWidth: 760 }} aria-label="Create student account">
          <div className="section-heading">
            <div>
              <h2 style={{ margin: 0 }}>Create student account</h2>
              <p style={{ color: "#635c75", margin: "4px 0 0" }}>
                Admins create student usernames, registration IDs, and initial passwords.
              </p>
            </div>
          </div>
          <form className="login-form" onSubmit={handleCreateStudent}>
            <label htmlFor="student-name">Student name</label>
            <input
              id="student-name"
              autoComplete="name"
              value={studentName}
              onChange={(event) => setStudentName(event.target.value)}
              required
              maxLength={120}
            />
            <label htmlFor="student-username">Username</label>
            <input
              id="student-username"
              autoComplete="off"
              value={studentUsername}
              onChange={(event) => setStudentUsername(event.target.value)}
              minLength={3}
              maxLength={50}
              pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,49}"
              title="Use 3-50 letters, numbers, periods, underscores, or hyphens."
              required
            />
            <label htmlFor="student-registration">Registration / student ID</label>
            <input
              id="student-registration"
              value={studentRegistrationNumber}
              onChange={(event) => setStudentRegistrationNumber(event.target.value)}
              maxLength={64}
              required
            />
            <label htmlFor="student-initial-password">Initial password (at least 8 characters)</label>
            <input
              id="student-initial-password"
              type="password"
              autoComplete="new-password"
              value={studentPassword}
              onChange={(event) => setStudentPassword(event.target.value)}
              minLength={8}
              required
            />
            <button type="submit" className="primary-button" disabled={busy}>
              {busy ? "Creating account..." : "Create student account"}
            </button>
          </form>
        </section>
      )}

      {/* TAB 1: EXAMS & QUESTIONS MANAGEMENT */}
      {activeTab === "exams" && (
        <div>
          <section
            className="dashboard-card full-card"
            aria-label="Examinations Registry"
          >
            <div className="section-heading">
              <div>
                <h2 style={{ margin: 0 }}>Examination Registry</h2>
                <p style={{ color: "#635c75", margin: "4px 0 0" }}>
                  Select an examination to view, verify questions, or configure parameters.
                </p>
              </div>
              <button type="button" className="outline-button" onClick={loadData}>
                Refresh List
              </button>
            </div>

            {loading ? (
              <div className="loading-card" role="status" aria-live="polite">
                <div className="loader" /> Loading examinations and questions...
              </div>
            ) : exams.length === 0 ? (
              <div className="empty-card compact">
                No examinations found. Click "Create New Exam" tab to create one.
              </div>
            ) : (
              <div className="admin-exam-list">
                {exams.map((examItem) => {
                  const isSelected = selectedExamId === examItem.id;
                  const isPublished = examItem.status === "published";

                  return (
                    <div
                      className={`admin-exam-row ${isSelected ? "selected-row" : ""}`}
                      key={examItem.id}
                      style={{ cursor: "pointer" }}
                      onClick={() => loadExamDetails(examItem.id)}
                    >
                      <div>
                        <strong>{examItem.title}</strong>
                        <p style={{ margin: "4px 0 0", color: "#635c75", fontSize: 13 }}>
                          {examItem.description || examItem.subject} • {examItem.subject}
                        </p>
                      </div>

                      <div className="admin-exam-meta">
                        <span>⏱ {examItem.duration_minutes} min</span>
                        <span>📝 {examItem.question_count || 0} Qs</span>
                        <span>✓ {examItem.verified_count || 0} Verified</span>

                        <span
                          className={`status-badge ${
                            isPublished ? "badge-published" : "badge-draft"
                          }`}
                        >
                          {isPublished ? "Published" : "Draft"}
                        </span>

                        <div className="action-btn-group" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            className="outline-button"
                            style={{ padding: "6px 12px", fontSize: 12 }}
                            onClick={() => loadExamDetails(examItem.id)}
                          >
                            {isSelected ? "Inspecting Qs" : "Inspect Qs"}
                          </button>

                          <button
                            type="button"
                            className="outline-button"
                            style={{ padding: "6px 12px", fontSize: 12 }}
                            onClick={() => setEditingExam({ ...examItem })}
                          >
                            Edit
                          </button>

                          {isPublished ? (
                            <button
                              type="button"
                              className="warning-button"
                              style={{ padding: "6px 12px", fontSize: 12 }}
                              onClick={() => handleUnpublish(examItem.id)}
                              disabled={busy}
                            >
                              Unpublish
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="small-primary-button"
                              style={{ padding: "6px 12px", fontSize: 12 }}
                              onClick={() => handlePublish(examItem.id)}
                              disabled={busy}
                            >
                              Publish
                            </button>
                          )}

                          <button
                            type="button"
                            className="danger-button"
                            style={{ padding: "6px 10px", fontSize: 12 }}
                            onClick={() => handleDeleteExam(examItem.id)}
                            disabled={busy || examItem.id === "demo_exam_2026"}
                            title={
                              examItem.id === "demo_exam_2026"
                                ? "Seeded demo exam cannot be deleted"
                                : "Delete this examination"
                            }
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* QUESTION INSPECTOR & VERIFIER PANEL */}
          {selectedExamData && (
            <section
              className="extracted-questions-card"
              style={{ marginTop: 24 }}
              aria-label="Question Verification Section"
            >
              <div className="section-heading">
                <div>
                  <h2 style={{ margin: 0 }}>
                    Question Inspection: {selectedExamData.exam?.title}
                  </h2>
                  <p style={{ color: "#635c75", margin: "4px 0 0" }}>
                    All questions must be verified before publishing. Verified:{" "}
                    <strong>
                      {
                        selectedExamData.questions?.filter((q) => q.verified).length || 0
                      }{" "}
                      / {selectedExamData.questions?.length || 0}
                    </strong>
                  </p>
                </div>

                <div className="action-btn-group">
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => setShowAddQuestion(true)}
                  >
                    + Add Question Manually
                  </button>

                  <button
                    type="button"
                    className="outline-button"
                    onClick={() => handleVerifyAll(selectedExamData.exam?.id)}
                    disabled={
                      busy ||
                      selectedExamData.questions?.every((q) => q.verified) ||
                      selectedExamData.questions?.length === 0
                    }
                  >
                    Verify All Questions
                  </button>

                  {selectedExamData.exam?.status !== "published" && (
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => handlePublish(selectedExamData.exam?.id)}
                      disabled={busy}
                    >
                      Publish Exam Now →
                    </button>
                  )}
                </div>
              </div>

              {selectedExamData.questions?.length === 0 ? (
                <div className="empty-card compact">
                  No questions added yet. Click "+ Add Question Manually" or use "Scanned Paper" tab.
                </div>
              ) : (
                <div className="review-table-card" style={{ marginTop: 16 }}>
                  <table className="review-table">
                    <thead>
                      <tr>
                        <th scope="col">#</th>
                        <th scope="col">Prompt</th>
                        <th scope="col">Type</th>
                        <th scope="col">Options / Correct Key</th>
                        <th scope="col">Marks</th>
                        <th scope="col">Status</th>
                        <th scope="col">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedExamData.questions?.map((q) => (
                        <tr key={q.id}>
                          <td><strong>{q.q_number}</strong></td>
                          <td style={{ maxWidth: 360 }}>
                            {q.prompt}
                            {q.math_latex && (
                              <div style={{ marginTop: 4, color: "#6c5ce7", fontSize: 13 }}>
                                <code>{formatMathDisplay(q.math_latex)}</code>
                              </div>
                            )}
                          </td>
                          <td>
                            <span className="badge-type">{q.type}</span>
                          </td>
                          <td style={{ fontSize: 13 }}>
                            {q.options?.length > 0 ? (
                              q.options.map((o) => `${o.key}: ${o.text}`).join(" | ")
                            ) : q.correct_answer ? (
                              <span>Key: <strong>{formatMathDisplay(q.correct_answer)}</strong></span>
                            ) : (
                              <span style={{ color: "#9ca3af" }}>—</span>
                            )}
                          </td>
                          <td>{q.marks || 1}</td>
                          <td>
                            <span
                              className={`status-badge ${
                                q.verified ? "badge-verified" : "badge-unverified"
                              }`}
                            >
                              {q.verified ? "✓ Verified" : "○ Unverified"}
                            </span>
                          </td>
                          <td>
                            <div className="action-btn-group">
                              <button
                                type="button"
                                className="outline-button"
                                style={{ padding: "4px 10px", fontSize: 12 }}
                                onClick={() => handleVerifyQuestion(q.id, !q.verified)}
                              >
                                {q.verified ? "Unverify" : "Verify"}
                              </button>
                              <button
                                type="button"
                                className="danger-button"
                                style={{ padding: "4px 8px", fontSize: 12 }}
                                onClick={() => handleDeleteQuestion(q.id)}
                              >
                                ✕
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {/* TAB 2: CREATE NEW EXAM */}
      {activeTab === "create" && (
        <section className="dashboard-card" style={{ maxWidth: 760 }} aria-label="Create Examination Form">
          <div className="card-icon purple" aria-hidden="true">+</div>
          <h2>Create New Examination Shell</h2>
          <p style={{ color: "#635c75", marginBottom: 20 }}>
            Configure examination parameters. Once created, you can add questions manually or import via PDF scan.
          </p>

          <div className="form-field" style={{ marginBottom: 14 }}>
            <label htmlFor="create-exam-title">Examination Title *</label>
            <input
              id="create-exam-title"
              value={title}
              placeholder="e.g. Advanced Calculus & Differential Equations 2026"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="create-exam-subject">Subject Area</label>
              <input
                id="create-exam-subject"
                value={subject}
                placeholder="e.g. Mathematics"
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>

            <div className="form-field">
              <label htmlFor="create-exam-duration">Duration (Minutes)</label>
              <input
                id="create-exam-duration"
                type="number"
                min="1"
                max="600"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              />
            </div>
          </div>

          <div className="form-field" style={{ marginBottom: 20 }}>
            <label htmlFor="create-exam-desc">Description & Instructions</label>
            <textarea
              id="create-exam-desc"
              value={description}
              placeholder="Accessibility guidelines, instructions, or exam syllabus..."
              rows={3}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <button
            type="button"
            className="primary-button"
            onClick={handleCreate}
            disabled={busy || !title.trim()}
          >
            {busy ? "Creating Examination..." : "Create Examination →"}
          </button>
        </section>
      )}

      {/* TAB 3: SCANNED QUESTION PAPER (PDF PARSER) */}
      {activeTab === "paper" && (
        <div>
          <section className="dashboard-card" aria-label="Scan Question Paper Section">
            <div className="card-icon purple" aria-hidden="true">↑</div>
            <h2>Scan & Import Question Paper (PDF)</h2>
            <p style={{ color: "#635c75", marginBottom: 20 }}>
              Upload standard text-encoded PDF examination papers for automated question extraction.
            </p>

            <div className="upload-zone">
              <div className="upload-icon" aria-hidden="true">↑</div>
              <strong>Choose a PDF question paper</strong>
              <small>Standard text-based PDF formats supported</small>
              <input
                type="file"
                accept=".pdf,application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                aria-label="Upload PDF Question Paper"
              />
              {file && (
                <div className="selected-file">
                  Selected file: <strong>{file.name}</strong> ({(file.size / 1024).toFixed(1)} KB)
                </div>
              )}
            </div>

            <button
              type="button"
              className="primary-button full-width"
              style={{ marginTop: 16 }}
              onClick={handleUpload}
              disabled={busy || !file}
            >
              {busy ? "Processing PDF Document..." : "Extract Questions from PDF"}
            </button>
          </section>

          {/* Extracted Questions Inspection & Import Section */}
          {uploadResult && (
            <section className="extracted-questions-card" aria-label="Extracted Questions Preview">
              <div className="section-heading">
                <div>
                  <h2 style={{ margin: 0 }}>
                    Extracted Questions Preview ({uploadResult.extracted_questions?.length || 0} questions)
                  </h2>
                  <p style={{ color: "#635c75", margin: "4px 0 0" }}>
                    Source file: <strong>{uploadResult.filename}</strong> ({uploadResult.page_count} pages,{" "}
                    {uploadResult.line_count} lines)
                  </p>
                </div>

                {uploadResult.extracted_questions?.length > 0 && (
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <label htmlFor="target-exam-select" style={{ fontSize: 13, fontWeight: 700 }}>
                      Destination Exam:
                    </label>
                    <select
                      id="target-exam-select"
                      value={targetExamForImport}
                      onChange={(e) => setTargetExamForImport(e.target.value)}
                      style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #dcd6e8" }}
                    >
                      {exams.map((ex) => (
                        <option key={ex.id} value={ex.id}>
                          {ex.title} ({ex.status})
                        </option>
                      ))}
                    </select>

                    <button
                      type="button"
                      className="primary-button"
                      onClick={handleImportExtracted}
                      disabled={busy}
                    >
                      {busy ? "Importing..." : "Import All into Exam →"}
                    </button>
                  </div>
                )}
              </div>

              {uploadResult.notice && (
                <div
                  className={`notice-card ${
                    uploadResult.is_scanned_image ? "warning" : ""
                  }`}
                >
                  <strong>Notice:</strong> {uploadResult.notice}
                </div>
              )}

              {uploadResult.extracted_questions?.length > 0 && (
                <div style={{ maxHeight: 420, overflowY: "auto", marginTop: 16 }}>
                  {uploadResult.extracted_questions.map((q, idx) => (
                    <div key={idx} className="extracted-question-row">
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          marginBottom: 6,
                        }}
                      >
                        <strong>
                          Q{q.q_number}. {q.prompt}
                        </strong>
                        <span className="badge-type">{q.type}</span>
                      </div>
                      {q.options?.length > 0 && (
                        <div
                          style={{
                            display: "flex",
                            gap: 16,
                            fontSize: 13,
                            color: "#555",
                            marginLeft: 16,
                          }}
                        >
                          {q.options.map((opt) => (
                            <span key={opt.key}>
                              <strong>{opt.key}:</strong> {opt.text}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {/* TAB 4: STUDENT ATTEMPTS & MONITORING */}
      {activeTab === "attempts" && (
        <section className="dashboard-card full-card" aria-label="Student Sessions Registry">
          <div className="section-heading">
            <div>
              <h2 style={{ margin: 0 }}>Student Examination Sessions & Monitoring</h2>
              <p style={{ color: "#635c75", margin: "4px 0 0" }}>
                Live and completed examination attempts across all registered students.
              </p>
            </div>
            <button type="button" className="outline-button" onClick={loadData}>
              Refresh Sessions
            </button>
          </div>

          {loading ? (
            <div className="loading-card" role="status" aria-live="polite">
              <div className="loader" /> Loading student attempts...
            </div>
          ) : attempts.length === 0 ? (
            <div className="empty-card compact">
              No student examination attempts recorded yet.
            </div>
          ) : (
            <div className="review-table-card">
              <table className="review-table">
                <thead>
                  <tr>
                    <th scope="col">Student</th>
                    <th scope="col">Examination Paper</th>
                    <th scope="col">Started At</th>
                    <th scope="col">Status</th>
                    <th scope="col">Score</th>
                    <th scope="col">Percentage</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {attempts.map((att) => {
                    const r = att.results;
                    const dateStr = att.started_at
                      ? new Date(att.started_at * 1000).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "Recently";

                    return (
                      <tr key={att.session_id}>
                        <td>
                          <strong>{att.student?.display_name || att.user_id || "Student"}</strong>
                          <div style={{ color: "#635c75", fontSize: 12 }}>
                            @{att.student?.username || "student"}
                          </div>
                        </td>
                        <td>{att.exam?.title || att.exam_id}</td>
                        <td>{dateStr}</td>
                        <td>
                          <span
                            className={`status-badge ${
                              att.is_submitted ? "badge-published" : "badge-draft"
                            }`}
                          >
                            {att.is_submitted ? "Submitted" : "In Progress"}
                          </span>
                        </td>
                        <td>
                          {r ? <strong>{r.score} / {r.total_marks}</strong> : "—"}
                        </td>
                        <td>
                          {r ? (
                            <span
                              className={`status-tag ${
                                r.percentage >= 50 ? "answered" : "unanswered"
                              }`}
                            >
                              {r.percentage}%
                            </span>
                          ) : (
                            <span style={{ color: "#9ca3af" }}>In progress</span>
                          )}
                        </td>
                        <td>
                          {att.is_submitted && r ? (
                            <button
                              type="button"
                              className="outline-button"
                              style={{ padding: "4px 10px", fontSize: 12 }}
                              onClick={() => setInspectAttempt(att)}
                            >
                              Inspect Results →
                            </button>
                          ) : (
                            <span style={{ color: "#9ca3af", fontSize: 12 }}>Active</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* TAB 5: RECENT ACTIVITY FEED */}
      {activeTab === "activity" && (
        <section className="dashboard-card full-card" aria-label="System Activity Feed">
          <div className="section-heading">
            <div>
              <h2 style={{ margin: 0 }}>Recent System Activity Log</h2>
              <p style={{ color: "#635c75", margin: "4px 0 0" }}>
                Real-time chronological events from the exam gateway persistence layer.
              </p>
            </div>
          </div>

          {!stats?.recent_activity?.length ? (
            <div className="empty-card compact">No recent activity logged.</div>
          ) : (
            <div className="review-table-card">
              <table className="review-table">
                <thead>
                  <tr>
                    <th scope="col">Session ID</th>
                    <th scope="col">Exam ID</th>
                    <th scope="col">Student ID</th>
                    <th scope="col">Status</th>
                    <th scope="col">Timestamp</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.recent_activity.map((act) => (
                    <tr key={act.session_id}>
                      <td><code>{act.session_id.slice(0, 12)}...</code></td>
                      <td>{act.exam_id}</td>
                      <td>{act.user_id || "Anonymous"}</td>
                      <td>
                        <span
                          className={`status-badge ${
                            act.is_submitted ? "badge-published" : "badge-draft"
                          }`}
                        >
                          {act.is_submitted ? "Submitted" : "Started"}
                        </span>
                      </td>
                      <td>
                        {act.started_at
                          ? new Date(act.started_at * 1000).toLocaleTimeString()
                          : "Recently"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* MODAL 1: EDIT EXAM */}
      {editingExam && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-exam-title"
          onClick={() => setEditingExam(null)}
        >
          <div className="modal-container" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 id="edit-exam-title" className="modal-title">Edit Examination Details</h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setEditingExam(null)}
                aria-label="Close dialog"
              >
                ✕
              </button>
            </div>

            <div className="modal-body">
              <div className="form-field" style={{ marginBottom: 14 }}>
                <label htmlFor="edit-title">Exam Title *</label>
                <input
                  id="edit-title"
                  value={editingExam.title || ""}
                  onChange={(e) =>
                    setEditingExam({ ...editingExam, title: e.target.value })
                  }
                />
              </div>

              <div className="form-grid">
                <div className="form-field">
                  <label htmlFor="edit-subject">Subject</label>
                  <input
                    id="edit-subject"
                    value={editingExam.subject || ""}
                    onChange={(e) =>
                      setEditingExam({ ...editingExam, subject: e.target.value })
                    }
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="edit-duration">Duration (Minutes)</label>
                  <input
                    id="edit-duration"
                    type="number"
                    min="1"
                    max="600"
                    value={editingExam.duration_minutes || 60}
                    onChange={(e) =>
                      setEditingExam({
                        ...editingExam,
                        duration_minutes: e.target.value,
                      })
                    }
                  />
                </div>
              </div>

              <div className="form-field">
                <label htmlFor="edit-desc">Description</label>
                <textarea
                  id="edit-desc"
                  rows={3}
                  value={editingExam.description || ""}
                  onChange={(e) =>
                    setEditingExam({
                      ...editingExam,
                      description: e.target.value,
                    })
                  }
                />
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="outline-button"
                onClick={() => setEditingExam(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={handleUpdateExam}
                disabled={busy}
              >
                {busy ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 2: ADD QUESTION MANUALLY */}
      {showAddQuestion && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-q-title"
          onClick={() => setShowAddQuestion(false)}
        >
          <div
            className="modal-container"
            onClick={(e) => e.stopPropagation()}
            style={{ width: "min(780px, 95%)" }}
          >
            <div className="modal-header">
              <h3 id="add-q-title" className="modal-title">
                Add Question to {selectedExamData?.exam?.title}
              </h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setShowAddQuestion(false)}
                aria-label="Close dialog"
              >
                ✕
              </button>
            </div>

            <div className="modal-body">
              <div className="form-grid">
                <div className="form-field">
                  <label htmlFor="add-q-num">Question Number *</label>
                  <input
                    id="add-q-num"
                    type="number"
                    value={newQNum}
                    onChange={(e) => setNewQNum(e.target.value)}
                  />
                </div>

                <div className="form-field">
                  <label htmlFor="add-q-type">Question Type *</label>
                  <select
                    id="add-q-type"
                    value={newQType}
                    onChange={(e) => setNewQType(e.target.value)}
                  >
                    <option value="MCQ">Multiple Choice (MCQ)</option>
                    <option value="NUMERICAL">Numerical Answer</option>
                    <option value="MATHEMATICS">Mathematics / Stepwise</option>
                    <option value="DESCRIPTIVE">Descriptive / Spoken Essay</option>
                  </select>
                </div>

                <div className="form-field">
                  <label htmlFor="add-q-marks">Marks Awarded</label>
                  <input
                    id="add-q-marks"
                    type="number"
                    step="0.5"
                    value={newQMarks}
                    onChange={(e) => setNewQMarks(e.target.value)}
                  />
                </div>
              </div>

              <div className="form-field" style={{ marginBottom: 14 }}>
                <label htmlFor="add-q-prompt">Question Prompt Text *</label>
                <textarea
                  id="add-q-prompt"
                  rows={2}
                  placeholder="e.g. Which of the following is a prime number?"
                  value={newQPrompt}
                  onChange={(e) => setNewQPrompt(e.target.value)}
                />
              </div>

              {newQType === "MCQ" && (
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 13, fontWeight: 700, color: "#4b455c" }}>
                    Multiple Choice Options
                  </label>
                  <div className="form-grid" style={{ marginTop: 8 }}>
                    <div className="form-field">
                      <label htmlFor="opt-a">Option A</label>
                      <input
                        id="opt-a"
                        placeholder="Option A text"
                        value={newQOptA}
                        onChange={(e) => setNewQOptA(e.target.value)}
                      />
                    </div>
                    <div className="form-field">
                      <label htmlFor="opt-b">Option B</label>
                      <input
                        id="opt-b"
                        placeholder="Option B text"
                        value={newQOptB}
                        onChange={(e) => setNewQOptB(e.target.value)}
                      />
                    </div>
                    <div className="form-field">
                      <label htmlFor="opt-c">Option C</label>
                      <input
                        id="opt-c"
                        placeholder="Option C text"
                        value={newQOptC}
                        onChange={(e) => setNewQOptC(e.target.value)}
                      />
                    </div>
                    <div className="form-field">
                      <label htmlFor="opt-d">Option D</label>
                      <input
                        id="opt-d"
                        placeholder="Option D text"
                        value={newQOptD}
                        onChange={(e) => setNewQOptD(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              )}

              <div className="form-grid">
                <div className="form-field">
                  <label htmlFor="add-q-key">Correct Answer Key</label>
                  <input
                    id="add-q-key"
                    placeholder={newQType === "MCQ" ? "e.g. A, B, C, or D" : "e.g. 50 or x = 1"}
                    value={newQKey}
                    onChange={(e) => setNewQKey(e.target.value)}
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="add-q-topic">Topic</label>
                  <input
                    id="add-q-topic"
                    placeholder="e.g. Algebra, Arithmetic"
                    value={newQTopic}
                    onChange={(e) => setNewQTopic(e.target.value)}
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="add-q-diff">Difficulty</label>
                  <select
                    id="add-q-diff"
                    value={newQDiff}
                    onChange={(e) => setNewQDiff(e.target.value)}
                  >
                    <option value="easy">Easy</option>
                    <option value="medium">Medium</option>
                    <option value="hard">Hard</option>
                  </select>
                </div>
              </div>

              <div style={{ marginTop: 14 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={newQVerified}
                    onChange={(e) => setNewQVerified(e.target.checked)}
                  />
                  <span style={{ fontSize: 13, fontWeight: 700 }}>
                    Mark this question as verified immediately
                  </span>
                </label>
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="outline-button"
                onClick={() => setShowAddQuestion(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={handleAddQuestionSubmit}
                disabled={busy || !newQPrompt.trim()}
              >
                {busy ? "Saving Question..." : "Save Question →"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 3: INSPECT STUDENT ATTEMPT */}
      {inspectAttempt && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="inspect-modal-title"
          onClick={() => setInspectAttempt(null)}
        >
          <div
            className="modal-container"
            onClick={(e) => e.stopPropagation()}
            style={{ width: "min(820px, 95%)" }}
          >
            <div className="modal-header">
              <h3 id="inspect-modal-title" className="modal-title">
                Session Inspection: {inspectAttempt.student?.display_name || "Student"} •{" "}
                {inspectAttempt.exam?.title}
              </h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setInspectAttempt(null)}
                aria-label="Close dialog"
              >
                ✕
              </button>
            </div>

            <div className="modal-body">
              {inspectAttempt.results ? (
                <>
                  <div className="results-stats-grid" style={{ marginBottom: 20 }}>
                    <div className="results-stat-box">
                      <strong>{inspectAttempt.results.percentage}%</strong>
                      <span>Score</span>
                    </div>
                    <div className="results-stat-box">
                      <strong>{inspectAttempt.results.correct}</strong>
                      <span>Correct</span>
                    </div>
                    <div className="results-stat-box">
                      <strong>{inspectAttempt.results.incorrect}</strong>
                      <span>Incorrect</span>
                    </div>
                    <div className="results-stat-box">
                      <strong>{inspectAttempt.results.unanswered}</strong>
                      <span>Unanswered</span>
                    </div>
                  </div>

                  {inspectAttempt.results.review?.length > 0 && (
                    <table className="review-table">
                      <thead>
                        <tr>
                          <th scope="col">#</th>
                          <th scope="col">Student Answer</th>
                          <th scope="col">Official Key</th>
                          <th scope="col">Status</th>
                          <th scope="col">Marks Awarded</th>
                        </tr>
                      </thead>
                      <tbody>
                        {inspectAttempt.results.review.map((item) => (
                          <tr key={item.q_number}>
                            <td><strong>{item.q_number}</strong></td>
                            <td>{item.recorded_answer ? formatMathDisplay(item.recorded_answer) : "None"}</td>
                            <td>{item.correct_answer ? formatMathDisplay(item.correct_answer) : "—"}</td>
                            <td>
                              <span
                                className={`status-badge ${
                                  item.status === "correct" ? "badge-published" : "badge-draft"
                                }`}
                              >
                                {item.status}
                              </span>
                            </td>
                            <td>{item.awarded ?? 0} / {item.marks}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              ) : (
                <div className="empty-card compact">
                  Results dataset unavailable for this session.
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="primary-button"
                onClick={() => setInspectAttempt(null)}
              >
                Close Inspector
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
