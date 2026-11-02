import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import AppShell from "../components/AppShell";
import { api } from "../api/client";

export default function AdminDashboard() {
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.adminStats().then(setStats).catch((err) => setError(err.message));
  }, []);

  const cards = [
    ["Total exams", stats?.total_exams],
    ["Published", stats?.published_exams],
    ["Drafts", stats?.draft_exams],
    ["Student attempts", stats?.student_attempts],
    ["Completed", stats?.submitted_attempts],
  ];

  return (
    <AppShell>
      <section className="hero">
        <h1>Admin dashboard</h1>
        <p>Create, verify, and publish examinations. Monitor student attempts.</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          <button className="btn" style={{ background: "white", color: "#4338ca" }} onClick={() => navigate("/admin/exams/new")}>Create exam</button>
          <button className="btn ghost" onClick={() => navigate("/admin/upload")}>Upload paper</button>
          <button className="btn ghost" onClick={() => navigate("/admin/attempts")}>Results</button>
        </div>
      </section>
      {error ? <div className="alert" role="alert">{error}</div> : null}
      <div className="grid three" style={{ marginTop: 18 }}>
        {cards.map(([label, value]) => (
          <article className="card" key={label}>
            <p className="muted">{label}</p>
            <h2>{value ?? "—"}</h2>
          </article>
        ))}
      </div>
    </AppShell>
  );
}
