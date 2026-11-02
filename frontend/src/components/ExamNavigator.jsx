import React from "react";

export default function ExamNavigator({
  numbers,
  current,
  unanswered,
  marked,
  onJump,
  disabled,
}) {
  const unansweredSet = new Set(unanswered || []);
  const markedSet = new Set(marked || []);
  const total = numbers.length || 1;
  const answered = numbers.filter((n) => !unansweredSet.has(n)).length;
  const pct = Math.round((answered / total) * 100);

  return (
    <section className="card" aria-label="Question navigator">
      <h3>Question navigator</h3>
      <p className="muted">Current question {current}. Completion {pct}%.</p>
      <div className="nav-grid" role="list">
        {numbers.map((n) => {
          const classes = [
            "nav-btn",
            n === current ? "current" : "",
            !unansweredSet.has(n) ? "answered" : "",
          ].join(" ");
          return (
            <button
              key={n}
              type="button"
              className={classes}
              disabled={disabled}
              aria-current={n === current ? "true" : undefined}
              aria-label={`Question ${n}${unansweredSet.has(n) ? ", unanswered" : ", answered"}${markedSet.has(n) ? ", marked" : ""}`}
              onClick={() => onJump(n)}
            >
              {n}
            </button>
          );
        })}
      </div>
      <div className="legend" style={{ marginTop: 12 }}>
        <span>Current: filled purple</span>
        <span>Answered: green border</span>
        <span>Unanswered: {unanswered?.length ? unanswered.join(", ") : "none"}</span>
      </div>
    </section>
  );
}
