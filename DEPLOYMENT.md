# Deployment

## Production Configuration

Keep `ENABLE_DEMO_SEED` unset or set it to `false`. Set `DATABASE_PATH` to a persistent, writable SQLite file and back up that file before deployment or schema upgrades.

For a new database with no administrator, set `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_PASSWORD` in the deployment environment. The first administrator is created with a password hash; these values are not stored in frontend code. Bootstrap does not replace an existing administrator.

Set `ALLOWED_ORIGINS` to the exact browser origins when the frontend is hosted separately. For a same-origin deployment, leave `VITE_API_BASE_URL` unset in the frontend build. When hosting the frontend separately, build with `VITE_API_BASE_URL` set to the HTTPS API origin. `VITE_API_PROXY_TARGET` is for local Vite development only.

Serve the application behind HTTPS. Speech recognition requires a secure browser context outside localhost. Restrict database file access to the service account and do not expose it through static file hosting.

Install backend requirements, build the frontend with `npm ci` and `npm run build` from `frontend`, then run the API with `uvicorn backend.main:app --host 0.0.0.0 --port 8000` from the project root. The FastAPI app serves the generated frontend assets when `frontend/dist` exists.

## Existing Database Warning

Existing databases are preserved and are not reset. If the database contains the original `admin` / `student` demo accounts, their old credentials remain valid until an operator changes them. Rotate or remove those credentials through an approved database administration process before exposing that database to users. The optional demo accounts are only created on a fresh database when `ENABLE_DEMO_SEED=true` and `DEMO_ADMIN_PASSWORD` / `DEMO_STUDENT_PASSWORD` are explicitly supplied.

Database startup adds the student profile and answer-scoring columns without deleting existing records. An authenticated administrator creates new student accounts from the admin dashboard or through `POST /api/auth/students/register`; this endpoint rejects anonymous and student callers. Students can sign in using either their username or registration number. Exam start and answer endpoints continue to require the existing bearer-token authentication. The browser handles active speech recognition; the API does not run a background microphone loop.

## Local Demo

For a disposable local demonstration only, set `ENABLE_DEMO_SEED=true` and provide `DEMO_ADMIN_PASSWORD` and `DEMO_STUDENT_PASSWORD` before starting the backend. Do not use these demo credentials in production.