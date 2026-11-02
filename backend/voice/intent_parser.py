"""
Layer 3 — NLU transcript command matrix router.
Resolves unrestricted spoken strings into exact intent coordinates.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

from mathematics.parser import (
    SpokenMathCompiler,
    math_compiler,
    replace_spoken_numbers,
)
from nlp.command_parser import classify_command


@dataclass
class ParsedIntent:
    intent: str
    target: Optional[Any] = None
    option: Optional[str] = None
    answer: Optional[str] = None
    math_latex: Optional[str] = None
    raw: str = ""
    confidence: float = 1.0
    meta: dict[str, Any] = field(default_factory=dict)


class IntentParser:
    """
    Processes spoken transcripts and maps them onto the examination
    command matrix (navigation, review, MCQ, math submission, etc.).
    """

    NUMBER_WORDS = {
        "one": 1,
        "two": 2,
        "three": 3,
        "four": 4,
        "five": 5,
        "six": 6,
        "seven": 7,
        "eight": 8,
        "nine": 9,
        "ten": 10,
        "eleven": 11,
        "twelve": 12,
        "thirteen": 13,
        "fourteen": 14,
        "fifteen": 15,
        "sixteen": 16,
        "seventeen": 17,
        "eighteen": 18,
        "nineteen": 19,
        "twenty": 20,
    }

    # Conversational phrasings map to intents before text is interpreted as an answer.
    COMMAND_MATRIX: list[tuple[str, list[re.Pattern]]] = [
        (
            "CONFIRM_YES",
            [
                re.compile(r"^\s*(?:yes|confirm|proceed|affirmative|sure)\s*$", re.I),
                re.compile(r"^\s*yes[,.]?\s+(?:submit|confirm|proceed)\b", re.I),
                re.compile(r"^\s*(?:yeah|yep|that sounds good|please do|go ahead)(?:,?\s+(?:please|submit it|finish))?[.!]?\s*$", re.I),
            ],
        ),
        (
            "CONFIRM_NO",
            [
                re.compile(r"^\s*(?:no|cancel|abort|stop|never\s*mind)\s*$", re.I),
                re.compile(r"\b(?:do\s+not|don\'?t)\s+submit\b", re.I),
                re.compile(r"^\s*no[,.]?\s+(?:cancel|don\'?t\s+submit)\b", re.I),
                re.compile(r"^\s*(?:no thanks|not yet|i changed my mind|let me continue)(?:,?\s+(?:please|i want to keep going|let me continue))?[.!]?\s*$", re.I),
            ],
        ),
        (
            "CONFIRM_SUBMIT",
            [
                re.compile(r"\bsubmit\s+(?:the\s+|my\s+)?exam\b", re.I),
                re.compile(r"\bend\s+(?:the\s+)?exam\b", re.I),
                re.compile(r"\bfinish\s+(?:the\s+|my\s+)?exam\b", re.I),
                re.compile(r"\bi\s+(?:want\s+to\s+)?submit\b", re.I),
                re.compile(r"\bi(?:\'?m| am)\s+(?:finished|done)\b", re.I),
                re.compile(r"\b(?:i have finished|i(?:'m| am) ready to hand (?:it|this) in|i want to hand (?:it|this) in|i(?:'d| would) like to finish|i(?:'d| would) like to turn (?:it|this) in|that(?:'s| is) all for me)\b", re.I),
            ],
        ),
        (
            "REVIEW_MARKED_LIST",
            [
                re.compile(r"\bshow\s+(?:my\s+)?marked\s+questions?\b", re.I),
                re.compile(r"\blist\s+(?:my\s+)?marked\b", re.I),
                re.compile(r"\breview\s+marked\b", re.I),
            ],
        ),
        (
            "REVIEW_UNANSWERED",
            [
                re.compile(r"\bread\s+all\s+unanswered\b", re.I),
                re.compile(r"\bunanswered\s+questions?\b", re.I),
                re.compile(r"\bshow\s+(?:all\s+)?unanswered\b", re.I),
                re.compile(r"\bwhich\s+(?:ones|questions)\s+(?:are\s+)?(?:still\s+)?unanswered\b", re.I),
                re.compile(r"\bwhich\s+(?:questions|ones)\s+(?:haven\'?t\s+i|have\s+i\s+not)\s+answered\b", re.I),
                re.compile(r"\bwhich\s+ones\s+did\s+i\s+miss\b", re.I),
                re.compile(r"\bhow\s+many\s+questions\s+(?:are\s+)?left\b", re.I),
                re.compile(r"\bhaven\'?t\s+i\s+answered\b", re.I),
                re.compile(r"\bwhat\s+(?:have\s+i\s+not|haven\'?t\s+i)\s+answered\b", re.I),
                re.compile(r"\btell\s+me\s+what(?:\'?s| is)\s+left\b", re.I),
                re.compile(r"\bwhat(?:\'?s| is)\s+left\b", re.I),
            ],
        ),
        (
            "QUERY_PROGRESS",
            [
                re.compile(r"\bwhat(?:\'?s| is)\s+my\s+progress\b", re.I),
                re.compile(r"\bhow\s+many\s+have\s+i\s+completed\b", re.I),
                re.compile(r"\bhow\s+many\s+(?:questions\s+)?(?:have\s+i\s+)?answered\b", re.I),
            ],
        ),
        (
            "REVIEW_EXAM",
            [
                re.compile(r"\breview\s+(?:my\s+)?(?:exam|paper|answers?)\b", re.I),
                re.compile(r"\b(?:i\s+want\s+to\s+)?check\s+my\s+answers?\b", re.I),
                re.compile(r"^\s*review\s+exam\s*$", re.I),
                re.compile(r"^\s*review\s+paper\s*$", re.I),
            ],
        ),
        (
            "READ_ANSWER",
            [
                re.compile(r"\bread\s+my\s+answer\b", re.I),
                re.compile(r"\bwhat\s+did\s+i\s+answer\b", re.I),
                re.compile(r"\bwhat(?:\'?s| is)\s+my\s+(?:saved\s+)?answer\b", re.I),
                re.compile(r"\bwhat did i put for (?:this|that|the current) question\b", re.I),
                re.compile(r"\bcan you remind me what i (?:said|answered)\b", re.I),
            ],
        ),
        (
            "READ_OPTIONS",
            [
                re.compile(r"\bread\s+(?:the\s+)?(?:options|choices)\b", re.I),
                re.compile(r"\bwhat\s+are\s+the\s+(?:options|choices)\b", re.I),
                re.compile(r"\bwhat can i choose\b", re.I),
                re.compile(r"\bwhat are my choices\b", re.I),
            ],
        ),
        (
            "CLEAR_ANSWER",
            [
                re.compile(r"\b(?:clear|remove|delete|erase)\s+my\s+answer\b", re.I),
                re.compile(r"^\s*clear\s+answer\s*$", re.I),
            ],
        ),
        (
            "CHANGE_ANSWER",
            [
                re.compile(r"^\s*change\s+my\s+answer\s*$", re.I),
                re.compile(r"^\s*edit\s+my\s+answer\s*$", re.I),
            ],
        ),
        (
            "STOP_SPEECH",
            [
                re.compile(r"^\s*(?:silence|be quiet)\s*$", re.I),
                re.compile(r"\bstop\s+(?:speaking|reading)\b", re.I),
            ],
        ),
        (
            "QUERY_TIMER",
            [
                re.compile(r"\bhow\s+much\s+time\s+(?:is\s+)?left\b", re.I),
                re.compile(r"\btell\s+me\s+my\s+remaining\s+time\b", re.I),
                re.compile(r"\btime\s+(?:remaining|left)\b", re.I),
                re.compile(r"\bwhat(?:\'?s| is)\s+(?:the\s+)?(?:remaining\s+)?time\b", re.I),
                re.compile(r"\bremaining\s+time\b", re.I),
                re.compile(r"\btell\s+me\s+the\s+timer\b", re.I),
                re.compile(r"\bhow long do i have left\b", re.I),
                re.compile(r"\bwhen does (?:the exam|this test) end\b", re.I),
            ],
        ),
        (
            "HELP",
            [
                re.compile(r"\bgive\s+me\s+help\b", re.I),
                re.compile(r"\bwhat can i (?:say|do)\b", re.I),
                re.compile(r"^\s*help(?:\s+me)?\s*$", re.I),
                re.compile(r"\bvoice commands?\b", re.I),
            ],
        ),
        (
            "PAUSE",
            [
                re.compile(r"^\s*pause(?:\s+(?:listening|voice|exam))?\s*$", re.I),
            ],
        ),
        (
            "RESUME",
            [
                re.compile(r"^\s*resume(?:\s+(?:listening|voice|exam))?\s*$", re.I),
            ],
        ),
        (
            "UNMARK_QUESTION",
            [
                re.compile(r"\bunmark\s+(?:this|the)?\s*question\b", re.I),
                re.compile(r"\bremove\s+(?:the\s+)?flag\b", re.I),
                re.compile(r"\bunflag\s+(?:this|the)?\s*question\b", re.I),
                re.compile(r"\bunmark\s+(?:for\s+)?review\b", re.I),
                re.compile(r"^\s*unmark\s*$", re.I),
            ],
        ),
        (
            "MARK_QUESTION",
            [
                re.compile(r"\bmark\s+(?:this|the)\s+question\b", re.I),
                re.compile(r"\bflag\s+(?:this|the)\s+question\b", re.I),
                re.compile(r"\bmark\s+(?:for\s+)?review\b", re.I),
            ],
        ),
        (
            "REPEAT_PROMPT",
            [
                re.compile(r"^\s*repeat(?:\s+(?:the\s+)?question)?\s*$", re.I),
                re.compile(r"\bread\s+(?:the\s+)?question\s+again\b", re.I),
                re.compile(r"\bsay\s+(?:the\s+)?question\s+again\b", re.I),
                re.compile(r"\bread\s+that\s+again\b", re.I),
                re.compile(r"\bsay\s+that\s+again\b", re.I),
                re.compile(r"\bread\s+(?:it|again)\b", re.I),
                re.compile(r"\bread\s+(?:the\s+)?question\b(?!\s+\d)", re.I),
                re.compile(r"\bi didn\'?t hear that\b", re.I),
                re.compile(r"\b(?:i didn'?t|i did not) catch (?:that|the question|what you said)\b", re.I),
                re.compile(r"\b(?:i didn'?t|i did not|couldn'?t|cannot|can'?t) hear (?:the question|that|you)\b", re.I),
                re.compile(r"\b(?:could|would) you (?:please )?(?:repeat|say that again|read that again)\b", re.I),
                re.compile(r"\bwhat was the question again\b", re.I),
                re.compile(r"\bi missed what you said\b", re.I),
            ],
        ),
        (
            "NAVIGATE_NEXT",
            [
                re.compile(r"^\s*next\s*$", re.I),
                re.compile(r"\bnext\s+question\b", re.I),
                re.compile(r"\bshow\s+(?:me\s+)?(?:the\s+)?next\s+question\b", re.I),
                re.compile(r"\btake\s+me\s+forward\b", re.I),
                re.compile(r"\bgo\s+(?:to\s+)?(?:the\s+)?next\b", re.I),
                re.compile(r"\bmove\s+(?:on|forward)\b", re.I),
                re.compile(r"\bgo\s+forward\b", re.I),
                re.compile(r"\blet\'?s\s+move\s+to\s+the\s+next\b", re.I),
                re.compile(r"\bthe\s+next\s+one\b", re.I),
                re.compile(r"\b(?:i am|i'm) ready for (?:the )?next (?:one|question)\b", re.I),
                re.compile(r"\bcan we (?:move|go) on\b", re.I),
                re.compile(r"\b(?:i|we) can move on to (?:the )?next\b", re.I),
                re.compile(r"\bi(?:'d| would) like to continue\b", re.I),
                re.compile(r"\bshow me another question\b", re.I),
                re.compile(r"\blet(?:'s| us) do another one\b", re.I),
                re.compile(r"\bi(?:'m| am) ready for another question\b", re.I),
                re.compile(r"\b(?:can|could) we go to another question\b", re.I),
                re.compile(r"\bi(?:'m| am) done with this question\b", re.I),
            ],
        ),
        (
            "NAVIGATE_PREV",
            [
                re.compile(r"^\s*previous\s*$", re.I),
                re.compile(r"^\s*back\s*$", re.I),
                re.compile(r"\bprevious\s+question\b", re.I),
                re.compile(r"\bgo\s+back\b", re.I),
                re.compile(r"\btake\s+me\s+back\b", re.I),
                re.compile(r"\bprior\s+question\b", re.I),
                re.compile(r"\bmove\s+to\s+the\s+previous\b", re.I),
                re.compile(r"\bcan we go back (?:to )?(?:the )?(?:last|previous|one before)\b", re.I),
                re.compile(r"\bi want to look at the previous (?:one|question) again\b", re.I),
                re.compile(r"\bshow me the question before this one\b", re.I),
            ],
        ),
    ]

    NAVIGATE_PATTERNS = [
        re.compile(
            r"\b(?:go\s+to|take\s+me\s+to|jump\s+to|open|navigate\s+to|show|i want to see|can you take me to)\s+"
            r"(?:question\s+|number\s+)?(?P<num>\d+|one|two|three|four|five|six|seven|"
            r"eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|"
            r"sixteen|seventeen|eighteen|nineteen|twenty)\b",
            re.I,
        ),
        re.compile(
            r"\b(?:review|read)\s+question\s+(?P<num>\d+|seventeen|sixteen|fifteen|fourteen|"
            r"thirteen|twelve|eleven|ten|one|two|three|four|five|six|seven|"
            r"eight|nine|eighteen|nineteen|twenty)\b",
            re.I,
        ),
        re.compile(
            r"^\s*question\s+(?P<num>\d+|seventeen|sixteen|fifteen|fourteen|"
            r"thirteen|twelve|eleven|ten|one|two|three|four|five|six|seven|"
            r"eight|nine|eighteen|nineteen|twenty)\s*$",
            re.I,
        ),
    ]

    READ_ANSWER_N = re.compile(
        r"\b(?:what did i answer for|read my answer for|my answer for)\s+"
        r"(?:question\s+)?(?P<num>\d+|one|two|three|four|five|six|seven|"
        r"eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|"
        r"sixteen|seventeen|eighteen|nineteen|twenty)\b",
        re.I,
    )

    MCQ_PATTERNS = [
        re.compile(
            r"\b(?:choose|select|pick|option|answer|my answer is|i choose|i select|i want)\s*(?:option\s*)?(?P<opt>[A-Da-d])\b",
            re.I,
        ),
        re.compile(
            r"\b(?:i think|i believe|i feel|probably|maybe)\s+(?:it is|it's|the answer is\s+)?(?:option\s+)?(?P<opt>[A-Da-d])\b",
            re.I,
        ),
        re.compile(
            r"\b(?:i(?:'d| would) go with|i(?:'m| am) going with|i(?:'d| would) choose)\s+(?:option\s+)?(?P<opt>[A-Da-d])\b",
            re.I,
        ),
        re.compile(
            r"\bthe correct (?:one|choice|option) is\s+(?:option\s+)?(?P<opt>[A-Da-d])\b",
            re.I,
        ),
        re.compile(
            r"\bchange(?:\s+my\s+answer)?\s+to\s+(?:option\s+)?(?P<opt>[A-Da-d])\b",
            re.I,
        ),
        re.compile(
            r"\b(?:i want\s+)?option\s+(?P<opt>[A-Da-d])\s+instead\b",
            re.I,
        ),
        re.compile(r"^\s*(?P<opt>[A-Da-d])\s*$", re.I),
        re.compile(
            r"\b(?:the\s+)?answer\s+is\s+(?P<opt>[A-Da-d])\b",
            re.I,
        ),
        re.compile(r"\b(?:the\s+)?first\s+option\b", re.I),
        re.compile(r"\b(?:the\s+)?second\s+option\b", re.I),
        re.compile(r"\b(?:the\s+)?third\s+option\b", re.I),
        re.compile(r"\b(?:the\s+)?fourth\s+option\b", re.I),
    ]

    ORDINAL_OPTIONS = {
        "first": "A",
        "second": "B",
        "third": "C",
        "fourth": "D",
    }

    MATH_HINT = re.compile(
        r"\b(?:squared|cubed|power|root|sqrt|times|multiplied|divided|percent|over|equal)\b"
        r"|(?:\b\d*[xyzabc]\b.*\b(?:plus|minus|equals|squared|\^|\=)\b)"
        r"|\b(?:plus|minus|equals)\b.*\b\d*[xyzabc]\b",
        re.I,
    )

    def __init__(self, compiler: Optional[SpokenMathCompiler] = None) -> None:
        self.math = compiler or math_compiler

    def _parse_number_token(self, token: str) -> Optional[int]:
        token = token.strip().lower()
        if token.isdigit():
            return int(token)
        return self.NUMBER_WORDS.get(token)

    def parse(self, transcript: str) -> ParsedIntent:
        raw = (transcript or "").strip()
        if not raw:
            return ParsedIntent(intent="UNKNOWN", raw=raw, confidence=0.0)

        simple_command = classify_command(raw)
        command_intents = {
            "start_exam": "START_EXAM",
            "next_question": "NAVIGATE_NEXT",
            "repeat_question": "REPEAT_PROMPT",
            "submit_answer": "SUBMIT_ANSWER",
            "submit_exam": "CONFIRM_SUBMIT",
            "yes": "CONFIRM_YES",
            "no": "CONFIRM_NO",
        }
        if simple_command["intent"] in command_intents:
            return ParsedIntent(
                intent=command_intents[simple_command["intent"]],
                raw=raw,
                confidence=0.98,
            )

        natural_start = re.search(
            r"\b(?:i(?:'d| would) like to|i want to|can i|could i|may i|let me|"
            r"i am ready to|i'm ready to)\s+(?:take|start|begin|sit|do)\s+"
            r"(?:(?:the|my)\s+)?(?P<exam>[\w '&-]*?)\s*"
            r"(?:exam(?:ination)?|test|paper)\b",
            raw,
            re.I,
        )
        if natural_start:
            exam_name = re.sub(
                r"\s+", " ", natural_start.group("exam")
            ).strip(" '.,!?-")
            return ParsedIntent(
                intent="START_EXAM_NAMED" if exam_name else "START_EXAM",
                target=exam_name or None,
                raw=raw,
                confidence=0.9,
            )

        # Check for reading answer for a specific question
        read_ans = self.READ_ANSWER_N.search(raw)
        if read_ans:
            num = self._parse_number_token(read_ans.group("num"))
            if num is not None:
                return ParsedIntent(intent="READ_ANSWER", target=num, raw=raw, confidence=0.95)

        # Discrete command matrix
        for intent_name, patterns in self.COMMAND_MATRIX:
            for pat in patterns:
                if pat.search(raw):
                    extra_target = None
                    if intent_name == "READ_ANSWER":
                        mnum = re.search(r"question\s+(\d+)", raw, re.I)
                        if mnum:
                            extra_target = int(mnum.group(1))
                    return ParsedIntent(
                        intent=intent_name, target=extra_target, raw=raw, confidence=0.95
                    )

        if re.search(
            r"\b(?:i(?:'d| would) like to|i want to|can i|could i|"
            r"i am ready to|i'm ready to)\s+(?:continue|carry on|pick up)\b"
            r"|\blet me (?:continue|carry on) (?:with )?(?:my )?(?:exam|test)\b",
            raw,
            re.I,
        ):
            return ParsedIntent(intent="RESUME_EXAM", raw=raw, confidence=0.9)

        # Non-linear navigation / read question N
        for pat in self.NAVIGATE_PATTERNS:
            m = pat.search(raw)
            if m:
                num = self._parse_number_token(m.group("num"))
                if num is not None:
                    readish = bool(re.search(r"\b(read|hear|again)\b", raw, re.I))
                    return ParsedIntent(
                        intent="READ_QUESTION" if readish else "NAVIGATE",
                        target=num,
                        raw=raw,
                        confidence=0.95,
                    )

        # MCQ option selection
        low = raw.lower()
        for word, opt in self.ORDINAL_OPTIONS.items():
            if f"{word} option" in low:
                return ParsedIntent(
                    intent="SUBMIT_MCQ", option=opt, answer=opt, raw=raw, confidence=0.9
                )
        for pat in self.MCQ_PATTERNS:
            m = pat.search(raw)
            if m and m.groupdict().get("opt"):
                opt = m.group("opt").upper()
                return ParsedIntent(
                    intent="SUBMIT_MCQ",
                    option=opt,
                    answer=opt,
                    raw=raw,
                    confidence=0.92,
                )

        # Pre-process numbers into digits for numerical / math testing
        norm_numbers, _ = replace_spoken_numbers(raw)
        answer_prefix = (
            r"^(?:(?:well|so|um|uh)\s+)*(?:(?:i think|i believe|i guess)\s+)?"
            r"(?:(?:my|the)\s+answer\s+(?:is|would be)|"
            r"answer\s+(?:is|would be)|i(?:'d| would) say|"
            r"i(?:'m| am) going with|i choose|i pick|"
            r"the result is|that makes|it is|it's)\s*"
        )
        norm_clean = re.sub(
            answer_prefix, "", norm_numbers.strip(), flags=re.I
        ).strip()
        norm_clean = re.sub(r"^(?:it\s+is|is)\s+", "", norm_clean, flags=re.I).strip()
        norm_clean = re.sub(r"^(?:minus|negative)\s+(\d+(?:\.\d+)?)", r"-\1", norm_clean, flags=re.I)

        # Is this an algebraic equation or mathematical expression?
        is_math = bool(
            self.MATH_HINT.search(raw)
            or re.search(r"\b\d*[xyz]\b", raw, re.I)
            or any(w in raw.lower() for w in ("squared", "cubed", "power", "root", "percent", "times", "divided"))
        )

        if not is_math:
            # Check if norm_clean is a pure numerical answer: "-3", "50", "7.5", "120"
            m_num = re.match(r"^-?\d+(?:\.\d+)?$", norm_clean)
            if m_num:
                return ParsedIntent(
                    intent="SUBMIT_NUMERICAL",
                    answer=norm_clean,
                    raw=raw,
                    confidence=0.95,
                )

        # Spoken mathematics / algebra steps
        if is_math or any(t in raw.lower() for t in ("plus", "minus", "equals", "equal to")):
            math_input = re.sub(
                r"^(?:(?:well|so|um|uh)\s+)*(?:(?:i think|i believe|i guess)\s+)?"
                r"(?:(?:my|the)\s+answer\s+(?:is|would be)|"
                r"answer\s+(?:is|would be)|i(?:'d| would) say|"
                r"the result is|it comes to|it is|it's)\s*",
                "",
                raw,
                flags=re.I,
            )
            parsed_math = self.math.compile(math_input)
            return ParsedIntent(
                intent="SUBMIT_MATH",
                answer=parsed_math.latex,
                math_latex=parsed_math.latex,
                raw=raw,
                confidence=0.88,
                meta={"tokens": parsed_math.tokens_applied},
            )

        # Soft numerical fallback
        m_num = re.match(r"^-?\d+(?:\.\d+)?$", norm_clean)
        if m_num:
            return ParsedIntent(
                intent="SUBMIT_NUMERICAL",
                answer=norm_clean,
                raw=raw,
                confidence=0.85,
            )

        # Soft math fallback: if compiled latex has mathematical operators
        soft = self.math.compile(raw)
        if soft.tokens_applied and ("=" in soft.latex or "^" in soft.latex or any(c in soft.latex for c in "+-*/%")):
            return ParsedIntent(
                intent="SUBMIT_MATH",
                answer=soft.latex,
                math_latex=soft.latex,
                raw=raw,
                confidence=0.7,
                meta={"tokens": soft.tokens_applied},
            )

        return ParsedIntent(intent="UNKNOWN", raw=raw, confidence=0.2)


# Module-level router instance
intent_parser = IntentParser()
