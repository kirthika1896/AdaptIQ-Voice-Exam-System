"""
Layer 4 — SQLite persistence for Voice Adapter System.
Preserves the original exam/session/response contract and extends it with
users, auth tokens, exam publishing, question metadata, and scoring keys.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Optional

DB_PATH = Path(os.getenv("DATABASE_PATH", str(Path(__file__).resolve().parent / "exam_system.db"))).expanduser()
DEMO_EXAM_ID = "demo_exam_2026"
PBKDF_ITERS = 120_000


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def row_to_dict(row: Optional[sqlite3.Row]) -> Optional[dict[str, Any]]:
    if row is None:
        return None
    return dict(row)


def _hash_password(password: str, salt: Optional[str] = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF_ITERS
    ).hex()
    return f"{salt}${digest}"


def verify_password(password: str, stored: str) -> bool:
    if not stored or "$" not in stored:
        return False
    salt, _digest = stored.split("$", 1)
    return secrets.compare_digest(_hash_password(password, salt), stored)


def _create_schemas(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('student', 'admin')),
            display_name TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL UNIQUE,
            registration_number TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS auth_tokens (
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            created_at REAL NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS exams (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            subject TEXT NOT NULL,
            duration_minutes INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft',
            description TEXT NOT NULL DEFAULT '',
            created_by TEXT
        );

        CREATE TABLE IF NOT EXISTS questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_id TEXT NOT NULL,
            q_number INTEGER NOT NULL,
            type TEXT NOT NULL,
            prompt TEXT NOT NULL,
            math_latex TEXT,
            audio_text TEXT NOT NULL,
            marks REAL NOT NULL DEFAULT 1,
            options_json TEXT NOT NULL DEFAULT '[]',
            topic TEXT NOT NULL DEFAULT '',
            difficulty TEXT NOT NULL DEFAULT 'medium',
            verified INTEGER NOT NULL DEFAULT 0,
            correct_answer TEXT,
            FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
            UNIQUE (exam_id, q_number)
        );

        CREATE TABLE IF NOT EXISTS exam_sessions (
            session_id TEXT PRIMARY KEY,
            exam_id TEXT NOT NULL,
            current_question INTEGER NOT NULL DEFAULT 1,
            time_remaining_seconds INTEGER NOT NULL,
            duration_seconds INTEGER NOT NULL DEFAULT 0,
            marked_questions TEXT NOT NULL DEFAULT '[]',
            is_submitted INTEGER NOT NULL DEFAULT 0,
            user_id TEXT,
            started_at REAL,
            ended_at REAL,
            status TEXT NOT NULL DEFAULT 'in_progress',
            pending_submit INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS responses (
            session_id TEXT NOT NULL,
            question_number INTEGER NOT NULL,
            recorded_answer TEXT,
            math_steps_json TEXT NOT NULL DEFAULT '[]',
            spoken_transcript TEXT,
            parsed_expression TEXT,
            correctness INTEGER,
            PRIMARY KEY (session_id, question_number),
            FOREIGN KEY (session_id) REFERENCES exam_sessions(session_id) ON DELETE CASCADE
        );
        """
    )


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _add_column(conn: sqlite3.Connection, table: str, name: str, ddl: str) -> None:
    if name not in _table_columns(conn, table):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


def _migrate(conn: sqlite3.Connection) -> None:
    if "exams" in {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}:
        _add_column(conn, "exams", "description", "description TEXT NOT NULL DEFAULT ''")
        _add_column(conn, "exams", "created_by", "created_by TEXT")
        _add_column(conn, "questions", "options_json", "options_json TEXT NOT NULL DEFAULT '[]'")
        _add_column(conn, "questions", "topic", "topic TEXT NOT NULL DEFAULT ''")
        _add_column(conn, "questions", "difficulty", "difficulty TEXT NOT NULL DEFAULT 'medium'")
        _add_column(conn, "questions", "verified", "verified INTEGER NOT NULL DEFAULT 0")
        _add_column(conn, "questions", "correct_answer", "correct_answer TEXT")
        _add_column(conn, "exam_sessions", "user_id", "user_id TEXT")
        _add_column(conn, "exam_sessions", "duration_seconds", "duration_seconds INTEGER NOT NULL DEFAULT 0")
        _add_column(conn, "exam_sessions", "started_at", "started_at REAL")
        _add_column(conn, "exam_sessions", "ended_at", "ended_at REAL")
        _add_column(conn, "exam_sessions", "status", "status TEXT NOT NULL DEFAULT 'in_progress'")
        _add_column(conn, "exam_sessions", "pending_submit", "pending_submit INTEGER NOT NULL DEFAULT 0")
        _add_column(conn, "responses", "spoken_transcript", "spoken_transcript TEXT")
        _add_column(conn, "responses", "parsed_expression", "parsed_expression TEXT")
        _add_column(conn, "responses", "correctness", "correctness INTEGER")
        conn.execute(
            "UPDATE exams SET status = 'published' WHERE status IN ('active', 'published')"
        )
        sessions = conn.execute(
            "SELECT session_id, exam_id, time_remaining_seconds, duration_seconds, started_at, is_submitted FROM exam_sessions"
        ).fetchall()
        for session in sessions:
            if session["duration_seconds"] > 0:
                continue
            duration = conn.execute(
                "SELECT duration_minutes FROM exams WHERE id = ?",
                (session["exam_id"],),
            ).fetchone()
            if not duration:
                continue
            duration_seconds = int(duration["duration_minutes"]) * 60
            started_at = session["started_at"]
            if not started_at and not session["is_submitted"]:
                elapsed = max(0, duration_seconds - int(session["time_remaining_seconds"]))
                started_at = time.time() - elapsed
            conn.execute(
                "UPDATE exam_sessions SET duration_seconds = ?, started_at = ? WHERE session_id = ?",
                (duration_seconds, started_at, session["session_id"]),
            )


def _seed_users(conn: sqlite3.Connection) -> None:
    seeds = [
        ("user-admin", "admin", os.getenv("DEMO_ADMIN_PASSWORD"), "admin", "System Administrator"),
        ("user-student", "student", os.getenv("DEMO_STUDENT_PASSWORD"), "student", "Demo Student"),
    ]
    for uid, username, password, role, name in seeds:
        if not password:
            continue
        existing = conn.execute(
            "SELECT id FROM users WHERE username = ?", (username,)
        ).fetchone()
        if existing:
            continue
        conn.execute(
            """
            INSERT INTO users (id, username, password_hash, role, display_name)
            VALUES (?, ?, ?, ?, ?)
            """,
            (uid, username, _hash_password(password), role, name),
        )


def _bootstrap_admin(conn: sqlite3.Connection) -> None:
    username = os.getenv("BOOTSTRAP_ADMIN_USERNAME", "").strip()
    password = os.getenv("BOOTSTRAP_ADMIN_PASSWORD", "")
    if not username or not password:
        return
    if conn.execute("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").fetchone():
        return
    if conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
        return
    conn.execute(
        "INSERT INTO users (id, username, password_hash, role, display_name) VALUES (?, ?, ?, 'admin', ?)",
        (str(uuid.uuid4()), username, _hash_password(password), username),
    )


def _seed_demo_exam(conn: sqlite3.Connection) -> None:
    existing = conn.execute(
        "SELECT id FROM exams WHERE id = ?", (DEMO_EXAM_ID,)
    ).fetchone()
    if existing:
        return

    conn.execute(
        """
        INSERT INTO exams (id, title, subject, duration_minutes, status, description, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            DEMO_EXAM_ID,
            "Hands-Free Accessibility Demo Examination 2026",
            "Mathematics & Reasoning",
            90,
            "published",
            "Voice-first demonstration paper with MCQ, numerical, and mathematics items.",
            "user-admin",
        ),
    )

    questions = [
        {
            "exam_id": DEMO_EXAM_ID,
            "q_number": 1,
            "type": "MCQ",
            "prompt": "Which of the following is a prime number?",
            "math_latex": None,
            "audio_text": (
                "Question 1. Multiple choice. Which of the following is a prime number? "
                "Option A: fifteen. Option B: twenty one. Option C: seventeen. Option D: twenty seven."
            ),
            "marks": 2.0,
            "options_json": json.dumps(
                [
                    {"key": "A", "text": "15"},
                    {"key": "B", "text": "21"},
                    {"key": "C", "text": "17"},
                    {"key": "D", "text": "27"},
                ]
            ),
            "topic": "Number theory",
            "difficulty": "easy",
            "verified": 1,
            "correct_answer": "C",
        },
        {
            "exam_id": DEMO_EXAM_ID,
            "q_number": 2,
            "type": "NUMERICAL",
            "prompt": "Evaluate 7 × 8 − 6. Enter the numerical answer.",
            "math_latex": None,
            "audio_text": (
                "Question 2. Numerical. Evaluate seven times eight minus six. "
                "Speak your numerical answer."
            ),
            "marks": 2.0,
            "options_json": "[]",
            "topic": "Arithmetic",
            "difficulty": "easy",
            "verified": 1,
            "correct_answer": "50",
        },
        {
            "exam_id": DEMO_EXAM_ID,
            "q_number": 3,
            "type": "DESCRIPTIVE",
            "prompt": "In one or two sentences, explain why accessibility matters in digital examinations.",
            "math_latex": None,
            "audio_text": (
                "Question 3. Descriptive. In one or two sentences, explain why accessibility "
                "matters in digital examinations. Dictate your answer."
            ),
            "marks": 3.0,
            "options_json": "[]",
            "topic": "Accessibility",
            "difficulty": "medium",
            "verified": 1,
            "correct_answer": None,
        },
        {
            "exam_id": DEMO_EXAM_ID,
            "q_number": 17,
            "type": "MATHEMATICS",
            "prompt": "Solve the quadratic equation: x² + 5x − 6 = 0. Show your working steps.",
            "math_latex": "x^2 + 5x - 6 = 0",
            "audio_text": (
                "Question 17. Mathematics. Solve the quadratic equation: "
                "x squared plus five x minus six equals zero. Speak each algebraic step."
            ),
            "marks": 5.0,
            "options_json": "[]",
            "topic": "Algebra",
            "difficulty": "medium",
            "verified": 1,
            "correct_answer": "x = 1, x = -6",
        },
    ]
    for q in questions:
        conn.execute(
            """
            INSERT INTO questions
                (exam_id, q_number, type, prompt, math_latex, audio_text, marks,
                 options_json, topic, difficulty, verified, correct_answer)
            VALUES (:exam_id, :q_number, :type, :prompt, :math_latex, :audio_text, :marks,
                    :options_json, :topic, :difficulty, :verified, :correct_answer)
            """,
            q,
        )


def initialize_database() -> None:
    conn = get_connection()
    try:
        _create_schemas(conn)
        _migrate(conn)
        if os.getenv("ENABLE_DEMO_SEED", "").strip().lower() == "true":
            _seed_users(conn)
            _seed_demo_exam(conn)
        _bootstrap_admin(conn)
        conn.execute(
            """
            INSERT OR IGNORE INTO students (user_id, registration_number, name)
            SELECT id, 'LEGACY-' || id, display_name
            FROM users
            WHERE role = 'student'
            """
        )
        conn.commit()
    finally:
        conn.close()


def _decode_question(row: dict[str, Any], *, include_key: bool) -> dict[str, Any]:
    q = dict(row)
    try:
        q["options"] = json.loads(q.get("options_json") or "[]")
    except json.JSONDecodeError:
        q["options"] = []
    if not q["options"] and str(q.get("type", "")).upper() == "MCQ":
        prompt = str(q.get("prompt") or "")
        option_matches = list(
            re.finditer(
                r"(?:^|\s)([A-D])\s*[)\].:\-]\s*(.*?)(?=\s+[A-D]\s*[)\].:\-]\s*|$)",
                prompt,
                flags=re.IGNORECASE,
            )
        )
        if len(option_matches) >= 2:
            q["options"] = [
                {"key": match.group(1).upper(), "text": match.group(2).strip()}
                for match in option_matches
            ]
            first_option = re.search(r"(?:^|\s)[A-D]\s*[)\].:\-]", prompt, re.IGNORECASE)
            if first_option:
                q["prompt"] = prompt[: first_option.start()].rstrip()
    q["verified"] = bool(q.get("verified"))
    if not include_key:
        q.pop("correct_answer", None)
    return q


# ---- Users / auth -----------------------------------------------------------


def get_user_by_username(username: str) -> Optional[dict[str, Any]]:
    conn = get_connection()
    try:
        return row_to_dict(
            conn.execute(
                "SELECT * FROM users WHERE lower(username) = lower(?)", (username,)
            ).fetchone()
        )
    finally:
        conn.close()


def get_user_by_student_identifier(identifier: str) -> Optional[dict[str, Any]]:
    conn = get_connection()
    try:
        return row_to_dict(
            conn.execute(
                """
                SELECT u.* FROM users u
                JOIN students s ON s.user_id = u.id
                WHERE lower(s.registration_number) = lower(?)
                """,
                (identifier.strip(),),
            ).fetchone()
        )
    finally:
        conn.close()


def register_student(
    *,
    username: str,
    password: str,
    registration_number: str,
    name: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    username = username.strip().lower()
    registration_number = registration_number.strip()
    name = name.strip()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{2,49}", username):
        raise ValueError(
            "Username must be 3-50 characters and contain only letters, numbers, '.', '_' or '-'."
        )
    if len(password) < 8:
        raise ValueError("Password must contain at least 8 characters.")
    if not registration_number or len(registration_number) > 64:
        raise ValueError("Registration number must contain 1-64 characters.")
    if not name or len(name) > 120:
        raise ValueError("Student name must contain 1-120 characters.")

    conn = get_connection()
    try:
        conn.execute("BEGIN IMMEDIATE")
        if conn.execute(
            "SELECT 1 FROM users WHERE lower(username) = lower(?)", (username,)
        ).fetchone():
            raise ValueError("Username already exists.")
        if conn.execute(
            "SELECT 1 FROM students WHERE lower(registration_number) = lower(?)",
            (registration_number,),
        ).fetchone():
            raise ValueError("Registration number already exists.")

        user_id = str(uuid.uuid4())
        conn.execute(
            """
            INSERT INTO users (id, username, password_hash, role, display_name)
            VALUES (?, ?, ?, 'student', ?)
            """,
            (user_id, username, _hash_password(password), name),
        )
        conn.execute(
            """
            INSERT INTO students (user_id, registration_number, name)
            VALUES (?, ?, ?)
            """,
            (user_id, registration_number, name),
        )
        conn.commit()
        user = row_to_dict(
            conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        )
        student = row_to_dict(
            conn.execute("SELECT * FROM students WHERE user_id = ?", (user_id,)).fetchone()
        )
        if not user or not student:
            raise RuntimeError("Student registration did not persist correctly.")
        return user, student
    except sqlite3.IntegrityError as exc:
        conn.rollback()
        raise ValueError("Username or registration number already exists.") from exc
    finally:
        conn.close()


def get_student_by_user(user_id: str) -> Optional[dict[str, Any]]:
    conn = get_connection()
    try:
        return row_to_dict(
            conn.execute("SELECT * FROM students WHERE user_id = ?", (user_id,)).fetchone()
        )
    finally:
        conn.close()


def get_user(user_id: str) -> Optional[dict[str, Any]]:
    conn = get_connection()
    try:
        return row_to_dict(
            conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        )
    finally:
        conn.close()


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": user["id"],
        "username": user["username"],
        "role": user["role"],
        "display_name": user["display_name"],
    }


def create_token(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    conn = get_connection()
    try:
        conn.execute(
            "INSERT INTO auth_tokens (token, user_id, created_at) VALUES (?, ?, ?)",
            (token, user_id, time.time()),
        )
        conn.commit()
    finally:
        conn.close()
    return token


def get_user_by_token(token: str) -> Optional[dict[str, Any]]:
    conn = get_connection()
    try:
        row = conn.execute(
            """
            SELECT u.* FROM users u
            JOIN auth_tokens t ON t.user_id = u.id
            WHERE t.token = ?
            """,
            (token,),
        ).fetchone()
        return row_to_dict(row)
    finally:
        conn.close()


def delete_token(token: str) -> None:
    conn = get_connection()
    try:
        conn.execute("DELETE FROM auth_tokens WHERE token = ?", (token,))
        conn.commit()
    finally:
        conn.close()


# ---- Exams / questions ------------------------------------------------------


def list_exams(*, published_only: bool = False) -> list[dict[str, Any]]:
    conn = get_connection()
    try:
        if published_only:
            rows = conn.execute(
                "SELECT * FROM exams WHERE status = 'published' ORDER BY title"
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM exams ORDER BY title").fetchall()
        exams = [dict(r) for r in rows]
        for exam in exams:
            exam["question_count"] = conn.execute(
                "SELECT COUNT(*) FROM questions WHERE exam_id = ?", (exam["id"],)
            ).fetchone()[0]
            exam["verified_count"] = conn.execute(
                "SELECT COUNT(*) FROM questions WHERE exam_id = ? AND verified = 1",
                (exam["id"],),
            ).fetchone()[0]
        return exams
    finally:
        conn.close()


def get_exam(exam_id: str = DEMO_EXAM_ID) -> Optional[dict[str, Any]]:
    conn = get_connection()
    try:
        exam = row_to_dict(
            conn.execute("SELECT * FROM exams WHERE id = ?", (exam_id,)).fetchone()
        )
        if exam:
            exam["question_count"] = conn.execute(
                "SELECT COUNT(*) FROM questions WHERE exam_id = ?", (exam_id,)
            ).fetchone()[0]
        return exam
    finally:
        conn.close()


def create_exam(
    *,
    title: str,
    subject: str,
    duration_minutes: int,
    description: str = "",
    created_by: Optional[str] = None,
) -> dict[str, Any]:
    exam_id = str(uuid.uuid4())
    conn = get_connection()
    try:
        conn.execute(
            """
            INSERT INTO exams (id, title, subject, duration_minutes, status, description, created_by)
            VALUES (?, ?, ?, ?, 'draft', ?, ?)
            """,
            (exam_id, title, subject, int(duration_minutes), description, created_by),
        )
        conn.commit()
    finally:
        conn.close()
    return get_exam(exam_id)  # type: ignore[return-value]


def update_exam(exam_id: str, **fields: Any) -> Optional[dict[str, Any]]:
    allowed = {"title", "subject", "duration_minutes", "status", "description"}
    sets = []
    values: list[Any] = []
    for key, value in fields.items():
        if key in allowed and value is not None:
            sets.append(f"{key} = ?")
            values.append(value)
    if not sets:
        return get_exam(exam_id)
    values.append(exam_id)
    conn = get_connection()
    try:
        conn.execute(f"UPDATE exams SET {', '.join(sets)} WHERE id = ?", values)
        conn.commit()
    finally:
        conn.close()
    return get_exam(exam_id)


def get_questions(exam_id: str = DEMO_EXAM_ID, *, include_key: bool = False) -> list[dict[str, Any]]:
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM questions WHERE exam_id = ? ORDER BY q_number ASC",
            (exam_id,),
        ).fetchall()
        return [_decode_question(dict(r), include_key=include_key) for r in rows]
    finally:
        conn.close()


def get_question(exam_id: str, q_number: int, *, include_key: bool = False) -> Optional[dict[str, Any]]:
    conn = get_connection()
    try:
        row = row_to_dict(
            conn.execute(
                "SELECT * FROM questions WHERE exam_id = ? AND q_number = ?",
                (exam_id, q_number),
            ).fetchone()
        )
        return _decode_question(row, include_key=include_key) if row else None
    finally:
        conn.close()


def get_question_by_id(question_id: int, *, include_key: bool = True) -> Optional[dict[str, Any]]:
    conn = get_connection()
    try:
        row = row_to_dict(
            conn.execute("SELECT * FROM questions WHERE id = ?", (question_id,)).fetchone()
        )
        return _decode_question(row, include_key=include_key) if row else None
    finally:
        conn.close()


def upsert_question(exam_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    q_number = int(payload["q_number"])
    options = payload.get("options") or []
    audio = payload.get("audio_text") or f"Question {q_number}. {payload.get('prompt') or ''}"
    conn = get_connection()
    try:
        existing = conn.execute(
            "SELECT id FROM questions WHERE exam_id = ? AND q_number = ?",
            (exam_id, q_number),
        ).fetchone()
        fields = {
            "exam_id": exam_id,
            "q_number": q_number,
            "type": payload.get("type") or "DESCRIPTIVE",
            "prompt": payload.get("prompt") or "",
            "math_latex": payload.get("math_latex"),
            "audio_text": audio,
            "marks": float(payload.get("marks") or 1),
            "options_json": json.dumps(options),
            "topic": payload.get("topic") or "",
            "difficulty": payload.get("difficulty") or "medium",
            "verified": 1 if payload.get("verified") else 0,
            "correct_answer": payload.get("correct_answer"),
        }
        if existing:
            conn.execute(
                """
                UPDATE questions SET
                    type=:type, prompt=:prompt, math_latex=:math_latex, audio_text=:audio_text,
                    marks=:marks, options_json=:options_json, topic=:topic,
                    difficulty=:difficulty, verified=:verified, correct_answer=:correct_answer
                WHERE exam_id=:exam_id AND q_number=:q_number
                """,
                fields,
            )
        else:
            conn.execute(
                """
                INSERT INTO questions
                    (exam_id, q_number, type, prompt, math_latex, audio_text, marks,
                     options_json, topic, difficulty, verified, correct_answer)
                VALUES
                    (:exam_id, :q_number, :type, :prompt, :math_latex, :audio_text, :marks,
                     :options_json, :topic, :difficulty, :verified, :correct_answer)
                """,
                fields,
            )
        conn.commit()
    finally:
        conn.close()
    return get_question(exam_id, q_number, include_key=True)  # type: ignore[return-value]


def delete_exam(exam_id: str) -> bool:
    conn = get_connection()
    try:
        cur = conn.execute("DELETE FROM exams WHERE id = ?", (exam_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def delete_question(question_id: int) -> bool:
    conn = get_connection()
    try:
        cur = conn.execute("DELETE FROM questions WHERE id = ?", (question_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def set_question_verified(question_id: int, verified: bool) -> Optional[dict[str, Any]]:
    conn = get_connection()
    try:
        conn.execute(
            "UPDATE questions SET verified = ? WHERE id = ?",
            (1 if verified else 0, question_id),
        )
        conn.commit()
    finally:
        conn.close()
    return get_question_by_id(question_id)


def replace_questions(exam_id: str, questions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    conn = get_connection()
    try:
        conn.execute("DELETE FROM questions WHERE exam_id = ?", (exam_id,))
        conn.commit()
    finally:
        conn.close()
    out = []
    for q in questions:
        out.append(upsert_question(exam_id, q))
    return out


# ---- Sessions / responses ---------------------------------------------------


def _hydrate_session(row: dict[str, Any]) -> dict[str, Any]:
    row["marked_questions"] = json.loads(row.get("marked_questions") or "[]")
    row["is_submitted"] = bool(row.get("is_submitted"))
    row["pending_submit"] = bool(row.get("pending_submit"))
    started = row.get("started_at")
    exam = None
    conn = get_connection()
    try:
        exam = row_to_dict(
            conn.execute("SELECT duration_minutes FROM exams WHERE id = ?", (row["exam_id"],)).fetchone()
        )
    finally:
        conn.close()
    if started and exam and not row["is_submitted"]:
        total = int(row.get("duration_seconds") or int(exam["duration_minutes"]) * 60)
        remaining = max(0, total - int(time.time() - float(started)))
        row["time_remaining_seconds"] = remaining
    return row


def create_session(exam_id: str = DEMO_EXAM_ID, user_id: Optional[str] = None) -> dict[str, Any]:
    exam = get_exam(exam_id)
    if not exam:
        raise ValueError(f"Exam not found: {exam_id}")
    if user_id and exam.get("status") != "published":
        raise PermissionError("This examination is not published.")
    session_id = str(uuid.uuid4())
    time_remaining = int(exam["duration_minutes"]) * 60
    questions = get_questions(exam_id)
    if not questions:
        raise ValueError("This examination has no questions.")
    first_q = questions[0]["q_number"]
    now = time.time()
    conn = get_connection()
    try:
        conn.execute(
            """
            INSERT INTO exam_sessions
                (session_id, exam_id, current_question, time_remaining_seconds, duration_seconds,
                 marked_questions, is_submitted, user_id, started_at, status, pending_submit)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'in_progress', 0)
            """,
            (session_id, exam_id, first_q, time_remaining, time_remaining, "[]", user_id, now),
        )
        conn.commit()
    finally:
        conn.close()
    return get_session(session_id)  # type: ignore[return-value]


def get_active_session(user_id: str, exam_id: Optional[str] = None) -> Optional[dict[str, Any]]:
    conn = get_connection()
    try:
        if exam_id:
            row = row_to_dict(
                conn.execute(
                    """
                    SELECT * FROM exam_sessions
                    WHERE user_id = ? AND exam_id = ? AND is_submitted = 0
                    ORDER BY started_at DESC LIMIT 1
                    """,
                    (user_id, exam_id),
                ).fetchone()
            )
        else:
            row = row_to_dict(
                conn.execute(
                    """
                    SELECT * FROM exam_sessions
                    WHERE user_id = ? AND is_submitted = 0
                    ORDER BY started_at DESC LIMIT 1
                    """,
                    (user_id,),
                ).fetchone()
            )
        return _hydrate_session(row) if row else None
    finally:
        conn.close()


def list_user_sessions(user_id: str, *, submitted_only: bool = False) -> list[dict[str, Any]]:
    conn = get_connection()
    try:
        if submitted_only:
            rows = conn.execute(
                """
                SELECT * FROM exam_sessions
                WHERE user_id = ? AND is_submitted = 1
                ORDER BY ended_at DESC, started_at DESC
                """,
                (user_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT * FROM exam_sessions
                WHERE user_id = ?
                ORDER BY started_at DESC
                """,
                (user_id,),
            ).fetchall()
        results = []
        for r in rows:
            item = _hydrate_session(dict(r))
            exam = get_exam(item["exam_id"])
            item["exam"] = exam
            if item.get("is_submitted"):
                try:
                    item["results"] = compute_results(item["session_id"])
                except Exception:
                    item["results"] = None
            results.append(item)
        return results
    finally:
        conn.close()


def list_sessions(*, exam_id: Optional[str] = None) -> list[dict[str, Any]]:
    conn = get_connection()
    try:
        if exam_id:
            rows = conn.execute(
                "SELECT * FROM exam_sessions WHERE exam_id = ? ORDER BY started_at DESC",
                (exam_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM exam_sessions ORDER BY started_at DESC"
            ).fetchall()
        results = []
        for r in rows:
            item = _hydrate_session(dict(r))
            user = get_user(item["user_id"]) if item.get("user_id") else None
            item["student"] = public_user(user) if user else None
            results.append(item)
        return results
    finally:
        conn.close()


def get_session(session_id: str) -> Optional[dict[str, Any]]:
    conn = get_connection()
    try:
        row = row_to_dict(
            conn.execute(
                "SELECT * FROM exam_sessions WHERE session_id = ?", (session_id,)
            ).fetchone()
        )
        return _hydrate_session(row) if row else None
    finally:
        conn.close()


def persist_timer(session_id: str) -> Optional[dict[str, Any]]:
    session = get_session(session_id)
    if not session:
        return None
    conn = get_connection()
    try:
        conn.execute(
            "UPDATE exam_sessions SET time_remaining_seconds = ? WHERE session_id = ?",
            (session["time_remaining_seconds"], session_id),
        )
        conn.commit()
    finally:
        conn.close()
    return get_session(session_id)


def update_session(
    session_id: str,
    *,
    current_question: Optional[int] = None,
    time_remaining_seconds: Optional[int] = None,
    marked_questions: Optional[list[int]] = None,
    is_submitted: Optional[bool] = None,
    pending_submit: Optional[bool] = None,
    status: Optional[str] = None,
    ended_at: Optional[float] = None,
) -> Optional[dict[str, Any]]:
    session = get_session(session_id)
    if not session:
        return None
    if current_question is not None:
        session["current_question"] = current_question
    if time_remaining_seconds is not None:
        session["time_remaining_seconds"] = time_remaining_seconds
    if marked_questions is not None:
        session["marked_questions"] = marked_questions
    if is_submitted is not None:
        session["is_submitted"] = is_submitted
        if is_submitted:
            session["status"] = "submitted"
            session["ended_at"] = time.time()
            session["pending_submit"] = False
    if pending_submit is not None:
        session["pending_submit"] = pending_submit
    if status is not None:
        session["status"] = status
    if ended_at is not None:
        session["ended_at"] = ended_at

    conn = get_connection()
    try:
        conn.execute(
            """
            UPDATE exam_sessions
            SET current_question = ?,
                time_remaining_seconds = ?,
                marked_questions = ?,
                is_submitted = ?,
                pending_submit = ?,
                status = ?,
                ended_at = ?
            WHERE session_id = ?
            """,
            (
                session["current_question"],
                session["time_remaining_seconds"],
                json.dumps(session["marked_questions"]),
                1 if session["is_submitted"] else 0,
                1 if session["pending_submit"] else 0,
                session.get("status") or "in_progress",
                session.get("ended_at"),
                session_id,
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return get_session(session_id)


def upsert_response(
    session_id: str,
    question_number: int,
    recorded_answer: Optional[str] = None,
    math_steps: Optional[list[dict[str, Any]]] = None,
    spoken_transcript: Optional[str] = None,
    parsed_expression: Optional[str] = None,
    correctness: Optional[bool] = None,
    clear: bool = False,
) -> dict[str, Any]:
    conn = get_connection()
    try:
        existing = conn.execute(
            """
            SELECT recorded_answer, math_steps_json, spoken_transcript,
                   parsed_expression, correctness
            FROM responses
            WHERE session_id = ? AND question_number = ?
            """,
            (session_id, question_number),
        ).fetchone()
        if clear:
            answer = None
            steps: list[Any] = []
            spoken = None
            expression = None
            is_correct = None
        elif existing:
            answer = (
                recorded_answer
                if recorded_answer is not None
                else existing["recorded_answer"]
            )
            steps = (
                math_steps
                if math_steps is not None
                else json.loads(existing["math_steps_json"] or "[]")
            )
            spoken = (
                spoken_transcript
                if spoken_transcript is not None
                else existing["spoken_transcript"]
            )
            if recorded_answer is not None:
                expression = parsed_expression
                is_correct = int(correctness) if correctness is not None else None
            else:
                expression = (
                    parsed_expression
                    if parsed_expression is not None
                    else existing["parsed_expression"]
                )
                is_correct = (
                    int(correctness)
                    if correctness is not None
                    else existing["correctness"]
                )
        else:
            answer = recorded_answer
            steps = math_steps or []
            spoken = spoken_transcript
            expression = parsed_expression
            is_correct = int(correctness) if correctness is not None else None

        if existing:
            conn.execute(
                """
                UPDATE responses
                SET recorded_answer = ?, math_steps_json = ?, spoken_transcript = ?,
                    parsed_expression = ?, correctness = ?
                WHERE session_id = ? AND question_number = ?
                """,
                (
                    answer,
                    json.dumps(steps),
                    spoken,
                    expression,
                    is_correct,
                    session_id,
                    question_number,
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO responses
                    (session_id, question_number, recorded_answer, math_steps_json,
                     spoken_transcript, parsed_expression, correctness)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    question_number,
                    answer,
                    json.dumps(steps),
                    spoken,
                    expression,
                    is_correct,
                ),
            )
        conn.commit()
        row = conn.execute(
            """
            SELECT * FROM responses
            WHERE session_id = ? AND question_number = ?
            """,
            (session_id, question_number),
        ).fetchone()
        result = dict(row)
        result["math_steps_json"] = json.loads(result["math_steps_json"] or "[]")
        return result
    finally:
        conn.close()


def get_response(session_id: str, question_number: int) -> Optional[dict[str, Any]]:
    conn = get_connection()
    try:
        row = row_to_dict(
            conn.execute(
                """
                SELECT * FROM responses
                WHERE session_id = ? AND question_number = ?
                """,
                (session_id, question_number),
            ).fetchone()
        )
        if row:
            row["math_steps_json"] = json.loads(row["math_steps_json"] or "[]")
            if row.get("correctness") is not None:
                row["correctness"] = bool(row["correctness"])
        return row
    finally:
        conn.close()


def get_all_responses(session_id: str) -> list[dict[str, Any]]:
    conn = get_connection()
    try:
        rows = conn.execute(
            """
            SELECT * FROM responses
            WHERE session_id = ?
            ORDER BY question_number ASC
            """,
            (session_id,),
        ).fetchall()
        results = []
        for r in rows:
            d = dict(r)
            d["math_steps_json"] = json.loads(d["math_steps_json"] or "[]")
            if d.get("correctness") is not None:
                d["correctness"] = bool(d["correctness"])
            results.append(d)
        return results
    finally:
        conn.close()


def get_unanswered_questions(session_id: str) -> list[int]:
    session = get_session(session_id)
    if not session:
        return []
    questions = get_questions(session["exam_id"])
    answered = {
        r["question_number"]
        for r in get_all_responses(session_id)
        if r.get("recorded_answer")
    }
    return [q["q_number"] for q in questions if q["q_number"] not in answered]


def compute_results(session_id: str) -> dict[str, Any]:
    session = get_session(session_id)
    if not session:
        raise ValueError("Session not found")
    questions = get_questions(session["exam_id"], include_key=True)
    responses = {r["question_number"]: r for r in get_all_responses(session_id)}
    total_marks = 0.0
    scored = 0.0
    correct = 0
    incorrect = 0
    unscored = 0
    review = []
    for q in questions:
        total_marks += float(q["marks"])
        resp = responses.get(q["q_number"])
        given = (resp or {}).get("recorded_answer")
        key = q.get("correct_answer")
        item = {
            "q_number": q["q_number"],
            "type": q["type"],
            "prompt": q["prompt"],
            "marks": q["marks"],
            "recorded_answer": given,
            "status": "unanswered",
        }
        if not given:
            unscored += 1
            item["status"] = "unanswered"
        elif resp and resp.get("correctness") is not None:
            if resp["correctness"]:
                scored += float(q["marks"])
                correct += 1
                item["status"] = "correct"
                item["awarded"] = q["marks"]
            else:
                incorrect += 1
                item["status"] = "incorrect"
                item["awarded"] = 0
        elif not key:
            unscored += 1
            item["status"] = "recorded"
        elif str(q.get("type", "")).upper() == "MATHEMATICS":
            unscored += 1
            item["status"] = "recorded"
        elif str(given).strip().lower() == str(key).strip().lower():
            scored += float(q["marks"])
            correct += 1
            item["status"] = "correct"
            item["awarded"] = q["marks"]
        else:
            incorrect += 1
            item["status"] = "incorrect"
            item["awarded"] = 0
        if session.get("is_submitted"):
            item["correct_answer"] = key
        review.append(item)
    percent = round((scored / total_marks) * 100, 2) if total_marks else 0.0
    unanswered_count = len(
        [q for q in questions if not (responses.get(q["q_number"]) or {}).get("recorded_answer")]
    )
    answered_count = len(questions) - unanswered_count
    topic_map: dict[str, dict[str, float]] = {}
    for q in questions:
        topic = q.get("topic") or "General"
        bucket = topic_map.setdefault(topic, {"marks": 0.0, "scored": 0.0, "questions": 0})
        bucket["marks"] += float(q["marks"])
        bucket["questions"] += 1
        resp = responses.get(q["q_number"])
        given = (resp or {}).get("recorded_answer")
        key = q.get("correct_answer")
        if (
            given
            and key
            and (
                (resp or {}).get("correctness") is True
                or (
                    (resp or {}).get("correctness") is None
                    and str(q.get("type", "")).upper() != "MATHEMATICS"
                    and str(given).strip().lower() == str(key).strip().lower()
                )
            )
        ):
            bucket["scored"] += float(q["marks"])
    topic_performance = [
        {
            "topic": name,
            "questions": int(data["questions"]),
            "score": data["scored"],
            "total_marks": data["marks"],
            "percentage": round((data["scored"] / data["marks"]) * 100, 2) if data["marks"] else 0,
        }
        for name, data in topic_map.items()
    ]
    exam = get_exam(session["exam_id"])
    return {
        "session_id": session_id,
        "exam_id": session["exam_id"],
        "exam_title": exam["title"] if exam else session["exam_id"],
        "exam_subject": exam["subject"] if exam else "",
        "started_at": session.get("started_at"),
        "ended_at": session.get("ended_at"),
        "is_submitted": session["is_submitted"],
        "score": scored,
        "total_marks": total_marks,
        "percentage": percent,
        "correct": correct,
        "incorrect": incorrect,
        "answered": answered_count,
        "unanswered": unanswered_count,
        "unscored_or_unanswered": unscored,
        "topic_performance": topic_performance if session.get("is_submitted") else None,
        "review": review if session.get("is_submitted") else None,
    }


def dashboard_stats() -> dict[str, Any]:
    conn = get_connection()
    try:
        total_exams = conn.execute("SELECT COUNT(*) FROM exams").fetchone()[0]
        published = conn.execute(
            "SELECT COUNT(*) FROM exams WHERE status = 'published'"
        ).fetchone()[0]
        drafts = conn.execute(
            "SELECT COUNT(*) FROM exams WHERE status != 'published'"
        ).fetchone()[0]
        attempts = conn.execute("SELECT COUNT(*) FROM exam_sessions").fetchone()[0]
        submitted = conn.execute(
            "SELECT COUNT(*) FROM exam_sessions WHERE is_submitted = 1"
        ).fetchone()[0]
        recent = [
            dict(r)
            for r in conn.execute(
                """
                SELECT session_id, exam_id, user_id, is_submitted, started_at
                FROM exam_sessions ORDER BY started_at DESC LIMIT 8
                """
            ).fetchall()
        ]
        return {
            "total_exams": total_exams,
            "published_exams": published,
            "draft_exams": drafts,
            "student_attempts": attempts,
            "submitted_attempts": submitted,
            "recent_activity": recent,
        }
    finally:
        conn.close()


initialize_database()
