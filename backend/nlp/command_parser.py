"""Small deterministic classifier for common exam voice commands."""

from __future__ import annotations

import re

_COMMANDS = (
    (
        "start_exam",
        {
            "start exam",
            "begin exam",
            "start the exam",
            "begin the exam",
            "start examination",
            "begin examination",
            "start the examination",
            "begin the examination",
        },
    ),
    ("next_question", {"next", "next question"}),
    ("repeat_question", {"repeat", "repeat question"}),
    ("submit_answer", {"submit", "submit answer"}),
    ("submit_exam", {"finish exam", "end exam", "exit exam", "submit exam"}),
    ("yes", {"yes"}),
    ("no", {"no"}),
)


def normalize_command(text: str) -> str:
    normalized = (text or "").lower().strip()
    normalized = re.sub(r"[^\w\s]", " ", normalized)
    return re.sub(r"\s+", " ", normalized).strip()


def classify_command(text: str) -> dict[str, str]:
    normalized = normalize_command(text)
    for intent, phrases in _COMMANDS:
        if normalized in phrases:
            return {"intent": intent, "text": normalized}
    return {"intent": "unknown", "text": normalized}
