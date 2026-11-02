import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import AppShell from "../components/AppShell";
import { api } from "../api/client";
import { speak } from "../voice/speech";

export default function ExamDetailsPage() {
  const { examId } = useParams();
  const navigate = useNavigate();
  const [exam, setExam] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getExam(examId)
      .then((data) => {
        setExam(data.exam);
        setQuestions(data.questions || []);
        speak(
          `${data.exam.title}. ${data.exam.duration_minutes} minutes. ${data.questions?.length || 0} questions. Say start exam when you are ready.`
        );
      })
      .catch((err) => setError(err.message));
  }, [examId]);

  const start = async () => {
    setBusy(true);
    try {
      const data = await api.startSession(examId);
      navigate(`/student/exam/${data.session.session_id}`, { state: { speak: data.speak } });
    } catch (err) {
      setError(err.message);
      await speak(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!exam && !error) return <AppShell><div className="skeleton" style={{ height: 200 }} /></AppShell>;

  return (
    <AppShell>
      {error ? <div className="alert" role="alert">{error}</div> : null}
      {exam ? (
        <>
          <section className="hero">
            <h1>{exam.title}</h1>
            <p>{exam.description || exam.subject}</p>
            <p>{exam.duration_minutes} minutes · {questions.length} questions · {exam.status}</p>
            <button className="btn" style={{ marginTop: 12, background: "white", color: "#4338ca" }} onClick={start} disabled={busy || exam.status !== "published"}>
              {busy ? "Starting…" : "Start exam"}
            </button>
          </section>
          <section className="card" style={{ marginTop: 18 }}>
            <h3>Paper outline</h3>
            <ol>
              {questions.map((q) => (
                <li key={q.id || q.q_number}>Question {q.q_number}: {q.type} · {q.marks} marks</li>
              ))}
            </ol>
          </section>
        </>
      ) : null}
    </AppShell>
  );
}
