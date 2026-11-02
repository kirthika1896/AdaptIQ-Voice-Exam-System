import assert from "node:assert/strict";
import test from "node:test";
import { matchExamByTitle, parseAppIntent } from "./appIntent.js";

test("recognizes login, navigation, and natural named exam intents", () => {
  assert.equal(parseAppIntent("student login").intent, "LOGIN_STUDENT");
  assert.equal(parseAppIntent("admin login").intent, "LOGIN_ADMIN");
  assert.equal(parseAppIntent("start my mathematics examination").intent, "START_EXAM_NAMED");
  assert.equal(parseAppIntent("start my mathematics examination").title, "mathematics");
  const namedRequest = parseAppIntent("I would like to take the mathematics test");
  assert.equal(namedRequest.intent, "START_EXAM_NAMED");
  assert.equal(namedRequest.title, "mathematics");
  assert.equal(
    parseAppIntent("Could I continue where I left off?").intent,
    "RESUME_EXAM"
  );
  assert.equal(
    parseAppIntent("What exams can I take?").intent,
    "LIST_EXAMS"
  );
  assert.equal(parseAppIntent("Start the exam").intent, "START_EXAM");
  assert.equal(parseAppIntent("Begin the examination").intent, "START_EXAM");
  assert.equal(parseAppIntent("begin the second exam").index, 1);
  assert.equal(parseAppIntent("take an exam").intent, "LIST_EXAMS");
});

test("matches spoken exam names against backend exam records", () => {
  const exams = [
    { id: "math", title: "Applied Mathematics", subject: "Mathematics" },
    { id: "science", title: "Science Basics", subject: "Science" },
  ];
  assert.equal(matchExamByTitle(exams, "mathematics")?.id, "math");
  assert.equal(matchExamByTitle(exams, "Applied Mathematics")?.id, "math");
  assert.equal(
    matchExamByTitle(
      [
        ...exams,
        { id: "math-advanced", title: "Advanced Mathematics", subject: "Mathematics" },
      ],
      "mathematics"
    ),
    undefined
  );
  assert.equal(
    matchExamByTitle(exams, "science"),
    exams[1]
  );
});