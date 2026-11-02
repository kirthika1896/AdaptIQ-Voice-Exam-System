"""
Layer 3 — Spoken Math parsing lexer engine.
Maps natural-language algebraic speech into LaTeX / symbolic strings.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

WORD_TO_DIGIT = {
    "zero": "0",
    "one": "1",
    "two": "2",
    "three": "3",
    "four": "4",
    "five": "5",
    "six": "6",
    "seven": "7",
    "eight": "8",
    "nine": "9",
    "ten": "10",
    "eleven": "11",
    "twelve": "12",
    "thirteen": "13",
    "fourteen": "14",
    "fifteen": "15",
    "sixteen": "16",
    "seventeen": "17",
    "eighteen": "18",
    "nineteen": "19",
    "twenty": "20",
    "thirty": "30",
    "forty": "40",
    "fifty": "50",
    "sixty": "60",
    "seventy": "70",
    "eighty": "80",
    "ninety": "90",
}

ONES_VAL = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4,
    "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
    "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
    "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17,
    "eighteen": 18, "nineteen": 19,
}

TENS_VAL = {
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
}

NUMBER_WORDS = tuple(ONES_VAL) + tuple(TENS_VAL) + ("hundred", "thousand", "million")
NUMBER_WORD_PATTERN = "|".join(
    re.escape(word) for word in sorted(NUMBER_WORDS, key=len, reverse=True)
)


def replace_spoken_numbers(text: str) -> tuple[str, list[str]]:
    """Converts written number words into numerical digits across scales."""
    applied: list[str] = []

    # Fractions before single units
    text = re.sub(r"\bone half\b", "1/2", text, flags=re.IGNORECASE)
    text = re.sub(r"\bone third\b", "1/3", text, flags=re.IGNORECASE)
    text = re.sub(r"\btwo thirds\b", "2/3", text, flags=re.IGNORECASE)
    text = re.sub(r"\b(?:one quarter|one fourth)\b", "1/4", text, flags=re.IGNORECASE)
    text = re.sub(r"\b(?:three quarters|three fourths)\b", "3/4", text, flags=re.IGNORECASE)

    def _sub_large_number(m: re.Match) -> str:
        words = re.findall(NUMBER_WORD_PATTERN, m.group(0).lower())
        if not any(word in {"thousand", "million"} for word in words):
            return m.group(0)

        total = 0
        current = 0
        for word in words:
            if word == "and":
                continue
            if word in ONES_VAL:
                current += ONES_VAL[word]
            elif word in TENS_VAL:
                current += TENS_VAL[word]
            elif word == "hundred":
                current = max(current, 1) * 100
            elif word == "thousand":
                total += max(current, 1) * 1_000
                current = 0
            elif word == "million":
                total += max(current, 1) * 1_000_000
                current = 0

        applied.append(f"number:{m.group(0)}")
        return str(total + current)

    text = re.sub(
        rf"\b(?:{NUMBER_WORD_PATTERN})(?:[\s-]+(?:and[\s-]+)?(?:{NUMBER_WORD_PATTERN}))*\b",
        _sub_large_number,
        text,
        flags=re.IGNORECASE,
    )

    # 1. Hundreds + tens + units (e.g. "one hundred and forty four" -> "144")
    def _sub_h_tens(m: re.Match) -> str:
        h = ONES_VAL[m.group(1).lower()] * 100
        t = TENS_VAL[m.group(2).lower()]
        u = ONES_VAL[m.group(3).lower()] if m.group(3) else 0
        applied.append(f"number:{m.group(0)}")
        return str(h + t + u)

    text = re.sub(
        r"\b(one|two|three|four|five|six|seven|eight|nine)\s+hundred(?:\s+and)?\s+"
        r"(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\s\-]+(one|two|three|four|five|six|seven|eight|nine))?\b",
        _sub_h_tens,
        text,
        flags=re.IGNORECASE,
    )

    # 2. Hundreds + teens/units (e.g. "one hundred and five" -> "105", "two hundred twelve" -> "212")
    def _sub_h_units(m: re.Match) -> str:
        h = ONES_VAL[m.group(1).lower()] * 100
        u = ONES_VAL[m.group(2).lower()]
        applied.append(f"number:{m.group(0)}")
        return str(h + u)

    text = re.sub(
        r"\b(one|two|three|four|five|six|seven|eight|nine)\s+hundred(?:\s+and)?\s+"
        r"(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b",
        _sub_h_units,
        text,
        flags=re.IGNORECASE,
    )

    # 3. Pure hundreds (e.g. "one hundred" -> "100")
    def _sub_h(m: re.Match) -> str:
        h = ONES_VAL[m.group(1).lower()] * 100
        applied.append(f"number:{m.group(0)}")
        return str(h)

    text = re.sub(
        r"\b(one|two|three|four|five|six|seven|eight|nine)\s+hundred\b",
        _sub_h,
        text,
        flags=re.IGNORECASE,
    )

    # 4. Tens + units (e.g. "twenty five" -> "25", "fifty" -> "50")
    def _sub_tens(m: re.Match) -> str:
        t = TENS_VAL[m.group(1).lower()]
        u = ONES_VAL[m.group(2).lower()] if m.group(2) else 0
        applied.append(f"number:{m.group(0)}")
        return str(t + u)

    text = re.sub(
        r"\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\s\-]+(one|two|three|four|five|six|seven|eight|nine))?\b",
        _sub_tens,
        text,
        flags=re.IGNORECASE,
    )

    # 5. Units & teens ("zero" through "nineteen")
    for word, digit in sorted(ONES_VAL.items(), key=lambda kv: -len(kv[0])):
        pattern = rf"\b{re.escape(word)}\b"
        if re.search(pattern, text, flags=re.IGNORECASE):
            text = re.sub(pattern, str(digit), text, flags=re.IGNORECASE)
            applied.append(f"number:{word}")

    # Keep spoken decimal digits separate: "seven point zero five" -> "7.05".
    def _sub_decimal(m: re.Match) -> str:
        whole = m.group(1) or "0"
        fraction = re.sub(r"\s+", "", m.group(2))
        return f"{whole}.{fraction}"

    text = re.sub(
        r"(?:(\d+)\s+)?point\s+(\d+(?:\s+\d+)*)\b",
        _sub_decimal,
        text,
        flags=re.IGNORECASE,
    )

    return text, applied


@dataclass
class MathParseResult:
    latex: str
    spoken_normalized: str
    tokens_applied: list[str] = field(default_factory=list)
    is_equation: bool = False


class SpokenMathCompiler:
    """
    Compiles unrestricted spoken algebra into programmatic LaTeX strings
    using ordered regex replacement arrays and conversational number maps.
    """

    # Ordered: longer / more specific phrases first
    REPLACEMENT_RULES: list[tuple[str, str, str]] = [
        # (pattern, replacement, label)
        (r"\bsquare root of\b", r"\\sqrt", "sqrt_of"),
        (r"\bsquare root\b", r"\\sqrt", "sqrt"),
        (r"\bcube root of\b", r"\\sqrt[3]", "cube_root_of"),
        (r"\bcube root\b", r"\\sqrt[3]", "cube_root"),
        (r"\broot of\b", r"\\sqrt", "root_of"),
        (r"\braised to the power of\b", "^", "raised_power_of"),
        (r"\bto the power of\b", "^", "power_of"),
        (r"\braised to\b", "^", "raised_to"),
        (r"\bto the power\b", "^", "to_power"),
        (r"\bpower of\b", "^", "power_of"),
        (r"\bpower\b", "^", "power"),
        (r"\bsquared\b", "^2", "squared"),
        (r"\bsquare\b", "^2", "square"),
        (r"\bcubed\b", "^3", "cubed"),
        (r"\bcube\b", "^3", "cube"),
        (r"\bpercentage\b", "%", "percent"),
        (r"\bpercent\b", "%", "percent"),
        (r"\bhalf\b", "1/2", "fraction_half"),
        (r"\bis equal to\b", "=", "is_equal_to"),
        (r"\bis the same as\b", "=", "same_as"),
        (r"\bequal to\b", "=", "equal_to"),
        (r"\bequals\b", "=", "equals"),
        (r"\bplus\b", "+", "plus"),
        (r"\badd(?:ed)?\b", "+", "add"),
        (r"\bminus\b", "-", "minus"),
        (r"\bsubtract(?:ed)?\b", "-", "subtract"),
        (r"\bnegative\b", "-", "negative"),
        (r"\btimes\b", r"\\times", "times"),
        (r"\*", r"\\times", "multiply_symbol"),
        (r"\b(?:multiplied|multiply|multiplies) (?:by|with)\b", r"\\times", "multiplied_by"),
        (r"\binto\b", r"\\times", "into"),
        (r"\bdivided by\b", "/", "divided_by"),
        (r"\bover\b", "/", "over"),
        (r"\bopen(?:ing)? (?:paren|bracket|parenthesis)\b", "(", "open_paren"),
        (r"\bclose(?:ing)? (?:paren|bracket|parenthesis)\b", ")", "close_paren"),
        (r"\bleft parenthesis\b", "(", "left_paren"),
        (r"\bright parenthesis\b", ")", "right_paren"),
    ]

    VARIABLE_ALIASES = {
        r"\bx\b": "x",
        r"\by\b": "y",
        r"\bz\b": "z",
        r"\ba\b": "a",
        r"\bb\b": "b",
        r"\bc\b": "c",
        r"\bn\b": "n",
    }

    def __init__(self) -> None:
        self._history: list[MathParseResult] = []

    def normalize_spoken(self, text: str) -> str:
        s = text.lower().strip()
        s = s.translate(str.maketrans({"×": "*", "÷": "/", "−": "-", "–": "-", "—": "-"}))
        s = s.replace("²", " squared ").replace("³", " cubed ")
        s = re.sub(r"[^\w\s\+\-\=\^\(\)\/\.\%\*]", " ", s)
        s = re.sub(r"\s+", " ", s).strip()
        return s

    def _replace_number_words(self, text: str) -> tuple[str, list[str]]:
        return replace_spoken_numbers(text)

    def compile(self, spoken: str) -> MathParseResult:
        normalized = self.normalize_spoken(spoken)
        working = normalized
        tokens_applied: list[str] = []

        working, num_tokens = self._replace_number_words(working)
        tokens_applied.extend(num_tokens)

        for ordinal, exponent in (
            ("second", "2"),
            ("third", "3"),
            ("fourth", "4"),
            ("fifth", "5"),
            ("sixth", "6"),
            ("seventh", "7"),
            ("eighth", "8"),
            ("ninth", "9"),
            ("tenth", "10"),
        ):
            working = re.sub(
                rf"\bto the {ordinal} power\b",
                f"to the power of {exponent}",
                working,
            )

        working = re.sub(
            r"\bsquare of\s+(\d+|[a-z]+)\b",
            r"\1 squared",
            working,
        )
        working = re.sub(
            r"\bcube of\s+(\d+|[a-z]+)\b",
            r"\1 cubed",
            working,
        )

        for pattern, replacement, label in self.REPLACEMENT_RULES:
            if re.search(pattern, working, flags=re.IGNORECASE):
                working = re.sub(pattern, f" {replacement} ", working, flags=re.IGNORECASE)
                tokens_applied.append(label)

        # Natural language variable references: "unknown variable x", "variable x", "unknown x" -> "x"
        working = re.sub(
            r"\b(?:(?:unknown\s+)?variable|unknown)\s+([a-z])\b",
            r" \1 ",
            working,
            flags=re.IGNORECASE,
        )

        for pattern, var in self.VARIABLE_ALIASES.items():
            working = re.sub(pattern, var, working)

        # Collapse whitespace around operators
        working = re.sub(r"\s+", " ", working).strip()
        working = re.sub(r"\s*([\+\-\=\^\/\(\)])\s*", r" \1 ", working)
        working = re.sub(r"\s+", " ", working).strip()

        # Juxtaposition: "5 x" / "3 x" -> "5x" / "3x"
        latex = working
        latex = re.sub(r"(\d+)\s+([xyzabcn])\b", r"\1\2", latex)   # 5 x -> 5x
        latex = re.sub(r"([a-z])\s+\^\s*(\d+)", r"\1^\2", latex)   # x ^ 2 -> x^2
        latex = re.sub(r"\\times", r"\\times", latex)
        latex = re.sub(r"\s*\\times\s*", r" \\times ", latex)
        latex = re.sub(r"\s*=\s*", " = ", latex)
        latex = re.sub(r"\s*\+\s*", " + ", latex)
        latex = re.sub(r"\s*-\s*", " - ", latex)
        latex = re.sub(r"\s*(\d+)\s*\%", r"\1%", latex)
        latex = re.sub(r"\s+", " ", latex).strip()

        # sqrt / cube root tokens: "\sqrt 144" -> "\sqrt{144}"
        latex = re.sub(r"\\sqrt\[3\]\s+(\d+|[a-z]+)", r"\\sqrt[3]{\1}", latex)
        latex = re.sub(r"\\sqrt\s+(\d+|[a-z]+)", r"\\sqrt{\1}", latex)

        result = MathParseResult(
            latex=latex,
            spoken_normalized=normalized,
            tokens_applied=tokens_applied,
            is_equation="=" in latex,
        )
        self._history.append(result)
        return result

    def append_step(
        self,
        existing_steps: list[dict],
        spoken: str,
        *,
        edit_index: Optional[int] = None,
    ) -> list[dict]:
        """
        Append a compiled math step, or replace an earlier step via edit_index
        (edit history lookup for stepwise corrections).
        """
        parsed = self.compile(spoken)
        step = {
            "spoken": spoken,
            "latex": parsed.latex,
            "tokens": parsed.tokens_applied,
            "is_equation": parsed.is_equation,
        }
        steps = list(existing_steps)
        if edit_index is not None and 0 <= edit_index < len(steps):
            steps[edit_index] = step
        else:
            steps.append(step)
        return steps

    @property
    def history(self) -> list[MathParseResult]:
        return list(self._history)


# Convenience singleton for route handlers
math_compiler = SpokenMathCompiler()
