"""
Authoritative exam-session behavior shared by REST and WebSocket gateways.
Does not create a second session model — all writes go through database.py.
"""

from __future__ import annotations

import re
from typing import Any, Optional

import database as db
from mathematics.answer_evaluator import assess_math_answer
from mathematics.parser import math_compiler
from voice.intent_parser import intent_parser


def format_time(seconds: int) -> str:
    seconds = max(0, int(seconds))
    m, s = divmod(seconds, 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h} hours {m} minutes {s} seconds"
    return f"{m} minutes {s} seconds"


def question_numbers(exam_id: str) -> list[int]:
    return [q["q_number"] for q in db.get_questions(exam_id)]


def student_question(q: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    if not q:
        return None
    safe = dict(q)
    safe.pop("correct_answer", None)
    return safe


def telemetry(
    session: dict[str, Any],
    *,
    speak: str = "",
    event: str = "telemetry",
    extra: Optional[dict[str, Any]] = None,
    include_key: bool = False,
) -> dict[str, Any]:
    session = db.persist_timer(session["session_id"]) or session
    q = db.get_question(
        session["exam_id"], session["current_question"], include_key=include_key
    )
    response = db.get_response(session["session_id"], session["current_question"])
    if response and not session.get("is_submitted"):
        response.pop("correctness", None)
    exam = db.get_exam(session["exam_id"])
    nums = question_numbers(session["exam_id"])
    unanswered = db.get_unanswered_questions(session["session_id"])
    payload: dict[str, Any] = {
        "ok": True,
        "event": event,
        "speak": speak,
        "exam": exam,
        "session": {
            "session_id": session["session_id"],
            "exam_id": session["exam_id"],
            "user_id": session.get("user_id"),
            "current_question": session["current_question"],
            "time_remaining_seconds": session["time_remaining_seconds"],
            "time_remaining_human": format_time(session["time_remaining_seconds"]),
            "marked_questions": session["marked_questions"],
            "is_submitted": session["is_submitted"],
            "pending_submit_confirmation": session.get("pending_submit", False),
            "status": session.get("status") or (
                "submitted" if session["is_submitted"] else "in_progress"
            ),
            "started_at": session.get("started_at"),
            "ended_at": session.get("ended_at"),
            "answered_count": max(0, len(nums) - len(unanswered)),
            "total_questions": len(nums),
        },
        "question": student_question(q) if not include_key else q,
        "response": response,
        "unanswered": unanswered,
        "question_numbers": nums,
    }
    if extra:
        payload.update(extra)
    return payload


def start_or_resume(
    exam_id: str, user_id: Optional[str] = None, *, force_new: bool = False
) -> dict[str, Any]:
    exam = db.get_exam(exam_id)
    if not exam:
        raise ValueError("Exam not found")
    if exam.get("status") != "published" and user_id:
        user = db.get_user(user_id)
        if not user or user["role"] != "admin":
            raise PermissionError("This examination is not published.")
    if user_id and not force_new:
        existing = db.get_active_session(user_id, exam_id)
        if existing:
            q = db.get_question(exam_id, existing["current_question"])
            audio = q["audio_text"] if q else ""
            return telemetry(
                existing,
                speak=(
                    f"Resuming {exam['title']}. You are on question "
                    f"{existing['current_question']}. {audio}"
                ),
                event="session_resumed",
            )
    session = db.create_session(exam_id, user_id=user_id)
    q = db.get_question(exam_id, session["current_question"])
    intro = (
        f"Welcome to {exam['title']}. Duration is {exam['duration_minutes']} minutes. "
        f"Starting at question {session['current_question']}. "
        f"{q['audio_text'] if q else ''}"
    )
    return telemetry(session, speak=intro, event="session_started")


def _speak_question(q: dict[str, Any], *, with_options: bool = True) -> str:
    parts = [f"Question {q['q_number']}. {q['prompt']}"]
    if with_options and q.get("options"):
        parts.append("Options.")
        for opt in q["options"]:
            parts.append(f"Option {opt.get('key')}: {opt.get('text')}.")
    return " ".join(parts)


def record_answer(
    session: dict[str, Any],
    answer: str,
    transcript: Optional[str] = None,
    *,
    math_steps: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    question_number = int(session["current_question"])
    question = db.get_question(
        session["exam_id"], question_number, include_key=True
    )
    if not question:
        raise ValueError("Current question was not found.")
    parsed_expression, correctness = assess_math_answer(
        question, answer, transcript
    )
    return db.upsert_response(
        session["session_id"],
        question_number,
        recorded_answer=answer,
        math_steps=math_steps,
        spoken_transcript=transcript,
        parsed_expression=parsed_expression,
        correctness=correctness,
    )


def handle_intent(session: dict[str, Any], transcript: str) -> dict[str, Any]:
    sid = session["session_id"]
    session = db.get_session(sid) or session

    if session.get("time_remaining_seconds", 1) <= 0 and not session.get("is_submitted"):
        db.update_session(sid, is_submitted=True, pending_submit=False)
        session = db.get_session(sid)  # type: ignore[assignment]
        return telemetry(
            session,
            speak="Time is over. Your examination has been submitted automatically.",
            event="exam_submitted",
            extra={"results": db.compute_results(sid)},
        )

    if session.get("is_submitted"):
        return telemetry(
            session,
            speak="This exam has already been submitted. No further changes are allowed.",
            event="already_submitted",
            extra={"results": db.compute_results(sid)},
        )

    parsed = intent_parser.parse(transcript)
    intent = parsed.intent
    q_current = db.get_question(session["exam_id"], session["current_question"])

    if intent in ("START_EXAM", "START_EXAM_NAMED"):
        return telemetry(
            session,
            speak="An examination session is already active. Finish this examination before starting another.",
            event="exam_already_active",
            extra={"intent": intent},
        )

    if intent == "RESUME_EXAM":
        return telemetry(
            session,
            speak="You are already in your active examination.",
            event="session_resumed",
            extra={"intent": intent},
        )

    if intent == "SUBMIT_ANSWER":
        return telemetry(
            session,
            speak="Please speak your answer now.",
            event="prompt_answer",
            extra={"intent": intent},
        )

    if session.get("pending_submit"):
        if intent in ("CONFIRM_YES", "CONFIRM_SUBMIT"):
            db.update_session(sid, is_submitted=True, pending_submit=False)
            session = db.get_session(sid)  # type: ignore[assignment]
            results = db.compute_results(sid)
            return telemetry(
                session,
                speak=(
                    "Exam submitted successfully. "
                    f"Your score is {results['score']} out of {results['total_marks']}, "
                    f"{results['percentage']} percent."
                ),
                event="exam_submitted",
                extra={"results": results, "intent": intent},
            )
        if intent == "CONFIRM_NO":
            db.update_session(sid, pending_submit=False)
            session = db.get_session(sid)  # type: ignore[assignment]
            return telemetry(
                session,
                speak="Submission cancelled. You may continue the examination.",
                event="submit_cancelled",
                extra={"intent": intent},
            )
        db.update_session(sid, pending_submit=False)
        session = db.get_session(sid) or session

    if intent == "CONFIRM_SUBMIT":
        unanswered = db.get_unanswered_questions(sid)
        nums = question_numbers(session["exam_id"])
        answered = len(nums) - len(unanswered)
        db.update_session(sid, pending_submit=True)
        session = db.get_session(sid)  # type: ignore[assignment]
        warn = (
            f" You have answered {answered} out of {len(nums)} questions. "
            f"{len(unanswered)} unanswered"
            + (
                f": {', '.join(str(n) for n in unanswered)}."
                if unanswered
                else "."
            )
        )
        return telemetry(
            session,
            speak=(
                "You are about to submit your examination."
                + warn
                + " Say yes to submit, or no to cancel."
            ),
            event="submit_confirmation_required",
            extra={"intent": intent},
        )

    if intent == "NAVIGATE":
        target = int(parsed.target)
        nums = question_numbers(session["exam_id"])
        if target not in nums:
            return telemetry(
                session,
                speak=(
                    f"Question {target} does not exist. Available questions are "
                    f"{', '.join(map(str, nums))}."
                ),
                event="navigate_failed",
                extra={"intent": intent, "target": target},
            )
        session = db.update_session(sid, current_question=target)  # type: ignore[assignment]
        q = db.get_question(session["exam_id"], target)
        return telemetry(
            session,
            speak=f"Navigated to question {target}. {_speak_question(q) if q else ''}",
            event="navigated",
            extra={"intent": intent, "target": target},
        )

    if intent == "NAVIGATE_NEXT":
        nums = question_numbers(session["exam_id"])
        cur = session["current_question"]
        try:
            idx = nums.index(cur)
            nxt = nums[idx + 1] if idx + 1 < len(nums) else None
        except ValueError:
            nxt = nums[0] if nums else None
        if nxt is None:
            return telemetry(
                session,
                speak="You are already on the last question.",
                event="navigate_edge",
                extra={"intent": intent},
            )
        session = db.update_session(sid, current_question=nxt)  # type: ignore[assignment]
        q = db.get_question(session["exam_id"], nxt)
        return telemetry(
            session,
            speak=f"Moving forward to question {nxt}. {_speak_question(q) if q else ''}",
            event="navigated",
            extra={"intent": intent, "target": nxt},
        )

    if intent == "NAVIGATE_PREV":
        nums = question_numbers(session["exam_id"])
        cur = session["current_question"]
        try:
            idx = nums.index(cur)
            prev = nums[idx - 1] if idx > 0 else None
        except ValueError:
            prev = None
        if prev is None:
            return telemetry(
                session,
                speak="You are already on the first question.",
                event="navigate_edge",
                extra={"intent": intent},
            )
        session = db.update_session(sid, current_question=prev)  # type: ignore[assignment]
        q = db.get_question(session["exam_id"], prev)
        return telemetry(
            session,
            speak=f"Going back to question {prev}. {_speak_question(q) if q else ''}",
            event="navigated",
            extra={"intent": intent, "target": prev},
        )

    if intent in ("REPEAT_PROMPT", "READ_QUESTION"):
        target = parsed.target or session["current_question"]
        q = db.get_question(session["exam_id"], int(target))
        if not q:
            return telemetry(
                session,
                speak=f"Question {target} was not found.",
                event="navigate_failed",
                extra={"intent": intent},
            )
        if int(target) != session["current_question"]:
            session = db.update_session(sid, current_question=int(target))  # type: ignore[assignment]
        return telemetry(
            session,
            speak=_speak_question(q),
            event="repeat_prompt",
            extra={"intent": intent},
        )

    if intent == "READ_OPTIONS":
        q = q_current
        if not q or not q.get("options"):
            return telemetry(
                session,
                speak="This question has no multiple-choice options.",
                event="read_options",
                extra={"intent": intent},
            )
        spoken = " ".join(
            f"Option {o.get('key')}: {o.get('text')}." for o in q["options"]
        )
        return telemetry(session, speak=spoken, event="read_options", extra={"intent": intent})

    if intent == "UNMARK_QUESTION":
        marked = list(session["marked_questions"])
        qn = session["current_question"]
        if qn in marked:
            marked.remove(qn)
            session = db.update_session(sid, marked_questions=marked)
            speak = f"Question {qn} has been unmarked."
        else:
            speak = f"Question {qn} is not marked for review."
        return telemetry(session, speak=speak, event="question_unmarked", extra={"intent": intent})

    if intent == "MARK_QUESTION":
        marked = list(session["marked_questions"])
        qn = session["current_question"]
        if qn not in marked:
            marked.append(qn)
            marked.sort()
            session = db.update_session(sid, marked_questions=marked)  # type: ignore[assignment]
            speak = f"Question {qn} has been marked for review."
        else:
            speak = f"Question {qn} is already marked for review."
        return telemetry(session, speak=speak, event="question_marked", extra={"intent": intent})

    if intent == "REVIEW_MARKED_LIST":
        marked = session["marked_questions"]
        speak = (
            "You have no marked questions."
            if not marked
            else "Your marked questions are: " + ", ".join(f"question {n}" for n in marked) + "."
        )
        return telemetry(session, speak=speak, event="marked_list", extra={"intent": intent})

    if intent == "QUERY_TIMER":
        session = db.persist_timer(sid) or session
        return telemetry(
            session,
            speak=f"Time remaining: {format_time(session['time_remaining_seconds'])}.",
            event="timer_query",
            extra={"intent": intent},
        )

    if intent == "QUERY_PROGRESS":
        nums = question_numbers(session["exam_id"])
        unanswered = db.get_unanswered_questions(sid)
        answered = len(nums) - len(unanswered)
        return telemetry(
            session,
            speak=f"You have completed {answered} of {len(nums)} questions.",
            event="progress",
            extra={"intent": intent},
        )

    if intent == "REVIEW_UNANSWERED":
        unanswered = db.get_unanswered_questions(sid)
        speak = (
            "All questions have been answered."
            if not unanswered
            else "Unanswered questions: " + ", ".join(f"question {n}" for n in unanswered) + "."
        )
        return telemetry(
            session,
            speak=speak,
            event="unanswered_list",
            extra={"intent": intent, "unanswered": unanswered},
        )

    if intent == "REVIEW_EXAM":
        unanswered = db.get_unanswered_questions(sid)
        marked = session["marked_questions"]
        nums = question_numbers(session["exam_id"])
        speak = (
            f"Review. {len(nums) - len(unanswered)} answered, {len(unanswered)} unanswered"
            + (f": {', '.join(map(str, unanswered))}" if unanswered else "")
            + (f". Marked for review: {', '.join(map(str, marked))}" if marked else "")
            + "."
        )
        return telemetry(session, speak=speak, event="review_exam", extra={"intent": intent})

    if intent == "READ_ANSWER":
        target = int(parsed.target or session["current_question"])
        resp = db.get_response(sid, target)
        answer = (resp or {}).get("recorded_answer")
        speak = (
            f"You have not answered question {target} yet."
            if not answer
            else f"Your answer for question {target} is {answer}."
        )
        return telemetry(session, speak=speak, event="read_answer", extra={"intent": intent})

    if intent == "CHANGE_ANSWER":
        return telemetry(
            session,
            speak="What would you like to change your answer to? You can say choose option A, speak a number, or dictate a new answer.",
            event="prompt_change_answer",
            extra={"intent": intent},
        )

    if intent == "CLEAR_ANSWER":
        db.upsert_response(sid, session["current_question"], clear=True)
        return telemetry(
            session,
            speak=f"Cleared your answer for question {session['current_question']}.",
            event="answer_cleared",
            extra={"intent": intent},
        )

    if intent == "STOP_SPEECH" or intent == "PAUSE":
        return telemetry(
            session,
            speak="Voice paused. Say resume when you are ready.",
            event="voice_paused",
            extra={"intent": intent},
        )

    if intent == "RESUME":
        return telemetry(
            session,
            speak="Voice is ready. You can continue speaking naturally.",
            event="voice_resumed",
            extra={"intent": intent},
        )

    if intent == "HELP":
        return telemetry(
            session,
            speak=(
                "You can talk naturally. For example, ask me to move to another question, "
                "hear the question again, tell you what you answered, explain the available "
                "choices, check how much time remains, or finish the examination."
            ),
            event="help",
            extra={"intent": intent},
        )

    if intent == "SUBMIT_MCQ":
        if q_current and q_current["type"] != "MCQ":
            return telemetry(
                session,
                speak=(
                    f"Current question is type {q_current['type']}, not multiple choice. "
                    "Speak a numerical, mathematical, or descriptive answer instead."
                ),
                event="type_mismatch",
                extra={"intent": intent},
            )
        option = parsed.option or parsed.answer
        db.upsert_response(
            sid,
            session["current_question"],
            recorded_answer=option,
            spoken_transcript=transcript,
        )
        return telemetry(
            session,
            speak=f"Recorded option {option} for question {session['current_question']}.",
            event="answer_recorded",
            extra={"intent": intent, "answer": option},
        )

    if intent == "SUBMIT_NUMERICAL":
        value = parsed.answer
        record_answer(session, value, transcript)
        session = db.get_session(sid) or session
        return telemetry(
            session,
            speak=f"Recorded numerical answer {value} for question {session['current_question']}.",
            event="answer_recorded",
            extra={"intent": intent, "answer": value},
        )

    if intent == "SUBMIT_MATH":
        qn = session["current_question"]
        existing = db.get_response(sid, qn)
        steps = (existing or {}).get("math_steps_json") or []
        edit_index = None
        edit_match = re.search(
            r"\b(?:edit|replace|correct)\s+step\s+(\d+)\b",
            transcript,
            flags=re.I,
        )
        if edit_match:
            edit_index = int(edit_match.group(1)) - 1
            transcript_clean = re.sub(
                r"\b(?:edit|replace|correct)\s+step\s+\d+\b[:,]?\s*",
                "",
                transcript,
                flags=re.I,
            ).strip() or transcript
        else:
            transcript_clean = transcript
            replace_all = re.search(
                r"\b(?:replace my answer with|change my answer to|my new answer is)\b",
                transcript,
                flags=re.I,
            )
            if replace_all:
                steps = []
        steps = math_compiler.append_step(steps, transcript_clean, edit_index=edit_index)
        final_latex = steps[-1]["latex"] if steps else parsed.math_latex
        record_answer(
            session,
            final_latex,
            transcript,
            math_steps=steps,
        )
        session = db.get_session(sid) or session
        step_no = (edit_index + 1) if edit_index is not None else len(steps)
        action = "Updated" if edit_index is not None else "Recorded"
        return telemetry(
            session,
            speak=f"{action} math step {step_no}: {final_latex}.",
            event="math_step_recorded",
            extra={
                "intent": intent,
                "math_latex": final_latex,
                "math_steps": steps,
                "spoken_transcript": transcript,
            },
        )

    if intent == "SUBMIT_TEXT" or (
        q_current and q_current["type"] == "DESCRIPTIVE" and intent == "UNKNOWN"
        and len(transcript.strip()) > 8
    ):
        record_answer(session, transcript.strip(), transcript)
        session = db.get_session(sid) or session
        return telemetry(
            session,
            speak=f"Recorded your descriptive answer for question {session['current_question']}.",
            event="answer_recorded",
            extra={"intent": "SUBMIT_TEXT", "answer": transcript.strip()},
        )

    return telemetry(
        session,
        speak=(
            "I didn't understand what you meant. Please say that another way. "
            "You can ask to hear the question again, move to another question, "
            "or tell me your answer in your own words."
        ),
        event="unknown_intent",
        extra={"intent": "UNKNOWN", "raw": transcript},
    )
