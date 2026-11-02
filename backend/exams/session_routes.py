"""
Layer 2 — Asynchronous WebSockets & PDF processing hub.
Stateful exam session pool, intent-driven navigation, SQLite writes,
and admin paper upload extraction via pypdf.
"""

from __future__ import annotations

import io
import json
import time
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pypdf import PdfReader

import database as db
from exams.session_service import handle_intent, start_or_resume, telemetry
from paper_parser import extract_questions_from_text
from auth_routes import require_admin, require_student

router = APIRouter()


class ConnectionPool:
    """Persistent WebSocket connection pool keyed by session_id."""

    def __init__(self) -> None:
        self.active: dict[str, WebSocket] = {}
        self.pending_submit: dict[str, bool] = {}
        self.session_started_at: dict[str, float] = {}

    async def connect(self, session_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active[session_id] = websocket
        self.session_started_at[session_id] = time.time()

    def disconnect(self, session_id: str) -> None:
        self.active.pop(session_id, None)
        self.pending_submit.pop(session_id, None)
        self.session_started_at.pop(session_id, None)

    async def send(self, session_id: str, payload: dict[str, Any]) -> None:
        ws = self.active.get(session_id)
        if ws is not None:
            await ws.send_json(payload)


pool = ConnectionPool()


@router.websocket("/ws/exam-session")
async def exam_session_ws(websocket: WebSocket) -> None:
    """
    Stateful exam WebSocket.
    Client messages (JSON):
      { "action": "start", "exam_id": "demo_exam_2026" }
      { "action": "transcript", "session_id": "...", "text": "..." }
      { "action": "ping", "session_id": "..." }
      { "action": "sync", "session_id": "..." }
    """
    session_id: Optional[str] = None
    authenticated_user: Optional[dict[str, Any]] = None

    # Accept early; bind to pool after session creation
    await websocket.accept()
    temp_key = f"pending-{id(websocket)}"
    pool.active[temp_key] = websocket

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json(
                    {"event": "error", "speak": "Invalid message format.", "detail": "JSON required"}
                )
                continue

            action = (message.get("action") or "").lower()

            if action == "start":
                exam_id = message.get("exam_id") or db.DEMO_EXAM_ID
                token = message.get("token")
                authenticated_user = db.get_user_by_token(str(token)) if token else None
                if not authenticated_user or authenticated_user.get("role") != "student":
                    await websocket.send_json(
                        {"event": "error", "speak": "A valid student sign-in is required."}
                    )
                    await websocket.close(code=1008)
                    return
                try:
                    payload = start_or_resume(exam_id, authenticated_user["id"])
                except (ValueError, PermissionError) as exc:
                    await websocket.send_json(
                        {"event": "error", "speak": str(exc), "detail": str(exc)}
                    )
                    continue
                session_id = payload["session"]["session_id"]
                pool.active.pop(temp_key, None)
                pool.active[session_id] = websocket
                pool.session_started_at[session_id] = time.time()
                pool.pending_submit[session_id] = False
                await websocket.send_json(payload)
                continue

            # All other actions require an active session
            sid = message.get("session_id") or session_id
            if not sid:
                await websocket.send_json(
                    {
                        "event": "error",
                        "speak": "No active session. Please start the exam first.",
                    }
                )
                continue

            session = db.get_session(sid)
            if not session:
                await websocket.send_json(
                    {
                        "event": "error",
                        "speak": "Session not found. Please restart the exam.",
                    }
                )
                continue
            if not authenticated_user or session.get("user_id") != authenticated_user["id"]:
                await websocket.send_json(
                    {"event": "error", "speak": "This session is not available to this student."}
                )
                continue

            session_id = sid
            if sid not in pool.active:
                pool.active[sid] = websocket
                pool.active.pop(temp_key, None)

            if action == "ping" or action == "sync":
                await websocket.send_json(telemetry(session, speak="", event="sync"))
                continue

            if action == "transcript":
                text = (message.get("text") or "").strip()
                if not text:
                    await websocket.send_json(
                        telemetry(
                            session,
                            speak="I did not catch that. Please speak again.",
                            event="empty_transcript",
                        )
                    )
                    continue
                result = handle_intent(session, text)
                result["transcript"] = text
                await websocket.send_json(result)
                continue

            await websocket.send_json(
                {
                    "event": "error",
                    "speak": f"Unknown action {action}.",
                }
            )

    except WebSocketDisconnect:
        if session_id:
            pool.disconnect(session_id)
        else:
            pool.active.pop(temp_key, None)
    except Exception as exc:  # noqa: BLE001 — surface to client then drop
        try:
            await websocket.send_json(
                {"event": "error", "speak": "A server error occurred.", "detail": str(exc)}
            )
        except Exception:
            pass
        if session_id:
            pool.disconnect(session_id)
        else:
            pool.active.pop(temp_key, None)


@router.post("/api/admin/upload-paper")
async def upload_paper(
    file: UploadFile = File(...),
    _admin: dict[str, Any] = Depends(require_admin),
) -> JSONResponse:
    """
    Accept a structural PDF document upload, stream pages via pypdf,
    and return the raw extracted text dataset for the admin layout pane.
    """
    if not file.filename:
        return JSONResponse(
            status_code=400,
            content={"ok": False, "error": "No filename provided."},
        )

    content_type = (file.content_type or "").lower()
    name_lower = file.filename.lower()
    if "pdf" not in content_type and not name_lower.endswith(".pdf"):
        return JSONResponse(
            status_code=400,
            content={
                "ok": False,
                "error": "Only PDF documents are supported for paper upload.",
            },
        )

    raw_bytes = await file.read()
    if not raw_bytes:
        return JSONResponse(
            status_code=400,
            content={"ok": False, "error": "Uploaded file is empty."},
        )

    try:
        reader = PdfReader(io.BytesIO(raw_bytes))
        pages: list[dict[str, Any]] = []
        full_lines: list[str] = []

        for index, page in enumerate(reader.pages):
            # Programmatic line-by-line extraction
            page_text = page.extract_text() or ""
            lines = [ln.strip() for ln in page_text.splitlines()]
            lines = [ln for ln in lines if ln]
            pages.append(
                {
                    "page_number": index + 1,
                    "line_count": len(lines),
                    "lines": lines,
                    "raw_text": page_text,
                }
            )
            full_lines.extend(lines)

        extracted = "\n".join(full_lines)
        extracted_questions = extract_questions_from_text(extracted)
        is_scanned_image = len(full_lines) == 0 or not extracted.strip()
        notice = (
            "No readable digital text found. This document appears to be an image-only scan without an embedded OCR text layer."
            if is_scanned_image
            else (
                "Text extracted, but no structured questions matched standard patterns (e.g. '1. Question prompt')."
                if len(extracted_questions) == 0
                else f"Successfully extracted {len(extracted_questions)} structured question(s)."
            )
        )
        return JSONResponse(
            content={
                "ok": True,
                "filename": file.filename,
                "page_count": len(reader.pages),
                "line_count": len(full_lines),
                "pages": pages,
                "extracted_text": extracted,
                "extracted_questions": extracted_questions,
                "is_scanned_image": is_scanned_image,
                "notice": notice,
                "verification_required": True,
            }
        )
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "error": f"Failed to parse PDF: {exc}",
            },
        )


@router.get("/api/exam/{exam_id}")
async def get_exam_meta(
    exam_id: str,
    _student: dict[str, Any] = Depends(require_student),
) -> JSONResponse:
    exam = db.get_exam(exam_id)
    if not exam or exam.get("status") != "published":
        return JSONResponse(status_code=404, content={"ok": False, "error": "Exam not found"})
    questions = db.get_questions(exam_id)
    return JSONResponse(
        content={"ok": True, "exam": exam, "questions": questions}
    )
