const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, first: 1,
  second: 2, third: 3,
};

function parseNumber(token) {
  if (!token) return null;
  const t = String(token).toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  return NUMBER_WORDS[t] ?? null;
}

export function parseAppIntent(transcript) {
  const raw = (transcript || "").trim();
  const text = raw.toLowerCase();
  if (!text) return { intent: "UNKNOWN", raw };

  if (/\b(student login|login as student|sign in as student)\b/.test(text)) {
    return { intent: "LOGIN_STUDENT", raw };
  }
  if (/\b(admin login|login as admin|sign in as admin)\b/.test(text)) {
    return { intent: "LOGIN_ADMIN", raw };
  }
  if (/\b(log out|sign out|logout)\b/.test(text)) return { intent: "LOGOUT", raw };
  if (/\b(dashboard|go home)\b/.test(text)) return { intent: "GO_DASHBOARD", raw };
  if (/\b(my results|show results|previous exams|how did i do|how have i done|my past attempts)\b/.test(text)) {
    return { intent: "MY_RESULTS", raw };
  }
  if (/\b(voice (learning|control|guide)|help)\b/.test(text) && !/\bexam\b/.test(text)) {
    return { intent: "VOICE_GUIDE", raw };
  }
  if (/\b(available exams|show (me )?exams|take an exam|what exams can i take|what tests are available|i want to see my exams)\b/.test(text)) {
    return { intent: "LIST_EXAMS", raw };
  }
  if (
    /\b(resume (my )?(exam|session)|continue (my )?(exam|test)|pick up where i left off|carry on with my exam|continue where i stopped)\b/.test(text) ||
    /\b(?:i(?:'d| would) like to|i want to|can i|could i|let me)\s+(?:continue|carry on|pick up)\b/.test(text)
  ) {
    return { intent: "RESUME_EXAM", raw };
  }
  if (/\b(?:open|start|begin|take|do)\s+(?:the )?first exam\b/.test(text)) {
    return { intent: "START_EXAM_INDEX", index: 0, raw };
  }
  const ordinal = text.match(/\b(?:open|start|begin|take|do|i(?:'d| would) like to take|i want to take|can i take)\s+(?:the\s+)?(first|second|third|\d+)(?:st|nd|rd|th)?\s+exam(?:ination)?\b/);
  if (ordinal) {
    const n = parseNumber(ordinal[1]);
    return { intent: "START_EXAM_INDEX", index: n ? n - 1 : 0, raw };
  }
  const startNamed = text.match(
    /\b(?:(?:start|begin|take|do)\s+(?:(?:the|my)\s+)?|(?:i(?:'d| would) like to|i want to|can i|could i|let me|i am ready to|i'm ready to)\s+(?:take|start|begin|do)\s+(?:(?:the|my)\s+)?)(?!the\b|my\b)(.+?)\s+(?:exam(?:ination)?|test|paper)\b/
  );
  if (startNamed) return { intent: "START_EXAM_NAMED", title: startNamed[1], raw };
  if (
    /\b(?:start|begin|take|do)\s+(?:(?:the|my)\s+)?(?:exam(?:ination)?|test|paper)\b/.test(text) ||
    /\b(?:i(?:'d| would) like to|i want to|can i|could i|let me|i am ready to|i'm ready to)\s+(?:take|start|begin|do)\s+(?:(?:the|my)\s+)?(?:exam(?:ination)?|test|paper)\b/.test(text)
  ) {
    return { intent: "START_EXAM", raw };
  }
  if (/\bread my (result|score)|tell me my (result|score)|what was my (result|score)\b/.test(text)) {
    return { intent: "READ_RESULT", raw };
  }
  if (/\benable voice|start listening|voice on\b/.test(text)) return { intent: "ENABLE_VOICE", raw };
  if (/\bdisable voice|stop listening|voice off\b/.test(text)) return { intent: "DISABLE_VOICE", raw };
  return { intent: "UNKNOWN", raw };
}

export function matchExamByTitle(exams, title) {
  const normalize = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const needle = normalize(title);
  if (!needle) return undefined;

  const list = exams || [];
  const exact = list.filter((exam) => normalize(exam.title) === needle);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;

  const titleMatches = list.filter((exam) => normalize(exam.title).includes(needle));
  if (titleMatches.length === 1) return titleMatches[0];
  if (titleMatches.length > 1) return undefined;

  const subjectMatches = list.filter((exam) => normalize(exam.subject) === needle);
  return subjectMatches.length === 1 ? subjectMatches[0] : undefined;
}
