import React, { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import AppShell from "../components/AppShell";
import VoicePanel from "../components/VoicePanel";
import { api } from "../api/client";
import { useVoice } from "../hooks/useVoice";
import { parseAppIntent } from "../voice/appIntent";
import { speak } from "../voice/speech";

function summarize(results) {
  if (!results) return "Results are not available yet.";
  return `${results.exam_title || "Examination"} complete. Score ${results.score} out of ${results.total_marks}, ${results.percentage} percent. ${results.correct} correct, ${results.incorrect} incorrect, ${results.unanswered} unanswered.`;
}

export default function ResultsPage() {
  const { sessionId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [results, setResults] = useState(location.state?.results || null);
  const [error, setError] = useState("");
  const [response, setResponse] = useState("");

  useEffect(() => {
    api.getResults(sessionId)
      .then((data) => {
        setResults(data.results);
        const msg = location.state?.speak || summarize(data.results);
        setResponse(msg);
        speak(msg);
      })
      .catch((err) => setError(err.message));
  }, [sessionId, location.state]);

  const voice = useVoice({
    enabledDefault: true,
    onFinalTranscript: async (text) => {
      const parsed = parseAppIntent(text);
      if (parsed.intent === "READ_RESULT" || /score|result/.test(text.toLowerCase())) {
        const msg = summarize(results);
        setResponse(msg);
        await speak(msg);
        return;
      }
      if (parsed.intent === "GO_DASHBOARD") navigate("/student");
      if (parsed.intent === "MY_RESULTS") navigate("/student/results");
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
        <p className="pill" style={{ background: "rgba(255,255,255,0.18)", color: "white" }}>Results</p>
        <h1>{results?.exam_title || "Examination result"}</h1>
        <p>{results ? `${results.percentage}% · ${results.score}/${results.total_marks}` : "Loading score…"}</p>
      </section>
      {error ? <div className="alert" role="alert">{error}</div> : null}
      <div className="grid three" style={{ marginTop: 18 }}>
        <article className="card"><h3>Correct</h3><p>{results?.correct ?? "—"}</p></article>
        <article className="card"><h3>Incorrect</h3><p>{results?.incorrect ?? "—"}</p></article>
        <article className="card"><h3>Unanswered</h3><p>{results?.unanswered ?? "—"}</p></article>
      </div>
      {results?.topic_performance?.length ? (
        <section className="card" style={{ marginTop: 18 }}>
          <h3>Topic performance</h3>
          {results.topic_performance.map((row) => (
            <p key={row.topic}>{row.topic}: {row.percentage}% ({row.score}/{row.total_marks})</p>
          ))}
        </section>
      ) : null}
      {results?.review ? (
        <section className="card" style={{ marginTop: 18 }}>
          <h3>Question review</h3>
          <table className="table">
            <thead>
              <tr><th>#</th><th>Your answer</th><th>Status</th></tr>
            </thead>
            <tbody>
              {results.review.map((row) => (
                <tr key={row.q_number}>
                  <td>{row.q_number}</td>
                  <td>{row.recorded_answer || "—"}</td>
                  <td>{row.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </AppShell>
  );
}
