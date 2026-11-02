import React from "react";

const LABELS = {
  idle: "Idle",
  listening: "Listening",
  processing: "Processing",
  speaking: "Speaking",
  permission: "Microphone permission required",
  unavailable: "Microphone unavailable",
  error: "Error",
};

export default function VoicePanel({
  status,
  enabled,
  transcript,
  interim,
  response,
  error,
  onToggle,
  available,
}) {
  return (
    <section className="voice-panel" aria-label="Hands-Free Voice Control">
      <div className={`mic-orb ${status}`} aria-hidden="true">
        {status === "listening" ? "●" : "🎤"}
      </div>
      <div>
        <p className="pill" style={{ margin: "0 0 6px" }}>Hands-Free Voice Control</p>
        <strong aria-live="polite">{LABELS[status] || status}</strong>
        <p className="muted" aria-live="polite">
          Heard: {interim || transcript || "Waiting for speech"}
        </p>
        <p aria-live="assertive">{response || error || "System ready."}</p>
      </div>
      <div>
        <button className="btn ghost" type="button" onClick={onToggle} disabled={!available && !enabled}>
          {enabled ? "Disable voice" : "Enable voice"}
        </button>
      </div>
    </section>
  );
}
