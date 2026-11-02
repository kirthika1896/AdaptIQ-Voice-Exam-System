import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import AppShell from "../components/AppShell";
import VoicePanel from "../components/VoicePanel";
import { api } from "../api/client";
import { useVoice } from "../hooks/useVoice";
import { speak } from "../voice/speech";

export default function ReviewPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [payload, setPayload] = useState(null);
  const [answers, setAnswers] = useState({});
  const [error, setError] = useState("");
  const [response, setResponse] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    async function load() {
      const data = await api.getSession(sessionId);
      const exam = await api.getExam(data.session.exam_id);
      const resp = await api.getResponses(sessionId);
      const map = {};
      for (const row of resp.responses || []) {
        map[row.question_number] = row.recorded_answer || "";
      }
      setPayload({ ...data, exam: exam.exam, questions: exam.questions });
      setAnswers(map);
      setPending(Boolean(data.session?.pending_submit_confirmation));
      const unanswered = data.unanswered || [];
      const msg = `Review. ${(exam.questions || []).length - unanswered.length} answered, ${unanswered.length} unanswered${unanswered.length ? `: ${unanswered.join(", ")}` : ""}.`;
      setResponse(msg);
      await speak(msg);
    }
    load().catch((err) => setError(err.message));
  }, [sessionId]);

  const voice = useVoice({
    enabledDefault: true,
    onFinalTranscript: async (text) => {
      try {
        const data = await api.sendTranscript(sessionId, text);
        setPayload((prev) => ({ ...prev, ...data }));
        setPending(Boolean(data.session?.pending_submit_confirmation));
        if (data.speak) {
          setResponse(data.speak);
          await speak(data.speak);
        }
        if (data.event === "navigated" || data.event === "repeat_prompt") {
          navigate(`/student/exam/${sessionId}`);
        }
        if (data.event === "exam_submitted") {
          navigate(`/student/results/${sessionId}`, { state: { results: data.results, speak: data.speak } });
        }
      } catch (err) {
        setError(err.message);
        await speak(err.message);
      }
    },
  });

  const unanswered = payload?.unanswered || [];
  const questions = payload?.questions || [];

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
      <h1>Review examination</h1>
      <p>{questions.length - unanswered.length} answered · {unanswered.length} unanswered</p>
      {pending ? <div className="alert info">Say yes to submit or no to cancel.</div> : null}
      <table className="table">
        <thead>
          <tr>
            <th>Question</th>
            <th>Type</th>
            <th>Answer</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {questions.map((q) => (
            <tr key={q.q_number}>
              <td>{q.q_number}</td>
              <td>{q.type}</td>
              <td>{answers[q.q_number] || "—"}</td>
              <td>{unanswered.includes(q.q_number) ? "Unanswered" : "Answered"}</td>
              <td>
                <button className="btn ghost" type="button" onClick={() => api.gotoQuestion(sessionId, q.q_number).then(() => navigate(`/student/exam/${sessionId}`))}>
                  Return
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
        <button className="btn ghost" type="button" onClick={() => navigate(`/student/exam/${sessionId}`)}>Back to exam</button>
        <button className="btn danger" type="button" onClick={() => api.requestSubmit(sessionId).then((d) => { setPending(true); setResponse(d.speak); speak(d.speak); })}>
          Submit exam
        </button>
      </div>
    </AppShell>
  );
}
