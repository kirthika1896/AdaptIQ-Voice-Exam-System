import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import AppShell from "../components/AppShell";
import ExamNavigator from "../components/ExamNavigator";
import VoicePanel from "../components/VoicePanel";
import { api } from "../api/client";
import { useVoice } from "../hooks/useVoice";
import { speak } from "../voice/speech";

function formatClock(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(value / 60);
  const s = value % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function ExamPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState("");
  const [response, setResponse] = useState("");
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const [remaining, setRemaining] = useState(null);
  const [expiredHandled, setExpiredHandled] = useState(false);
  const lastCommandAt = useRef(0);
  const introSpoken = useRef(false);
  const lastQuestion = useRef(null);

  const applyPayload = useCallback((data, { speakNow = true } = {}) => {
    setPayload(data);
    if (data.session?.time_remaining_seconds != null) {
      setRemaining(data.session.time_remaining_seconds);
    }
    if (data.response?.recorded_answer) setTyped(data.response.recorded_answer);
    else setTyped("");
    if (data.event === "review_exam") {
      navigate(`/student/exam/${sessionId}/review`);
    }
    if (data.event === "exam_submitted") {
      navigate(`/student/results/${sessionId}`, { state: { results: data.results, speak: data.speak } });
    }
    if (speakNow && data.speak) {
      setResponse(data.speak);
    }
    return data;
  }, [navigate, sessionId]);

  const refresh = useCallback(async () => {
    const data = await api.getSession(sessionId);
    applyPayload(data, { speakNow: false });
    return data;
  }, [applyPayload, sessionId]);

  useEffect(() => {
    let cancelled = false;
    refresh()
      .then(async (data) => {
        if (cancelled) return;
        const intro = location.state?.speak || data.speak;
        if (!introSpoken.current && intro) {
          introSpoken.current = true;
          setResponse(intro);
          await speak(intro);
          lastQuestion.current = data.session?.current_question;
        }
      })
      .catch((err) => setError(err.message));
    const timer = setInterval(() => {
      setRemaining((prev) => (prev == null ? prev : Math.max(0, prev - 1)));
    }, 1000);
    const sync = setInterval(() => {
      refresh().catch(() => {});
    }, 20000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearInterval(sync);
    };
  }, [location.state, refresh]);

  useEffect(() => {
    if (remaining === 0 && payload && !payload.session?.is_submitted && !expiredHandled) {
      setExpiredHandled(true);
      speak("Time is over. Submitting your examination.");
      api.confirmSubmit(sessionId)
        .then((data) => applyPayload(data))
        .catch((err) => setError(err.message));
    }
  }, [remaining, payload, expiredHandled, sessionId, applyPayload]);

  const sendVoice = useCallback(
    async (text) => {
      const now = Date.now();
      if (now - lastCommandAt.current < 600) return;
      lastCommandAt.current = now;
      setBusy(true);
      try {
        const data = await api.sendTranscript(sessionId, text);
        applyPayload(data, { speakNow: false });
        if (data.event === "voice_paused") voiceCtl.current?.disable();
        if (data.event === "voice_resumed") voiceCtl.current?.enable();
        if (data.speak) {
          setResponse(data.speak);
          await speak(data.speak);
        }
        lastQuestion.current = data.session?.current_question;
      } catch (err) {
        setError(err.message);
        await speak(err.message);
      } finally {
        setBusy(false);
      }
    },
    [applyPayload, sessionId]
  );

  const voice = useVoice({
    enabledDefault: true,
    onFinalTranscript: sendVoice,
  });
  const voiceCtl = useRef(voice);
  voiceCtl.current = voice;

  useEffect(() => {
    voice.enable();
    return () => voice.disable();
    // enable once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const session = payload?.session;
  const question = payload?.question;
  const unanswered = payload?.unanswered || [];
  const numbers = payload?.question_numbers || [];
  const submitted = Boolean(session?.is_submitted);
  const pending = Boolean(session?.pending_submit_confirmation);

  const selected = useMemo(() => {
    const answer = payload?.response?.recorded_answer;
    return answer ? String(answer).toUpperCase() : "";
  }, [payload]);

  const saveOption = async (key) => {
    await sendVoice(`option ${key}`);
  };

  return (
    <AppShell>
      <VoicePanel
        status={busy ? "processing" : voice.status}
        enabled={voice.enabled}
        transcript={voice.transcript}
        interim={voice.interim}
        response={response}
        error={voice.error || error}
        available={voice.available}
        onToggle={() => (voice.enabled ? voice.disable() : voice.enable())}
      />

      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0 }}>{payload?.exam?.title || "Examination"}</h1>
          <p className="muted">
            Question {session?.current_question || "—"} of {session?.total_questions || numbers.length || "—"}
          </p>
        </div>
        <div className="pill" aria-live="polite">Time remaining {formatClock(remaining)}</div>
      </div>

      {pending ? (
        <div className="alert info" role="alertdialog">
          Submission confirmation required. Say yes to submit or no to cancel.
          <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
            <button className="btn" type="button" onClick={() => sendVoice("yes")}>Yes, submit</button>
            <button className="btn ghost" type="button" onClick={() => sendVoice("no")}>No, continue</button>
          </div>
        </div>
      ) : null}

      {error ? <div className="alert" role="alert">{error}</div> : null}

      <div className="question-layout">
        <section className="card">
          {question ? (
            <>
              <p className="pill">{question.type} · {question.marks} marks</p>
              <h2>Question {question.q_number}</h2>
              <p style={{ fontSize: "1.15rem", lineHeight: 1.6 }}>{question.prompt}</p>
              {question.options?.length ? (
                <div role="list" aria-label="Answer options">
                  {question.options.map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      className={`option${selected === String(opt.key).toUpperCase() ? " selected" : ""}`}
                      disabled={submitted}
                      onClick={() => saveOption(opt.key)}
                    >
                      Option {opt.key}: {opt.text}
                    </button>
                  ))}
                </div>
              ) : (
                <label className="field">
                  Your answer
                  <textarea
                    rows={4}
                    value={typed}
                    disabled={submitted}
                    onChange={(e) => setTyped(e.target.value)}
                  />
                </label>
              )}
              {!question.options?.length ? (
                <button className="btn" type="button" disabled={submitted || busy} onClick={() => api.saveAnswer(sessionId, typed, typed).then(applyPayload)}>
                  Save answer
                </button>
              ) : null}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
                <button className="btn ghost" type="button" onClick={() => sendVoice("previous question")} disabled={submitted}>Previous</button>
                <button className="btn ghost" type="button" onClick={() => sendVoice("next question")} disabled={submitted}>Next</button>
                <button className="btn ghost" type="button" onClick={() => sendVoice("repeat the question")}>Repeat</button>
                <button className="btn ghost" type="button" onClick={() => sendVoice("clear my answer")} disabled={submitted}>Clear</button>
                <button className="btn ghost" type="button" onClick={() => navigate(`/student/exam/${sessionId}/review`)}>Review</button>
                <button className="btn danger" type="button" onClick={() => sendVoice("submit my exam")} disabled={submitted}>Submit</button>
              </div>
              <p className="muted">Saved answer: {payload?.response?.recorded_answer || "none"}</p>
            </>
          ) : (
            <div className="skeleton" style={{ height: 220 }} />
          )}
        </section>
        <ExamNavigator
          numbers={numbers}
          current={session?.current_question}
          unanswered={unanswered}
          marked={session?.marked_questions}
          disabled={submitted}
          onJump={(n) => sendVoice(`go to question ${n}`)}
        />
      </div>
    </AppShell>
  );
}
