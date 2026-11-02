const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

const TOKEN_KEY = "adaptiq_token";

export function getApiBase() {
  return API_BASE.replace(/\/$/, "");
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
      sessionStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    /* ignore storage quotas or sandboxing */
  }
}

function authHeaders(extra = {}) {
  const token = getToken();
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function parseBody(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text };
  }
}

async function request(path, options = {}) {
  const headers = authHeaders(options.headers || {});
  if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  let res;
  try {
    res = await fetch(`${getApiBase()}${path}`, { ...options, headers });
  } catch (err) {
    const error = new Error("Backend unavailable. Check that the API is running on port 8000.");
    error.cause = err;
    error.status = 0;
    throw error;
  }
  const data = await parseBody(res);
  if (!res.ok) {
    if (res.status === 401 && !path.includes("/api/auth/login")) {
      setToken(null);
    }
    const message =
      data.detail ||
      data.error ||
      (typeof data.message === "string" ? data.message : null) ||
      `Request failed (${res.status})`;
    const error = new Error(typeof message === "string" ? message : JSON.stringify(message));
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

export const api = {
  health: () => request("/api/health"),
  login: (username, password) =>
    request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  registerStudent: (payload) =>
    request("/api/auth/students/register", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  studentProfile: () => request("/api/auth/students/me"),
  me: () => request("/api/auth/me"),
  logout: () => request("/api/auth/logout", { method: "POST" }),
  listExams: () => request("/api/exams"),
  getExam: (examId) => request(`/api/exam/${encodeURIComponent(examId)}`),
  startSession: (examId, forceNew = false) =>
    request("/api/session/start", {
      method: "POST",
      body: JSON.stringify({ exam_id: examId, force_new: forceNew }),
    }),
  activeSession: (examId) =>
    request(`/api/session/active${examId ? `?exam_id=${encodeURIComponent(examId)}` : ""}`),
  getSession: (sessionId) => request(`/api/session/${encodeURIComponent(sessionId)}`),
  sendTranscript: (sessionId, text) =>
    request(`/api/session/${encodeURIComponent(sessionId)}/transcript`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  gotoQuestion: (sessionId, questionNumber) =>
    request(`/api/session/${encodeURIComponent(sessionId)}/goto`, {
      method: "POST",
      body: JSON.stringify({ question_number: questionNumber }),
    }),
  saveAnswer: (sessionId, recordedAnswer, spokenTranscript) =>
    request(`/api/session/${encodeURIComponent(sessionId)}/answer`, {
      method: "POST",
      body: JSON.stringify({
        recorded_answer: recordedAnswer,
        spoken_transcript: spokenTranscript || null,
      }),
    }),
  clearAnswer: (sessionId) =>
    request(`/api/session/${encodeURIComponent(sessionId)}/clear-answer`, { method: "POST" }),
  requestSubmit: (sessionId) =>
    request(`/api/session/${encodeURIComponent(sessionId)}/submit`, { method: "POST" }),
  confirmSubmit: (sessionId) =>
    request(`/api/session/${encodeURIComponent(sessionId)}/confirm-submit`, { method: "POST" }),
  cancelSubmit: (sessionId) =>
    request(`/api/session/${encodeURIComponent(sessionId)}/cancel-submit`, { method: "POST" }),
  getResponses: (sessionId) => request(`/api/session/${encodeURIComponent(sessionId)}/responses`),
  getResults: (sessionId) => request(`/api/session/${encodeURIComponent(sessionId)}/results`),
  myResults: () => request("/api/me/results"),
  adminStats: () => request("/api/admin/stats"),
  adminExams: () => request("/api/admin/exams"),
  adminExam: (examId) => request(`/api/admin/exams/${encodeURIComponent(examId)}`),
  createExam: (payload) =>
    request("/api/admin/exams", { method: "POST", body: JSON.stringify(payload) }),
  updateExam: (examId, payload) =>
    request(`/api/admin/exams/${encodeURIComponent(examId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  publishExam: (examId) =>
    request(`/api/admin/exams/${encodeURIComponent(examId)}/publish`, { method: "POST" }),
  unpublishExam: (examId) =>
    request(`/api/admin/exams/${encodeURIComponent(examId)}/unpublish`, { method: "POST" }),
  deleteExam: (examId) =>
    request(`/api/admin/exams/${encodeURIComponent(examId)}`, { method: "DELETE" }),
  upsertQuestion: (examId, payload) =>
    request(`/api/admin/exams/${encodeURIComponent(examId)}/questions`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  importQuestions: (examId, questions) =>
    request(`/api/admin/exams/${encodeURIComponent(examId)}/questions/import`, {
      method: "POST",
      body: JSON.stringify({ questions }),
    }),
  verifyQuestion: (questionId, verified = true) =>
    request(`/api/admin/questions/${questionId}/verify`, {
      method: "POST",
      body: JSON.stringify({ verified }),
    }),
  deleteQuestion: (questionId) =>
    request(`/api/admin/questions/${questionId}`, { method: "DELETE" }),
  adminAttempts: (examId) =>
    request(`/api/admin/attempts${examId ? `?exam_id=${encodeURIComponent(examId)}` : ""}`),
  uploadPaper: async (file) => {
    const form = new FormData();
    form.append("file", file);
    return request("/api/admin/upload-paper", { method: "POST", body: form });
  },
};

export function wsExamUrl() {
  if (typeof window === "undefined") return "";
  const url = new URL(getApiBase() || window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/exam-session";
  url.search = "";
  return url.toString();
}
