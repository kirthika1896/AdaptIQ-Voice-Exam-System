import React from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const STUDENT_LINKS = [
  { to: "/student", label: "Dashboard" },
  { to: "/student/exams", label: "Take an Exam" },
  { to: "/student/results", label: "My Results" },
  { to: "/student/voice", label: "Voice Learning" },
];

const ADMIN_LINKS = [
  { to: "/admin", label: "Dashboard" },
  { to: "/admin/exams/new", label: "Create Exam" },
  { to: "/admin/exams", label: "Manage Exams" },
  { to: "/admin/upload", label: "Upload Paper" },
  { to: "/admin/attempts", label: "Results" },
  { to: "/admin/analytics", label: "Analytics" },
];

export default function AppShell({ children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const links = user?.role === "admin" ? ADMIN_LINKS : STUDENT_LINKS;

  const signOut = async () => {
    await logout();
    navigate("/");
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <aside className="sidebar" aria-label="Primary">
        <div className="logo-row">
          <span className="logo-badge">AQ</span>
          AdaptIQ
        </div>
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.to === "/student" || link.to === "/admin"}
            className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
          >
            {link.label}
          </NavLink>
        ))}
        <div className="spacer" />
        <p className="muted" style={{ padding: "0 12px" }}>
          {user?.display_name} · {user?.role}
        </p>
        <button className="btn ghost" type="button" onClick={signOut}>
          Sign out
        </button>
      </aside>
      <main id="main" className="workspace">
        {children}
      </main>
    </div>
  );
}
