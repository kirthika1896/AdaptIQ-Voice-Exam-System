import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import AppShell from "../components/AppShell";
import { api } from "../api/client";

const emptyQuestion = {
  q_number: 1,
  type: "MCQ",
  prompt: "",
  marks: 1,
  topic: "",
  difficulty: "medium",
  correct_answer: "",
  options: [
    { key: "A", text: "" },
    { key: "B", text: "" },
    { key: "C", text: "" },
    { key: "D", text: "" },
  ],
};

export default function AdminExamEditor() {
  const { examId } = useParams();
  const isNew = examId === "new";
  const navigate = useNavigate();
  const [exam, setExam] = useState({
    title: "",
    subject: "General",
    duration_minutes: 60,
    description: "",
  });
  const [questions, setQuestions] = useState([]);
  const [draft, setDraft] = useState(emptyQuestion);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async (id) => {
    const data = await api.adminExam(id);
    setExam(data.exam);
    setQuestions(data.questions || []);
    setDraft((prev) => ({ ...prev, q_number: (data.questions?.length || 0) + 1 }));
  };

  useEffect(() => {
    if (!isNew) load(examId).catch((err) => setError(err.message));
  }, [examId, isNew]);

  const saveExam = async () => {
    setBusy(true);
    setError("");
    try {
      if (isNew) {
        const created = await api.createExam(exam);
        navigate(`/admin/exams/${created.exam.id}`);
      } else {
        const updated = await api.updateExam(examId, exam);
        setExam(updated.exam);
        setNotice("Draft saved.");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const saveQuestion = async () => {
    setBusy(true);
    try {
      const payload = {
        ...draft,
        options: draft.type === "MCQ" ? draft.options.filter((o) => o.text) : [],
        verified: false,
      };
      await api.upsertQuestion(exam.id, payload);
      await load(exam.id);
      setNotice("Question saved as unverified. Verify before publishing.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const verifyAll = async () => {
    try {
      for (const q of questions) {
        if (!q.verified) await api.verifyQuestion(q.id, true);
      }
      await load(exam.id);
      setNotice("All questions verified.");
    } catch (err) {
      setError(err.message);
    }
  };

  const publish = async () => {
    try {
      await api.publishExam(exam.id);
      await load(exam.id);
      setNotice("Exam published. Students can now start it.");
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <AppShell>
      <h1>{isNew ? "Create exam" : "Edit exam"}</h1>
      {error ? <div className="alert" role="alert">{error}</div> : null}
      {notice ? <div className="alert info" role="status">{notice}</div> : null}
      <section className="card">
        <label className="field">Title
          <input value={exam.title} onChange={(e) => setExam({ ...exam, title: e.target.value })} />
        </label>
        <label className="field">Subject
          <input value={exam.subject} onChange={(e) => setExam({ ...exam, subject: e.target.value })} />
        </label>
        <label className="field">Duration (minutes)
          <input type="number" value={exam.duration_minutes} onChange={(e) => setExam({ ...exam, duration_minutes: Number(e.target.value) })} />
        </label>
        <label className="field">Description
          <textarea value={exam.description} onChange={(e) => setExam({ ...exam, description: e.target.value })} />
        </label>
        <button className="btn" type="button" onClick={saveExam} disabled={busy}>{isNew ? "Create draft" : "Save draft"}</button>
      </section>

      {!isNew ? (
        <>
          <section className="card" style={{ marginTop: 18 }}>
            <h3>Add or edit question</h3>
            <label className="field">Number
              <input type="number" value={draft.q_number} onChange={(e) => setDraft({ ...draft, q_number: Number(e.target.value) })} />
            </label>
            <label className="field">Type
              <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
                <option>MCQ</option>
                <option>NUMERICAL</option>
                <option>DESCRIPTIVE</option>
                <option>MATHEMATICS</option>
              </select>
            </label>
            <label className="field">Prompt
              <textarea value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
            </label>
            {draft.type === "MCQ" ? draft.options.map((opt, idx) => (
              <label className="field" key={opt.key}>Option {opt.key}
                <input value={opt.text} onChange={(e) => {
                  const next = [...draft.options];
                  next[idx] = { ...opt, text: e.target.value };
                  setDraft({ ...draft, options: next });
                }} />
              </label>
            )) : null}
            <label className="field">Marks
              <input type="number" value={draft.marks} onChange={(e) => setDraft({ ...draft, marks: Number(e.target.value) })} />
            </label>
            <label className="field">Topic
              <input value={draft.topic} onChange={(e) => setDraft({ ...draft, topic: e.target.value })} />
            </label>
            <label className="field">Correct answer
              <input value={draft.correct_answer} onChange={(e) => setDraft({ ...draft, correct_answer: e.target.value })} />
            </label>
            <button className="btn" type="button" onClick={saveQuestion} disabled={busy}>Save question</button>
          </section>
          <section className="card" style={{ marginTop: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <h3>Questions</h3>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn ghost" type="button" onClick={verifyAll}>Verify all</button>
                <button className="btn" type="button" onClick={publish}>Publish</button>
              </div>
            </div>
            <table className="table">
              <thead>
                <tr><th>#</th><th>Prompt</th><th>Type</th><th>Verified</th><th></th></tr>
              </thead>
              <tbody>
                {questions.map((q) => (
                  <tr key={q.id}>
                    <td>{q.q_number}</td>
                    <td>{q.prompt}</td>
                    <td>{q.type}</td>
                    <td>{q.verified ? "Yes" : "No"}</td>
                    <td style={{ display: "flex", gap: 8 }}>
                      <button className="btn ghost" type="button" onClick={() => setDraft({
                        ...emptyQuestion,
                        ...q,
                        options: q.options?.length ? q.options : emptyQuestion.options,
                        correct_answer: q.correct_answer || "",
                      })}>Edit</button>
                      <button className="btn ghost" type="button" onClick={() => api.verifyQuestion(q.id, !q.verified).then(() => load(exam.id))}>
                        {q.verified ? "Unverify" : "Verify"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : null}
    </AppShell>
  );
}
