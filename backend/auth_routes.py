"""Authentication against persisted users. Tokens are stored in SQLite."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel

import database as db

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginBody(BaseModel):
    username: str
    password: str


class StudentRegistrationBody(BaseModel):
    username: str
    password: str
    registration_number: str
    name: str


def current_user(
    authorization: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Authentication required.")
    token = authorization.split(" ", 1)[1].strip()
    user = db.get_user_by_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired session.")
    return user


def optional_user(
    authorization: Optional[str] = Header(default=None),
) -> Optional[dict[str, Any]]:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    return db.get_user_by_token(authorization.split(" ", 1)[1].strip())


def require_admin(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Administrator access required.")
    return user


def require_student(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if user["role"] != "student":
        raise HTTPException(status_code=403, detail="Student access required.")
    return user


@router.post("/login")
async def login(body: LoginBody) -> dict[str, Any]:
    identity = body.username.strip()
    user = (
        db.get_user_by_username(identity)
        or db.get_user_by_student_identifier(identity)
        or db.get_user(identity)
    )
    if not user or not db.verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    token = db.create_token(user["id"])
    return {"ok": True, "token": token, "user": db.public_user(user)}


@router.post("/students/register", status_code=status.HTTP_201_CREATED)
async def register_student(
    body: StudentRegistrationBody,
    _admin: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    try:
        user, student = db.register_student(
            username=body.username,
            password=body.password,
            registration_number=body.registration_number,
            name=body.name,
        )
    except ValueError as exc:
        message = str(exc)
        code = 409 if "already exists" in message else 422
        raise HTTPException(status_code=code, detail=message) from exc
    return {
        "ok": True,
        "user": db.public_user(user),
        "student": {
            "id": student["id"],
            "registration_number": student["registration_number"],
            "name": student["name"],
        },
    }


@router.get("/students/me")
async def student_profile(
    user: dict[str, Any] = Depends(require_student),
) -> dict[str, Any]:
    student = db.get_student_by_user(user["id"])
    if not student:
        raise HTTPException(status_code=404, detail="Student profile not found.")
    return {
        "ok": True,
        "student": {
            "id": student["id"],
            "user_id": student["user_id"],
            "registration_number": student["registration_number"],
            "name": student["name"],
        },
    }


@router.get("/me")
async def me(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"ok": True, "user": db.public_user(user)}


@router.post("/logout")
async def logout(
    authorization: Optional[str] = Header(default=None),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    if authorization and authorization.lower().startswith("bearer "):
        db.delete_token(authorization.split(" ", 1)[1].strip())
    return {"ok": True, "user_id": user["id"]}
