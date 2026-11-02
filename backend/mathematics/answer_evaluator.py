"""Safely evaluate numeric spoken-math answers without executing user code."""

from __future__ import annotations

import ast
import operator
import re
from fractions import Fraction
from typing import Optional

from mathematics.parser import math_compiler

MAX_EXPRESSION_LENGTH = 256
MAX_TREE_NODES = 100
MAX_EXPONENT = 12
MAX_INTEGER_DIGITS = 80

_BINARY_OPERATORS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
}


def _fraction_value(node: ast.AST, depth: int = 0) -> Fraction:
    if depth > MAX_TREE_NODES:
        raise ValueError("Expression is too complex.")
    if isinstance(node, ast.Constant) and type(node.value) in (int, float):
        return Fraction(str(node.value))
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        value = _fraction_value(node.operand, depth + 1)
        return value if isinstance(node.op, ast.UAdd) else -value
    if isinstance(node, ast.BinOp):
        left = _fraction_value(node.left, depth + 1)
        right = _fraction_value(node.right, depth + 1)
        if isinstance(node.op, ast.Pow):
            if right.denominator != 1 or abs(right.numerator) > MAX_EXPONENT:
                raise ValueError("Exponent is outside the supported range.")
            if left == 0 and right < 0:
                raise ValueError("Division by zero.")
            value = left ** right.numerator
        else:
            operation = _BINARY_OPERATORS.get(type(node.op))
            if operation is None:
                raise ValueError("Unsupported mathematical operation.")
            if isinstance(node.op, ast.Div) and right == 0:
                raise ValueError("Division by zero.")
            value = operation(left, right)
        if (
            len(str(abs(value.numerator))) > MAX_INTEGER_DIGITS
            or len(str(value.denominator)) > MAX_INTEGER_DIGITS
        ):
            raise ValueError("Expression result is too large.")
        return value
    raise ValueError("Expression contains unsupported syntax.")


def evaluate_numeric_expression(expression: str) -> Optional[Fraction]:
    """Return a numeric value only for a small, allow-listed arithmetic grammar."""
    expression = str(expression or "").strip()
    if not expression or len(expression) > MAX_EXPRESSION_LENGTH:
        return None

    normalized = expression.replace("\\times", "*").replace("\\cdot", "*")
    normalized = normalized.replace("^", "**")
    if re.search(r"[^0-9\s.+\-*/()]", normalized):
        return None
    try:
        parsed = ast.parse(normalized, mode="eval")
        return _fraction_value(parsed.body)
    except (SyntaxError, ValueError, ZeroDivisionError, OverflowError):
        return None


def _canonical_math(expression: str) -> str:
    parsed = math_compiler.compile(expression)
    return re.sub(r"\s+", "", parsed.latex.replace("\\times", "*").lower())


def assess_math_answer(
    question: dict,
    answer: str,
    transcript: Optional[str] = None,
) -> tuple[Optional[str], Optional[bool]]:
    """Return a parsed expression and a correctness value when grading is safe."""
    question_type = str(question.get("type") or "").upper()
    if question_type not in {"NUMERICAL", "MATHEMATICS"}:
        return None, None

    spoken = transcript.strip() if transcript and transcript.strip() else answer
    if question_type == "NUMERICAL" and evaluate_numeric_expression(answer) is not None:
        spoken = answer
    parsed = math_compiler.compile(spoken)
    expression = parsed.latex
    given_value = evaluate_numeric_expression(expression)
    expected_answer = str(question.get("correct_answer") or "").strip()
    expected_expression = math_compiler.compile(expected_answer).latex if expected_answer else ""
    expected_value = evaluate_numeric_expression(expected_expression)

    if given_value is not None and expected_value is not None:
        return expression, given_value == expected_value
    if question_type == "MATHEMATICS" and expected_answer:
        if _canonical_math(spoken) == _canonical_math(expected_answer):
            return expression, True
    return expression, None
