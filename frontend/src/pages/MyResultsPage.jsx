import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import AppShell from "../components/AppShell";
import { api } from "../api/client";
import { speak } from "../voice/speech";

export default function MyResultsPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api.myResults()
      .then((data) => {
        setRows(data.attempts || []);
        speak(`You have ${data.attempts?.length || 0} completed examinations.`);
      })
      .catch((err) => setError(err.message));
  }, []);

  return (
    <AppShell>
      <h1>My results</h1>
      {error ? <div className="alert" role="alert">{error}</div> : null}
      <table className="table">
        <thead>
          <tr>
            <th>Exam</th>
            <th>Date</th>
            <th>Score</th>
            <th>Percentage</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.session_id}>
              <td>{row.exam?.title || row.exam_id}</td>
              <td>{row.ended_at ? new Date(row.ended_at * 1000).toLocaleString() : "—"}</td>
              <td>{row.results ? `${row.results.score}/${row.results.total_marks}` : "—"}</td>
              <td>{row.results?.percentage ?? "—"}%</td>
              <td>
                <button className="btn ghost" type="button" onClick={() => navigate(`/student/results/${row.session_id}`)}>
                  View details
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? <p className="muted">No completed examinations yet.</p> : null}
    </AppShell>
  );
}
