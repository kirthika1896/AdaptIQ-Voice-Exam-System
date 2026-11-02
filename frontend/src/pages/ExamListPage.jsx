import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import AppShell from "../components/AppShell";
import VoicePanel from "../components/VoicePanel";
import { api } from "../api/client";
import { useVoice } from "../hooks/useVoice";
import { matchExamByTitle, parseAppIntent } from "../voice/appIntent";
import { speak } from "../voice/speech";

export default function ExamListPage() {
  const navigate = useNavigate();
  const [exams, setExams] = useState([]);
  const [error, setError] = useState("");
  const [response, setResponse] = useState("");

  useEffect(() => {
    api.listExams()
      .then((data) => {
        setExams(data.exams || []);
        const msg = `There are ${data.exams?.length || 0} published examinations.`;
        setResponse(msg);
        speak(msg);
      })
      .catch((err) => setError(err.message));
  }, []);

  const start = async (exam) => {
    if (!exam) return;
    const data = await api.startSession(exam.id);
    navigate(`/student/exam/${data.session.session_id}`, { state: { speak: data.speak } });
  };

  const voice = useVoice({
    onFinalTranscript: async (text) => {
      const parsed = parseAppIntent(text);
      if (parsed.intent === "START_EXAM_INDEX") return start(exams[parsed.index]);
      if (parsed.intent === "START_EXAM_NAMED") {
        const exam = matchExamByTitle(exams, parsed.title);
        if (exam) return start(exam);
        const message = `I couldn't identify one unique exam matching ${parsed.title}. Please choose an exam by its full name.`;
        setResponse(message);
        await speak(message);
        return;
      }
      if (parsed.intent === "START_EXAM") {
        const message = exams.length
          ? `Which examination would you like to take? Available exams are: ${exams.map((exam) => exam.title).join(", ")}. Please choose one by name.`
          : "There are no published examinations available right now.";
        setResponse(message);
        await speak(message);
        return;
      }
      if (parsed.intent === "GO_DASHBOARD") return navigate("/student");
      const message = "I didn't understand which examination you want. Please choose one by name or use its Start button.";
      setResponse(message);
      await speak(message);
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
      <h1>Take an exam</h1>
      <div className="exam-list">
        {exams.map((exam) => (
          <article key={exam.id} className="exam-item card" style={{ margin: 0 }}>
            <div>
              <h3>{exam.title}</h3>
              <p>{exam.description || exam.subject}</p>
              <p className="muted">{exam.duration_minutes} minutes · {exam.question_count} questions · {exam.status}</p>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn ghost" type="button" onClick={() => navigate(`/student/exams/${exam.id}`)}>Details</button>
              <button className="btn" type="button" onClick={() => start(exam)}>Start</button>
            </div>
          </article>
        ))}
      </div>
    </AppShell>
  );
}
