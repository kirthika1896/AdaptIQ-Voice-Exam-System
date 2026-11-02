import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import AppShell from "../components/AppShell";
import VoicePanel from "../components/VoicePanel";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useVoice } from "../hooks/useVoice";
import { matchExamByTitle, parseAppIntent } from "../voice/appIntent";
import { speak } from "../voice/speech";

export default function StudentDashboard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [exams, setExams] = useState([]);
  const [results, setResults] = useState([]);
  const [active, setActive] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [response, setResponse] = useState("");
  const [backendOk, setBackendOk] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [examData, resultData, activeData, health] = await Promise.all([
        api.listExams(),
        api.myResults().catch(() => ({ attempts: [] })),
        api.activeSession().catch(() => ({ session: null })),
        api.health().catch(() => null),
      ]);
      setExams(examData.exams || []);
      setResults(resultData.attempts || []);
      setActive(activeData.session || null);
      setBackendOk(Boolean(health?.ok));
      setError("");
    } catch (err) {
      setBackendOk(false);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const intro = useMemo(() => {
    const count = exams.length;
    const names = exams.map((e) => e.title).join(", ");
    return `Welcome ${user?.display_name || ""}. You have ${count} available examination${count === 1 ? "" : "s"}${names ? `: ${names}` : ""}. Tell me which examination you would like to take, or open one from the list.`;
  }, [exams, user]);

  useEffect(() => {
    if (!loading && !error) speak(intro);
  }, [loading, error, intro]);

  const startExam = async (exam) => {
    if (!exam) {
      const msg = "No examination is available.";
      setResponse(msg);
      await speak(msg);
      return;
    }
    try {
      const data = await api.startSession(exam.id);
      const sid = data.session.session_id;
      setResponse(data.speak || `Starting ${exam.title}`);
      navigate(`/student/exam/${sid}`, { state: { speak: data.speak } });
    } catch (err) {
      setError(err.message);
      await speak(err.message);
    }
  };

  const voice = useVoice({
    onFinalTranscript: async (text) => {
      const parsed = parseAppIntent(text);
      if (parsed.intent === "HELP") {
        const msg = "You can ask to see your results or continue an active exam. To start an exam, tell me its name or choose it from the available exams.";
        setResponse(msg);
        await speak(msg);
        return;
      }
      if (parsed.intent === "LIST_EXAMS") {
        navigate("/student/exams");
        return;
      }
      if (parsed.intent === "MY_RESULTS") {
        navigate("/student/results");
        return;
      }
      if (parsed.intent === "VOICE_GUIDE") {
        navigate("/student/voice");
        return;
      }
      if (parsed.intent === "LOGOUT") {
        await logout();
        navigate("/");
        return;
      }
      if (parsed.intent === "RESUME_EXAM") {
        if (active?.session_id) {
          navigate(`/student/exam/${active.session_id}`);
          return;
        }
        const msg = "You do not have an exam in progress.";
        setResponse(msg);
        await speak(msg);
        return;
      }
      if (parsed.intent === "START_EXAM_INDEX") {
        await startExam(exams[parsed.index]);
        return;
      }
      if (parsed.intent === "START_EXAM_NAMED") {
        const exam = matchExamByTitle(exams, parsed.title);
        if (exam) {
          await startExam(exam);
          return;
        }
        const msg = `I couldn't identify one unique exam matching ${parsed.title}. Please choose an exam by its full name.`;
        setResponse(msg);
        await speak(msg);
        return;
      }
      if (parsed.intent === "START_EXAM") {
        const msg = exams.length
          ? `Which examination would you like to take? Available exams are: ${exams.map((exam) => exam.title).join(", ")}. Please choose one by name.`
          : "There are no published examinations available right now.";
        setResponse(msg);
        await speak(msg);
        return;
      }
      const msg = "I didn't understand which examination you want. Please choose one by name or open it from the list.";
      setResponse(msg);
      await speak(msg);
    },
  });

  return (
    <AppShell>
      <VoicePanel
        status={voice.status}
        enabled={voice.enabled}
        transcript={voice.transcript}
        interim={voice.interim}
        response={response}
        error={voice.error || error}
        available={voice.available}
        onToggle={() => (voice.enabled ? voice.disable() : voice.enable())}
      />
      <section className="hero">
        <p className="pill" style={{ background: "rgba(255,255,255,0.18)", color: "white" }}>Student workspace</p>
        <h1>Welcome back, {user?.display_name}</h1>
        <p>Continue with a published examination using voice or the accessible controls.</p>
        <p>Choose the examination you want from the available exams list.</p>
      </section>

      {loading ? <div className="skeleton" style={{ height: 120, marginTop: 18 }} /> : null}
      {error ? <div className="alert" role="alert">{error}</div> : null}

      <div className="grid two" style={{ marginTop: 18 }}>
        <section className="card">
          <h3>Available exams</h3>
          <div className="exam-list">
            {exams.length === 0 && !loading ? <p className="muted">No published examinations yet.</p> : null}
            {exams.map((exam) => (
              <article key={exam.id} className="exam-item">
                <div>
                  <strong>{exam.title}</strong>
                  <p className="muted">{exam.description || exam.subject}</p>
                  <p className="muted">{exam.duration_minutes} min · {exam.question_count} questions · {exam.status}</p>
                </div>
                <button className="btn" type="button" onClick={() => navigate(`/student/exams/${exam.id}`)}>
                  {active?.exam_id === exam.id ? "Resume" : "Open"}
                </button>
              </article>
            ))}
          </div>
        </section>
        <section className="card">
          <h3>Progress and accessibility</h3>
          <p>Completed attempts: {results.length}</p>
          <p>Backend: {backendOk ? "connected" : "unavailable"}</p>
          <p>Voice engine: {voice.available ? "available" : "not supported in this browser"}</p>
          <h3 style={{ marginTop: 18 }}>Recent results</h3>
          {results.slice(0, 4).map((row) => (
            <p key={row.session_id}>
              {row.exam?.title || row.exam_id}: {row.results?.percentage ?? "—"}%
            </p>
          ))}
          {results.length === 0 ? <p className="muted">No submitted attempts yet.</p> : null}
        </section>
      </div>
    </AppShell>
  );
}
