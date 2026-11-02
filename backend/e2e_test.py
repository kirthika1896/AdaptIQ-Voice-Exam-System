"""
Comprehensive End-to-End Test Suite for AdaptIQ Voice Examination System.
Executes the full student and admin flows and tests all required voice phrases.
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

# Ensure backend root is on sys.path
BACKEND_ROOT = Path(__file__).resolve().parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

_TEST_DATABASE = tempfile.TemporaryDirectory(prefix="voice-adapter-e2e-")
os.environ["DATABASE_PATH"] = str(Path(_TEST_DATABASE.name) / "exam_system.db")
os.environ["ENABLE_DEMO_SEED"] = "true"
os.environ["DEMO_ADMIN_PASSWORD"] = "admin123"
os.environ["DEMO_STUDENT_PASSWORD"] = "student123"

import database as db
from auth_routes import login, me, logout, LoginBody
from exams.rest_routes import (
    list_published_exams,
    start_session_rest,
    goto_question,
    post_transcript,
    save_answer,
    clear_answer,
    request_submit,
    confirm_submit,
    cancel_submit,
    session_results,
    admin_list_exams,
    admin_create_exam,
    admin_update_exam,
    admin_get_exam,
    admin_import_questions,
    admin_verify_question,
    admin_publish_exam,
    admin_stats,
    admin_attempts,
    TranscriptBody,
    GotoBody,
    AnswerBody,
    ExamCreateBody,
    ExamUpdateBody,
)
from exams.session_routes import upload_paper
from voice.intent_parser import intent_parser
from mathematics.parser import math_compiler
from mathematics.answer_evaluator import evaluate_numeric_expression
from nlp.command_parser import classify_command
from fastapi import UploadFile
from main import app


async def asgi_request(
    method: str,
    path: str,
    *,
    body: dict[str, Any] | None = None,
    token: str | None = None,
) -> tuple[int, dict[str, Any]]:
    raw_body = json.dumps(body).encode("utf-8") if body is not None else b""
    headers = [(b"host", b"testserver")]
    if body is not None:
        headers.append((b"content-type", b"application/json"))
    if token:
        headers.append((b"authorization", f"Bearer {token}".encode("utf-8")))
    incoming = [{"type": "http.request", "body": raw_body, "more_body": False}]
    outgoing: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return incoming.pop(0) if incoming else {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        outgoing.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("utf-8"),
        "query_string": b"",
        "headers": headers,
        "client": ("127.0.0.1", 1),
        "server": ("testserver", 80),
        "root_path": "",
    }
    await app(scope, receive, send)
    response_start = next(item for item in outgoing if item["type"] == "http.response.start")
    response_body = b"".join(
        item.get("body", b"") for item in outgoing if item["type"] == "http.response.body"
    )
    return response_start["status"], json.loads(response_body or b"{}")


class TestRunner:
    def __init__(self):
        self.student_token = None
        self.student_user = None
        self.admin_token = None
        self.admin_user = None
        self.session_id = None
        self.passed_tests = 0
        self.failed_tests = 0

    def assert_true(self, condition: bool, message: str):
        if condition:
            self.passed_tests += 1
            print(f"  [PASS] {message}", flush=True)
        else:
            self.failed_tests += 1
            print(f"  [FAIL] {message}", flush=True)
            raise AssertionError(message)

    async def run_all(self):
        print("\n============================================================")
        print("STARTING COMPLETE E2E TEST PASS")
        print("============================================================\n")

        await self.test_student_flow()
        await self.test_admin_flow()
        await self.test_http_auth_boundaries()
        await self.test_specific_voice_phrases()

        print("\n============================================================")
        print(f"ALL TESTS COMPLETED: {self.passed_tests} PASSED, {self.failed_tests} FAILED")
        print("============================================================\n")
        if self.failed_tests > 0:
            sys.exit(1)

    async def test_student_flow(self):
        print("--- PHASE 1: STUDENT FLOW ---")

        # 1. Login
        login_res = await login(LoginBody(username="student", password="student123"))
        self.assert_true(login_res.get("ok") is True, "Student login succeeds")
        self.assert_true(bool(login_res.get("token")), "Auth token created")
        self.student_token = login_res["token"]
        self.student_user = login_res["user"]

        # 2. Authenticate token
        auth_hdr = f"Bearer {self.student_token}"
        me_res = await me(user=db.get_user_by_token(self.student_token))
        self.assert_true(me_res["user"]["username"] == "student", "Token verified via me()")

        # 3. View published exams
        exams_res = await list_published_exams()
        self.assert_true(exams_res.get("ok") is True, "Published exams retrieved")
        exams = exams_res.get("exams", [])
        self.assert_true(len(exams) > 0, f"Found {len(exams)} published exams")
        demo_exam = next((e for e in exams if e["id"] == db.DEMO_EXAM_ID), exams[0])

        # 4. Start Exam
        start_res = await start_session_rest(
            payload={"exam_id": demo_exam["id"], "force_new": True},
            user=self.student_user,
        )
        self.assert_true(start_res.get("ok") is True, "Exam session started")
        self.session_id = start_res["session"]["session_id"]
        self.assert_true(bool(self.session_id), f"Session created: {self.session_id}")
        self.assert_true(start_res["session"]["current_question"] == 1, "Starts at question 1")
        self.assert_true(bool(start_res.get("speak")), "Question read aloud (audio text present)")
        original_duration = db.get_exam(demo_exam["id"])["duration_minutes"]
        saved_duration = db.get_session(self.session_id)["duration_seconds"]
        db.update_exam(demo_exam["id"], duration_minutes=original_duration + 10)
        resumed = db.get_session(self.session_id)
        self.assert_true(
            resumed["duration_seconds"] == saved_duration,
            "Active session keeps its original timer after exam duration changes",
        )
        db.update_exam(demo_exam["id"], duration_minutes=original_duration)

        # 5. Say "next question"
        next_res = await post_transcript(self.session_id, TranscriptBody(text="next question"), user=self.student_user)
        self.assert_true(next_res["session"]["current_question"] == 2, "Spoken 'next question' navigates to question 2")

        # 6. Say "previous question"
        prev_res = await post_transcript(self.session_id, TranscriptBody(text="previous question"), user=self.student_user)
        self.assert_true(prev_res["session"]["current_question"] == 1, "Spoken 'previous question' navigates to question 1")

        # 7. Say "go to question 17"
        q17_res = await post_transcript(self.session_id, TranscriptBody(text="go to question 17"), user=self.student_user)
        self.assert_true(q17_res["session"]["current_question"] == 17, "Spoken 'go to question 17' navigates to question 17")

        # 8. Say "repeat the question"
        repeat_res = await post_transcript(self.session_id, TranscriptBody(text="repeat the question"), user=self.student_user)
        self.assert_true(repeat_res["event"] == "repeat_prompt", "Spoken 'repeat the question' repeats question")

        # 9. Return to Question 1
        q1_res = await goto_question(self.session_id, GotoBody(question_number=1), user=self.student_user)
        self.assert_true(q1_res["session"]["current_question"] == 1, "Navigated back to question 1")

        # 10. Say "read the options"
        opts_res = await post_transcript(self.session_id, TranscriptBody(text="read the options"), user=self.student_user)
        self.assert_true("Option A" in opts_res["speak"], "Spoken 'read the options' articulates options")

        # 11. Answer MCQ: "Option C"
        mcq_res = await post_transcript(self.session_id, TranscriptBody(text="Option C"), user=self.student_user)
        self.assert_true(mcq_res["event"] == "answer_recorded", "MCQ answer recorded via voice")
        self.assert_true(mcq_res["response"]["recorded_answer"] == "C", "Answer C persisted in backend")

        # 12. Check answer: "what did I answer?"
        chk_res = await post_transcript(self.session_id, TranscriptBody(text="what did I answer?"), user=self.student_user)
        self.assert_true("C" in chk_res["speak"], "Spoken 'what did I answer?' confirms answer C")

        # 13. Change answer: "change my answer to B"
        chg_res = await post_transcript(self.session_id, TranscriptBody(text="change my answer to B"), user=self.student_user)
        self.assert_true(chg_res["response"]["recorded_answer"] == "B", "Answer changed to B")

        # Change back to correct answer C: "select C"
        sel_c = await post_transcript(self.session_id, TranscriptBody(text="select C"), user=self.student_user)
        self.assert_true(sel_c["response"]["recorded_answer"] == "C", "Answer reverted to C")

        # 14. Navigate to Question 2 (Numerical)
        await goto_question(self.session_id, GotoBody(question_number=2), user=self.student_user)

        # 15. Answer numerical by voice: "my answer is fifty"
        num_res = await post_transcript(self.session_id, TranscriptBody(text="my answer is fifty"), user=self.student_user)
        self.assert_true(num_res["response"]["recorded_answer"] == "50", "Spoken number 'fifty' saved as '50'")
        self.assert_true(
            db.get_response(self.session_id, 2)["correctness"] is True,
            "Numerical spoken answer is safely graded and stored",
        )
        self.assert_true(
            "correctness" not in num_res["response"],
            "Correctness is withheld until exam submission",
        )

        # 16. Clear answer
        clr_res = await clear_answer(self.session_id, user=self.student_user)
        self.assert_true(clr_res["event"] == "answer_cleared", "Answer cleared successfully")
        resp_after_clear = db.get_response(self.session_id, 2)
        self.assert_true(resp_after_clear["recorded_answer"] is None, "Persisted answer is None after clear")

        # Re-save numerical answer 50
        await post_transcript(self.session_id, TranscriptBody(text="50"), user=self.student_user)

        # 17. Navigate to Question 17 (Mathematics)
        await goto_question(self.session_id, GotoBody(question_number=17), user=self.student_user)

        # 18. Give mathematical expression by voice: "x squared plus five x minus six equals zero"
        math_res = await post_transcript(
            self.session_id,
            TranscriptBody(text="x squared plus five x minus six equals zero"),
            user=self.student_user,
        )
        self.assert_true(math_res["event"] == "math_step_recorded", "Math step recorded event fired")
        self.assert_true(
            math_res["math_latex"] == "x^2 + 5x - 6 = 0",
            f"Math compiled correctly to 'x^2 + 5x - 6 = 0', got: {math_res['math_latex']}",
        )

        await clear_answer(self.session_id, user=self.student_user)

        # 19. Ask which questions are unanswered
        unans_res = await post_transcript(self.session_id, TranscriptBody(text="which questions haven't I answered?"), user=self.student_user)
        self.assert_true(unans_res["event"] == "unanswered_list", "Unanswered questions queried successfully")
        self.assert_true(17 in unans_res["unanswered"], "Question 17 correctly identified as unanswered")

        # 20. Ask remaining time
        timer_res = await post_transcript(self.session_id, TranscriptBody(text="how much time is left?"), user=self.student_user)
        self.assert_true(timer_res["event"] == "timer_query", "Timer queried successfully")
        self.assert_true("remaining" in timer_res["speak"].lower() or "minutes" in timer_res["speak"].lower(), "Timer spoken feedback provided")

        # 21. Review exam
        rev_res = await post_transcript(self.session_id, TranscriptBody(text="review my exam"), user=self.student_user)
        self.assert_true(rev_res["event"] == "review_exam", "Review mode triggered by voice")

        # 22. Two-step submission: Step 1
        sub1_res = await request_submit(self.session_id, user=self.student_user)
        self.assert_true(sub1_res["event"] == "submit_confirmation_required", "Two-step submission confirmation requested")
        self.assert_true(sub1_res["session"]["pending_submit_confirmation"] is True, "Session in pending submit confirmation state")

        # Step 2a: Say "no" (cancel)
        cancel_res = await cancel_submit(self.session_id, user=self.student_user)
        self.assert_true(cancel_res["event"] == "submit_cancelled", "Submission cancelled via 'no'")
        self.assert_true(cancel_res["session"]["pending_submit_confirmation"] is False, "Pending submit cleared")

        # Step 2b: Submit again and confirm with "yes"
        await request_submit(self.session_id, user=self.student_user)
        confirm_res = await confirm_submit(self.session_id, user=self.student_user)
        self.assert_true(confirm_res["event"] == "exam_submitted", "Exam submitted successfully via 'yes'")
        self.assert_true(confirm_res["session"]["is_submitted"] is True, "Session marked as is_submitted=True")

        # 23. Official Results
        res_payload = await session_results(self.session_id, user=self.student_user)
        self.assert_true(res_payload.get("ok") is True, "Results retrieved")
        results = res_payload["results"]
        self.assert_true(results["score"] >= 4.0, f"Score computed correctly (at least 4.0 marks), got {results['score']}")
        self.assert_true(results["correct"] >= 2, f"Correct count >= 2, got {results['correct']}")
        self.assert_true(results["unanswered"] >= 1, f"Unanswered count >= 1, got {results['unanswered']}")
        self.assert_true(bool(results["topic_performance"]), "Topic performance breakdown included")
        self.assert_true(bool(results["review"]), "Question-by-question review included")

        # 24. Logout
        logout_res = await logout(authorization=auth_hdr, user=self.student_user)
        self.assert_true(logout_res.get("ok") is True, "Student logged out")

    async def test_admin_flow(self):
        print("\n--- PHASE 2: ADMIN FLOW ---")

        # 1. Admin login
        admin_login = await login(LoginBody(username="admin", password="admin123"))
        self.assert_true(admin_login.get("ok") is True, "Admin login succeeds")
        self.assert_true(admin_login["user"]["role"] == "admin", "User role is admin")
        self.admin_token = admin_login["token"]
        self.admin_user = admin_login["user"]

        # 2. Admin dashboard statistics
        stats_res = await admin_stats(_admin=self.admin_user)
        self.assert_true(stats_res.get("ok") is True, "Admin stats load")
        self.assert_true("total_exams" in stats_res, "Total exams count in stats")

        # 3. Create exam
        new_exam_body = ExamCreateBody(
            title="Advanced Applied Mathematics 2026",
            subject="Applied Math",
            duration_minutes=45,
            description="Comprehensive entrance test for applied mathematics.",
        )
        created_res = await admin_create_exam(new_exam_body, admin=self.admin_user)
        self.assert_true(created_res.get("ok") is True, "New exam created in draft")
        new_exam_id = created_res["exam"]["id"]
        self.assert_true(created_res["exam"]["status"] == "draft", "Status is draft")
        update_res = await admin_update_exam(
            new_exam_id,
            ExamUpdateBody(title="Updated Applied Mathematics 2026"),
            _admin=self.admin_user,
        )
        self.assert_true(
            update_res["exam"]["title"] == "Updated Applied Mathematics 2026",
            "Exam update returns the persisted exam",
        )

        # 4. Import questions into exam
        sample_questions = [
            {
                "q_number": 1,
                "type": "MCQ",
                "prompt": "What is the derivative of x^2?",
                "options": [
                    {"key": "A", "text": "x"},
                    {"key": "B", "text": "2x"},
                    {"key": "C", "text": "x^2"},
                    {"key": "D", "text": "2"},
                ],
                "marks": 2,
                "correct_answer": "B",
                "verified": False,
            },
            {
                "q_number": 2,
                "type": "NUMERICAL",
                "prompt": "Evaluate 100 divided by 4.",
                "options": [],
                "marks": 2,
                "correct_answer": "25",
                "verified": False,
            },
        ]
        import_res = await admin_import_questions(
            new_exam_id, {"questions": sample_questions}, _admin=self.admin_user
        )
        self.assert_true(len(import_res.get("questions", [])) == 2, "2 questions imported")

        # 5. Verify questions
        exam_details = await admin_get_exam(new_exam_id, _admin=self.admin_user)
        for q in exam_details["questions"]:
            v_res = await admin_verify_question(q["id"], {"verified": True}, _admin=self.admin_user)
            self.assert_true(v_res["question"]["verified"] is True, f"Question {q['q_number']} verified")

        # 6. Publish exam
        pub_res = await admin_publish_exam(new_exam_id, _admin=self.admin_user)
        self.assert_true(pub_res["exam"]["status"] == "published", "Exam successfully published")

        # 7. Student can see newly published exam
        pub_list = await list_published_exams()
        found = any(e["id"] == new_exam_id for e in pub_list.get("exams", []))
        self.assert_true(found, "Newly published exam visible to students")

        # 8. Check admin attempts
        attempts_res = await admin_attempts(_admin=self.admin_user)
        self.assert_true(attempts_res.get("ok") is True, "Admin attempts retrieved")

        # 9. Admin logout
        await logout(authorization=f"Bearer {self.admin_token}", user=self.admin_user)
        self.assert_true(True, "Admin logged out successfully")

    async def test_specific_voice_phrases(self):
        print("\n--- PHASE 3: SPECIFIC VOICE TEST PHRASES (REQ 31) ---")

        phrases = [
            ("take me to question 17", "NAVIGATE"),
            ("go to question seventeen", "NAVIGATE"),
            ("I'm ready for another question", "NAVIGATE_NEXT"),
            ("Could we move on?", "NAVIGATE_NEXT"),
            ("go back", "NAVIGATE_PREV"),
            ("go to the previous question", "NAVIGATE_PREV"),
            ("read question 5", "READ_QUESTION"),
            ("read the question again", "REPEAT_PROMPT"),
            ("I didn't catch the question", "REPEAT_PROMPT"),
            ("Could you say that again, please?", "REPEAT_PROMPT"),
            ("read the options", "READ_OPTIONS"),
            ("what questions haven't I answered?", "REVIEW_UNANSWERED"),
            ("read my answer for question 5", "READ_ANSWER"),
            ("change my answer to B", "SUBMIT_MCQ"),
            ("I think the answer is option C", "SUBMIT_MCQ"),
            ("clear my answer", "CLEAR_ANSWER"),
            ("how much time is left?", "QUERY_TIMER"),
            ("How long do I have left?", "QUERY_TIMER"),
            ("review my exam", "REVIEW_EXAM"),
            ("submit my exam", "CONFIRM_SUBMIT"),
            ("I want to hand it in", "CONFIRM_SUBMIT"),
            ("I'd like to take the mathematics test", "START_EXAM_NAMED"),
            ("Could I continue where I left off?", "RESUME_EXAM"),
            ("yes", "CONFIRM_YES"),
            ("That sounds good", "CONFIRM_YES"),
            ("no", "CONFIRM_NO"),
            ("Not yet, let me continue", "CONFIRM_NO"),
        ]

        for phrase, expected_intent in phrases:
            parsed = intent_parser.parse(phrase)
            self.assert_true(
                parsed.intent == expected_intent,
                f"Parsed: '{phrase}' -> {parsed.intent}, expected {expected_intent}",
            )
            if phrase == "I'd like to take the mathematics test":
                self.assert_true(
                    parsed.target == "mathematics",
                    "Natural exam request retains the requested exam name",
                )

        math_phrases = [
            ("seven plus five", "7 + 5"),
            ("nine minus four", "9 - 4"),
            ("six times seven", "6 \\times 7"),
            ("six multiplied by seven", "6 \\times 7"),
            ("three multiplied with four", "3 \\times 4"),
            ("twenty divided by four", "20 / 4"),
            ("five plus three", "5 + 3"),
            ("ten minus four", "10 - 4"),
            ("twenty divided by five", "20 / 5"),
            ("two squared", "2 ^ 2"),
            ("three cubed", "3 ^ 3"),
            ("x squared", "x^2"),
            ("x cubed", "x^3"),
            ("x to the power of four", "x^4"),
            ("x to the fourth power", "x^4"),
            ("x is equal to five", "x = 5"),
            ("square root of one hundred and forty four", "\\sqrt{144}"),
            ("square of five", "5 ^ 2"),
            ("one thousand two hundred and thirty four plus six", "1234 + 6"),
            ("point five times two", "0.5 \\times 2"),
            ("three times open parenthesis four plus two close parenthesis", "3 \\times ( 4 + 2 )"),
            ("one half plus one quarter", "1 / 2 + 1 / 4"),
            ("twenty percent of fifty", "20% of 50"),
            ("three x plus five", "3x + 5"),
        ]
        for phrase, expected_latex in math_phrases:
            parsed = intent_parser.parse(phrase)
            self.assert_true(
                parsed.intent == "SUBMIT_MATH" and parsed.math_latex == expected_latex,
                f"Math '{phrase}' -> {parsed.intent} {parsed.math_latex}, expected {expected_latex}",
            )

        for phrase, expected in (
            ("five plus three", 8),
            ("ten minus four", 6),
            ("six times seven", 42),
            ("twenty divided by five", 4),
            ("two squared", 4),
            ("three cubed", 27),
            ("two plus five times three", 17),
            ("square of five", 25),
            ("one thousand two hundred and thirty four plus six", 1240),
            ("point five times two", 1),
            ("three times open parenthesis four plus two close parenthesis", 18),
        ):
            parsed = math_compiler.compile(phrase)
            self.assert_true(
                evaluate_numeric_expression(parsed.latex) == expected,
                f"Safely evaluated '{phrase}'",
            )
        for phrase, expected in (
            ("I think the answer would be five plus three", "5 + 3"),
            ("My answer would be forty two", "42"),
            ("seven point zero five", "7.05"),
        ):
            parsed = intent_parser.parse(phrase)
            self.assert_true(
                parsed.intent in ("SUBMIT_MATH", "SUBMIT_NUMERICAL")
                and parsed.answer == expected,
                f"Understood natural answer '{phrase}' as {parsed.answer}",
            )
        self.assert_true(
            evaluate_numeric_expression("__import__('os').system('whoami')") is None,
            "Unsafe mathematical syntax is rejected",
        )

        for phrase, expected_intent in (
            ("Start the exam!", "start_exam"),
            ("next question", "next_question"),
            ("repeat!", "repeat_question"),
            ("submit answer", "submit_answer"),
            ("finish exam", "submit_exam"),
            ("YES.", "yes"),
            ("No!", "no"),
        ):
            self.assert_true(
                classify_command(phrase)["intent"] == expected_intent,
                f"Classified voice command '{phrase}'",
            )

        print("All specific test scenarios tested successfully!")

    async def test_http_auth_boundaries(self):
        print("\n--- PHASE 3: HTTP AUTHORIZATION BOUNDARIES ---")

        status, _ = await asgi_request("GET", "/api/exams")
        self.assert_true(status == 401, "Anonymous exam listing is rejected")
        status, _ = await asgi_request(
            "POST",
            "/api/auth/students/register",
            body={
                "username": "VoiceStudent42",
                "password": "secure-pass-42",
                "registration_number": "STU-2026-42",
                "name": "Voice Student",
            },
        )
        self.assert_true(status == 401, "Anonymous account creation is rejected")
        status, _ = await asgi_request(
            "POST",
            "/api/auth/login",
            body={"username": "student", "password": "incorrect"},
        )
        self.assert_true(status == 401, "Invalid credentials are rejected")

        status, student_login = await asgi_request(
            "POST",
            "/api/auth/login",
            body={"username": "user-student", "password": "student123"},
        )
        self.assert_true(status == 200, "Registered student ID can authenticate")
        status, admin_login = await asgi_request(
            "POST",
            "/api/auth/login",
            body={"username": "user-admin", "password": "admin123"},
        )
        self.assert_true(status == 200, "Registered admin ID can authenticate")
        student_token = student_login["token"]
        admin_token = admin_login["token"]

        status, _ = await asgi_request(
            "POST",
            "/api/auth/students/register",
            body={
                "username": "unauthorizedstudent",
                "password": "secure-pass-42",
                "registration_number": "STU-2026-40",
                "name": "Unauthorized Student",
            },
            token=student_token,
        )
        self.assert_true(status == 403, "Students cannot create student accounts")

        registration_body = {
            "username": "VoiceStudent42",
            "password": "secure-pass-42",
            "registration_number": "STU-2026-42",
            "name": "Voice Student",
        }
        status, registered = await asgi_request(
            "POST",
            "/api/auth/students/register",
            body=registration_body,
            token=admin_token,
        )
        self.assert_true(
            status == 201 and registered["user"]["username"] == "voicestudent42",
            "Admin can create a normalized student account and profile",
        )
        self.assert_true(
            "password_hash" not in registered["user"],
            "Student registration does not expose password hashes",
        )
        status, _ = await asgi_request(
            "POST",
            "/api/auth/students/register",
            body={
                **registration_body,
                "username": "VOICESTUDENT42",
                "registration_number": "STU-2026-43",
                "name": "Duplicate Username",
            },
            token=admin_token,
        )
        self.assert_true(status == 409, "Duplicate student usernames are rejected")
        status, _ = await asgi_request(
            "POST",
            "/api/auth/students/register",
            body={
                **registration_body,
                "username": "otherstudent42",
                "registration_number": "stu-2026-42",
                "name": "Duplicate Registration",
            },
            token=admin_token,
        )
        self.assert_true(status == 409, "Duplicate registration numbers are rejected")
        status, registered_login = await asgi_request(
            "POST",
            "/api/auth/login",
            body={"username": "STU-2026-42", "password": "secure-pass-42"},
        )
        self.assert_true(status == 200, "Student can sign in using a spoken registration number")
        status, own_profile = await asgi_request(
            "GET",
            "/api/auth/students/me",
            token=registered_login["token"],
        )
        self.assert_true(
            status == 200 and own_profile["student"]["registration_number"] == "STU-2026-42",
            "Authenticated student profile resolves from the session identity",
        )

        status, _ = await asgi_request("GET", "/api/admin/exams", token=student_token)
        self.assert_true(status == 403, "Student cannot access admin exam management")
        status, _ = await asgi_request("GET", "/api/exams", token=admin_token)
        self.assert_true(status == 403, "Admin cannot access student exam listing")
        status, updated = await asgi_request(
            "PATCH",
            f"/api/admin/exams/{db.DEMO_EXAM_ID}",
            body={"status": "draft"},
            token=admin_token,
        )
        self.assert_true(
            status == 200 and updated["exam"]["status"] == "published",
            "Generic exam updates cannot bypass the verified publish workflow",
        )

        status, draft = await asgi_request(
            "POST",
            "/api/admin/exams",
            body={
                "title": "Unpublished Exam",
                "subject": "Testing",
                "duration_minutes": 10,
                "description": "",
            },
            token=admin_token,
        )
        self.assert_true(status == 200, "Admin can create an unpublished draft")
        status, _ = await asgi_request(
            "POST",
            "/api/session/start",
            body={"exam_id": draft["exam"]["id"]},
            token=student_token,
        )
        self.assert_true(status == 403, "Student cannot start an unpublished exam")
        status, _ = await asgi_request("POST", "/api/session/start", body={})
        self.assert_true(status == 401, "Anonymous users cannot start an exam")

        status, started = await asgi_request(
            "POST",
            "/api/session/start",
            body={"exam_id": db.DEMO_EXAM_ID},
            token=student_token,
        )
        self.assert_true(status == 200, "Authenticated student can start an exam")
        session_id = started["session"]["session_id"]
        status, resumed = await asgi_request(
            "POST",
            "/api/session/start",
            body={"exam_id": db.DEMO_EXAM_ID},
            token=student_token,
        )
        self.assert_true(
            status == 200 and resumed["session"]["session_id"] == session_id,
            "Starting an exam twice resumes the active session",
        )
        self.assert_true(
            "correct_answer" not in started["question"],
            "Correct answer is absent before submission",
        )

        status, _ = await asgi_request("GET", f"/api/session/{session_id}")
        self.assert_true(status == 401, "Anonymous session access is rejected")
        status, _ = await asgi_request(
            "GET", f"/api/session/{session_id}", token=admin_token
        )
        self.assert_true(status == 403, "Admin cannot access student session routes")

        conn = db.get_connection()
        try:
            conn.execute(
                "INSERT INTO users (id, username, password_hash, role, display_name) VALUES (?, ?, ?, 'student', ?)",
                ("second-student", "second-student", db._hash_password("second-pass"), "Second Student"),
            )
            conn.commit()
        finally:
            conn.close()
        _, second_login = await asgi_request(
            "POST",
            "/api/auth/login",
            body={"username": "second-student", "password": "second-pass"},
        )
        status, _ = await asgi_request(
            "GET", f"/api/session/{session_id}", token=second_login["token"]
        )
        self.assert_true(status == 403, "Student cannot access another student's session")

        status, saved = await asgi_request(
            "POST",
            f"/api/session/{session_id}/answer",
            body={"recorded_answer": "C"},
            token=student_token,
        )
        self.assert_true(status == 200, "Student answer persists through HTTP API")
        self.assert_true(
            saved["response"]["recorded_answer"] == "C",
            "HTTP answer response confirms persisted answer",
        )

        _, expiring = await asgi_request(
            "POST",
            "/api/session/start",
            body={"exam_id": db.DEMO_EXAM_ID, "force_new": True},
            token=student_token,
        )
        expiring_id = expiring["session"]["session_id"]
        expiring_session = db.get_session(expiring_id)
        conn = db.get_connection()
        try:
            conn.execute(
                "UPDATE exam_sessions SET started_at = ? WHERE session_id = ?",
                (time.time() - expiring_session["duration_seconds"] - 1, expiring_id),
            )
            conn.commit()
        finally:
            conn.close()
        status, expired = await asgi_request(
            "POST",
            f"/api/session/{expiring_id}/answer",
            body={"recorded_answer": "C"},
            token=student_token,
        )
        self.assert_true(status == 200, "Expired session is finalized through answer API")
        self.assert_true(
            expired["event"] == "exam_submitted" and db.get_response(expiring_id, 1) is None,
            "Expired exam auto-submits without persisting a late answer",
        )


if __name__ == "__main__":
    import asyncio
    runner = TestRunner()
    asyncio.run(runner.run_all())
