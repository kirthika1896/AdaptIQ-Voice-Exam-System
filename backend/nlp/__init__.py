"""Deterministic voice-command normalization and classification."""

from .command_parser import classify_command, normalize_command

__all__ = ["classify_command", "normalize_command"]
