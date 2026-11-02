import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import AppShell from "../components/AppShell";
import { api } from "../api/client";

export default function AdminExamListPage() {
  const navigate = useNavigate();
  const [exams, setExams] = useState([]);
  const [error, setError] = useState("");

  const load = () => api.adminExams().then((d) => setExams(d.exams || [])).catch((err) => setError(err.message));
  useEffect(() => { load(); }, []);

  const publish = async (id) => {
    try {
      await api.publishExam(id);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <AppShell>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <h1>Manage exams</h1>
        <button className="btn" type="button" onClick={() => navigate("/admin/exams/new")}>Create exam</button>
      </div>
      {error ? <div className="alert" role="alert">{error}</div> : null}
      <table className="table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Status</th>
            <th>Questions</th>
            <th>Verified</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {exams.map((exam) => (
            <tr key={exam.id}>
              <td>{exam.title}</td>
              <td>{exam.status}</td>
              <td>{exam.question_count}</td>
              <td>{exam.verified_count}</td>
              <td style={{ display: "flex", gap: 8 }}>
                <button className="btn ghost" type="button" onClick={() => navigate(`/admin/exams/${exam.id}`)}>Questions</button>
                <button className="btn" type="button" onClick={() => publish(exam.id)}>Publish</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </AppShell>
  );
}
