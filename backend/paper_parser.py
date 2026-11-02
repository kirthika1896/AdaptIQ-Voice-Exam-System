"""Heuristic structure extraction from PDF text. This is not OCR."""

from __future__ import annotations

import re
from typing import Any


QUESTION_START = re.compile(
    r"^(?:q(?:uestion)?\s*)?(\d+)[\).:\-]\s*(.*)$", re.I
)
OPTION_LINE = re.compile(
    r"^[\(\[]?([A-Da-d])[\)\].:\-]\s*(.+)$"
)


def extract_questions_from_text(text: str) -> list[dict[str, Any]]:
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    blocks: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    def flush() -> None:
        nonlocal current
        if current:
            prompt = " ".join(current["prompt_lines"]).strip()
            options = current["options"]
            qtype = "MCQ" if len(options) >= 2 else "DESCRIPTIVE"
            current_out = {
                "q_number": current["q_number"],
                "type": qtype,
                "prompt": prompt,
                "options": options,
                "marks": 1,
                "topic": "",
                "difficulty": "medium",
                "verified": False,
                "audio_text": _audio(current["q_number"], prompt, options, qtype),
            }
            blocks.append(current_out)
            current = None

    for line in lines:
        qmatch = QUESTION_START.match(line)
        omatch = OPTION_LINE.match(line)
        if qmatch:
            flush()
            current = {
                "q_number": int(qmatch.group(1)),
                "prompt_lines": [qmatch.group(2)] if qmatch.group(2) else [],
                "options": [],
            }
            continue
        if omatch and current is not None:
            current["options"].append(
                {"key": omatch.group(1).upper(), "text": omatch.group(2).strip()}
            )
            continue
        if current is not None:
            current["prompt_lines"].append(line)
    flush()
    return blocks


def _audio(n: int, prompt: str, options: list[dict], qtype: str) -> str:
    parts = [f"Question {n}. {qtype.lower()}. {prompt}"]
    for opt in options:
        parts.append(f"Option {opt['key']}: {opt['text']}.")
    return " ".join(parts)
