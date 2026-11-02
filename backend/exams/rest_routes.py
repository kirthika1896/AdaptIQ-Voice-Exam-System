"""REST surface for the existing database + session_service contracts."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import database as db
from auth_routes import optional_user, require_admin, require_student
from exams.session_service import handle_intent, record_answer, start_or_resume, telemetry

router = APIRouter()


class ExamCreateBody(BaseModel):
    title: str
    subject: str = "General"
    duration_minutes: int = Field(default=60, ge=1, le=600)
    description: str = ""


class ExamUpdateBody(BaseModel):
    title: Optional[str] = None
    subject: Optional[str] = None
    duration_minutes: Optional[int] = Field(default=None, ge=1, le=600)
    description: Optional[str] = None


class QuestionBody(BaseModel):
    q_number: int
    type: str = "MCQ"
    prompt: str
    options: list[dict[str, Any]] = Field(default_factory=list)
    marks: float = 1
    topic: str = ""
    difficulty: str = "medium"
    math_latex: Optional[str] = None
    audio_text: Optional[str] = None
    correct_answer: Optional[str] = None
    verified: bool = False


class TranscriptBody(BaseModel):
    text: str


class GotoBody(BaseModel):
    question_number: int


class AnswerBody(BaseModel):
    recorded_answer: str
    spoken_transcript: Optional[str] = None


def _session_or_404(session_id: str) -> dict[str, Any]:
    session = db.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")
    return session


def _guard_session(session: dict[str, Any], user: Optional[dict[str, Any]]) -> None:
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required.")
    if user["role"] != "student":
        raise HTTPException(status_code=403, detail="Student access required.")
    if session.get("user_id") != user["id"]:
        raise HTTPException(status_code=403, detail="This session belongs to another student.")


@router.get("/api/exams")
async def list_published_exams(
    _student: dict[str, Any] = Depends(require_student),
) -> dict[str, Any]:
    return {"ok": True, "exams": db.list_exams(published_only=True)}


@router.get("/api/admin/exams")
async def admin_list_exams(_admin: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    return {"ok": True, "exams": db.list_exams(published_only=False)}


@router.get("/api/admin/exams/{exam_id}")
async def admin_get_exam(
    exam_id: str,
    _admin: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    exam = db.get_exam(exam_id)
    if not exam:
        raise HTTPException(status_code=404, detail="Exam not found.")
    return {
        "ok": True,
        "exam": exam,
        "questions": db.get_questions(exam_id, include_key=True),
    }


@router.post("/api/admin/exams")
async def admin_create_exam(
    body: ExamCreateBody,
    admin: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    exam = db.create_exam(
        title=body.title.strip(),
        subject=body.subject.strip() or "General",
        duration_minutes=body.duration_minutes,
        description=body.description.strip(),
        created_by=admin["id"],
    )
    return {"ok": True, "exam": exam}


@router.patch("/api/admin/exams/{exam_id}")
async def admin_update_exam(
    exam_id: str,
    body: ExamUpdateBody,
    _admin: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    exam = db.get_exam(exam_id)
    if not exam:
        raise HTTPException(status_code=404, detail="Exam not found.")
    updated = db.update_exam(exam_id, **body.model_dump(exclude_none=True))
    return {"ok": True, "exam": updated}


@router.delete("/api/admin/exams/{exam_id}")
async def admin_delete_exam(
    exam_id: str,
    _admin: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    if exam_id == db.DEMO_EXAM_ID:
        raise HTTPException(status_code=400, detail="Cannot delete the seeded demo examination.")
    exam = db.get_exam(exam_id)
    if not exam:
        raise HTTPException(status_code=404, detail="Exam not found.")
    ok = db.delete_exam(exam_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Exam could not be deleted.")
    return {"ok": True}


@router.post("/api/admin/exams/{exam_id}/publish")
async def admin_publish_exam(
    exam_id: str,
    _admin: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    exam = db.get_exam(exam_id)
    if not exam:
        raise HTTPException(status_code=404, detail="Exam not found.")
    questions = db.get_questions(exam_id, include_key=True)
    if not questions:
        raise HTTPException(status_code=400, detail="Add at least one question before publishing.")
    unverified = [q["q_number"] for q in questions if not q.get("verified")]
    if unverified:
        raise HTTPException(
            status_code=400,
            detail=f"Verify all questions before publishing. Unverified: {unverified}.",
        )
    updated = db.update_exam(exam_id, status="published")
    return {"ok": True, "exam": updated}


@router.post("/api/admin/exams/{exam_id}/unpublish")
async def admin_unpublish_exam(
    exam_id: str,
    _admin: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    exam = db.get_exam(exam_id)
    if not exam:
        raise HTTPException(status_code=404, detail="Exam not found.")
    updated_exam = db.update_exam(exam_id, status="draft")
    return {"ok": True, "exam": updated_exam}


@router.post("/api/admin/exams/{exam_id}/questions")
async def admin_upsert_question(
    exam_id: str,
    body: QuestionBody,
    _admin: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    if not db.get_exam(exam_id):
        raise HTTPException(status_code=404, detail="Exam not found.")
    question = db.upsert_question(exam_id, body.model_dump())
    return {"ok": True, "question": question}


@router.post("/api/admin/exams/{exam_id}/questions/import")
async def admin_import_questions(
    exam_id: str,
    payload: dict[str, Any],
    _admin: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    if not db.get_exam(exam_id):
        raise HTTPException(status_code=404, detail="Exam not found.")
    questions = payload.get("questions") or []
    if not isinstance(questions, list) or not questions:
        raise HTTPException(status_code=400, detail="No questions to import.")
    saved = []
    for item in questions:
        item = dict(item)
        item["verified"] = bool(item.get("verified"))
        saved.append(db.upsert_question(exam_id, item))
    return {"ok": True, "questions": saved}


@router.post("/api/admin/questions/{question_id}/verify")
async def admin_verify_question(
    question_id: int,
    payload: dict[str, Any] | None = None,
    _admin: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    verified = True if payload is None else bool(payload.get("verified", True))
    question = db.set_question_verified(question_id, verified)
    if not question:
        raise HTTPException(status_code=404, detail="Question not found.")
    return {"ok": True, "question": question}


@router.delete("/api/admin/questions/{question_id}")
async def admin_delete_question(
    question_id: int,
    _admin: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    ok = db.delete_question(question_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Question not found.")
    return {"ok": True}


@router.get("/api/admin/stats")
async def admin_stats(_admin: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    return {"ok": True, **db.dashboard_stats()}


@router.get("/api/admin/attempts")
async def admin_attempts(
    exam_id: Optional[str] = None,
    _admin: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    sessions = db.list_sessions(exam_id=exam_id)
    enriched = []
    for item in sessions:
        exam = db.get_exam(item["exam_id"])
        row = dict(item)
        row["exam"] = exam
        if item.get("is_submitted"):
            try:
                row["results"] = db.compute_results(item["session_id"])
            except Exception:
                row["results"] = None
        enriched.append(row)
    return {"ok": True, "attempts": enriched}


@router.get("/api/session/active")
async def active_session(
    exam_id: Optional[str] = None,
    user: dict[str, Any] = Depends(require_student),
) -> dict[str, Any]:
    session = db.get_active_session(user["id"], exam_id)
    if not session:
        return {"ok": True, "session": None}
    return telemetry(session, event="active_session")


@router.get("/api/session/{session_id}")
async def get_session_state(
    session_id: str,
    user: Optional[dict[str, Any]] = Depends(optional_user),
) -> dict[str, Any]:
    session = _session_or_404(session_id)
    _guard_session(session, user)
    payload = telemetry(session, event="sync")
    if session.get("is_submitted"):
        payload["results"] = db.compute_results(session_id)
    return payload


@router.post("/api/session/{session_id}/transcript")
async def post_transcript(
    session_id: str,
    body: TranscriptBody,
    user: Optional[dict[str, Any]] = Depends(optional_user),
) -> dict[str, Any]:
    session = _session_or_404(session_id)
    _guard_session(session, user)
    result = handle_intent(session, body.text)
    result["transcript"] = body.text
    return result


@router.post("/api/session/{session_id}/goto")
async def goto_question(
    session_id: str,
    body: GotoBody,
    user: Optional[dict[str, Any]] = Depends(optional_user),
) -> dict[str, Any]:
    session = _session_or_404(session_id)
    _guard_session(session, user)
    return handle_intent(session, f"go to question {body.question_number}")


@router.post("/api/session/{session_id}/answer")
async def save_answer(
    session_id: str,
    body: AnswerBody,
    user: Optional[dict[str, Any]] = Depends(optional_user),
) -> dict[str, Any]:
    session = _session_or_404(session_id)
    _guard_session(session, user)
    if session.get("is_submitted"):
        raise HTTPException(status_code=400, detail="Session already submitted.")
    if session.get("time_remaining_seconds", 1) <= 0:
        return handle_intent(session, "")
    record_answer(
        session,
        body.recorded_answer,
        body.spoken_transcript,
    )
    session = db.get_session(session_id)
    return telemetry(
        session,  # type: ignore[arg-type]
        speak=f"Saved your answer for question {session['current_question']}.",
        event="answer_recorded",
        extra={"answer": body.recorded_answer},
    )


@router.post("/api/session/{session_id}/clear-answer")
async def clear_answer(
    session_id: str,
    user: Optional[dict[str, Any]] = Depends(optional_user),
) -> dict[str, Any]:
    session = _session_or_404(session_id)
    _guard_session(session, user)
    return handle_intent(session, "clear my answer")


@router.post("/api/session/{session_id}/submit")
async def request_submit(
    session_id: str,
    user: Optional[dict[str, Any]] = Depends(optional_user),
) -> dict[str, Any]:
    session = _session_or_404(session_id)
    _guard_session(session, user)
    return handle_intent(session, "submit my exam")


@router.post("/api/session/{session_id}/confirm-submit")
async def confirm_submit(
    session_id: str,
    user: Optional[dict[str, Any]] = Depends(optional_user),
) -> dict[str, Any]:
    session = _session_or_404(session_id)
    _guard_session(session, user)
    if not session.get("pending_submit") and session.get("time_remaining_seconds", 1) > 0:
        handle_intent(session, "submit my exam")
        session = db.get_session(session_id) or session
    return handle_intent(session, "yes")


@router.post("/api/session/{session_id}/cancel-submit")
async def cancel_submit(
    session_id: str,
    user: Optional[dict[str, Any]] = Depends(optional_user),
) -> dict[str, Any]:
    session = _session_or_404(session_id)
    _guard_session(session, user)
    return handle_intent(session, "no")


@router.get("/api/session/{session_id}/responses")
async def session_responses(
    session_id: str,
    user: Optional[dict[str, Any]] = Depends(optional_user),
) -> dict[str, Any]:
    session = _session_or_404(session_id)
    _guard_session(session, user)
    responses = db.get_all_responses(session_id)
    if not session.get("is_submitted"):
        for response in responses:
            response.pop("correctness", None)
    return {"ok": True, "responses": responses}


@router.get("/api/session/{session_id}/results")
async def session_results(
    session_id: str,
    user: Optional[dict[str, Any]] = Depends(optional_user),
) -> dict[str, Any]:
    session = _session_or_404(session_id)
    _guard_session(session, user)
    if not session.get("is_submitted") and not (user and user["role"] == "admin"):
        raise HTTPException(status_code=400, detail="Results are available after submission.")
    return {"ok": True, "results": db.compute_results(session_id), "session": session}


@router.get("/api/me/results")
async def my_results(user: dict[str, Any] = Depends(require_student)) -> dict[str, Any]:
    return {"ok": True, "attempts": db.list_user_sessions(user["id"], submitted_only=True)}


@router.post("/api/session/start")
async def start_session_rest(
    payload: dict[str, Any] | None = None,
    user: dict[str, Any] = Depends(require_student),
) -> dict[str, Any]:
    exam_id = (payload or {}).get("exam_id") or db.DEMO_EXAM_ID
    force_new = bool((payload or {}).get("force_new"))
    try:
        result = start_or_resume(
            exam_id, user["id"], force_new=force_new
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return result
