"""
Layer 2 — FastAPI master application gateway.
Serves the REST/WebSocket exam API and static frontend assets for local LAN demos.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# Ensure backend package root is importable when launched as `python main.py`
BACKEND_ROOT = Path(__file__).resolve().parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import database as db  # noqa: E402  — initializes SQLite schemas + demo seed
from auth_routes import router as auth_router  # noqa: E402
from exams.rest_routes import router as rest_router  # noqa: E402
from exams.session_routes import router as session_router  # noqa: E402

FRONTEND_DIR = BACKEND_ROOT.parent / "frontend"
FRONTEND_DIST = FRONTEND_DIR / "dist"

app = FastAPI(
    title="AI Voice-Native Examination System",
    description=(
        "100% Hands-Free Voice-Native Examination System for Visually Impaired Students. "
        "Four-layer architecture: Presentation → Gateway → Intelligence → Persistence."
    ),
    version="1.0.0",
)

origins_env = os.getenv("ALLOWED_ORIGINS")
if origins_env:
    allowed_origins = [orig.strip() for orig in origins_env.split(",") if orig.strip()]
else:
    allowed_origins = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(rest_router)
app.include_router(session_router)


@app.get("/api/health")
async def health() -> dict:
    exam = db.get_exam(db.DEMO_EXAM_ID)
    return {
        "ok": True,
        "service": "ai-voice-exam-system",
        "database": str(db.DB_PATH),
        "demo_exam_loaded": exam is not None,
        "demo_exam_id": db.DEMO_EXAM_ID,
    }


@app.get("/")
async def root_index() -> FileResponse:
    if FRONTEND_DIST.exists() and (FRONTEND_DIST / "index.html").exists():
        return FileResponse(FRONTEND_DIST / "index.html")
    index = FRONTEND_DIR / "index.html"
    return FileResponse(index)


# Mount production assets if dist exists
if FRONTEND_DIST.exists() and (FRONTEND_DIST / "assets").exists():
    app.mount(
        "/assets",
        StaticFiles(directory=str(FRONTEND_DIST / "assets")),
        name="frontend_dist_assets",
    )

# Mount development frontend assets
if FRONTEND_DIR.exists():
    app.mount(
        "/src",
        StaticFiles(directory=str(FRONTEND_DIR / "src")),
        name="frontend_src",
    )
    app.mount(
        "/static",
        StaticFiles(directory=str(FRONTEND_DIR)),
        name="frontend_static",
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
    )
