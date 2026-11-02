import React, { useEffect } from "react";
import AppShell from "../components/AppShell";
import { speak } from "../voice/speech";

const EXAMPLES = [
  "I'd like to take the mathematics test.",
  "I'm ready for another question.",
  "Could we go back to the question before this one?",
  "I didn't catch what you said. Could you repeat it?",
  "I think the answer is option C.",
  "Can you remind me what I answered?",
  "How much time do I have left?",
  "I'd like to look over my answers.",
  "I'm finished and ready to hand in my exam.",
  "Not yet, I'd like to keep going.",
];

export default function VoiceGuidePage() {
  useEffect(() => {
    speak("You can speak naturally. Tell me what you would like to do or answer, and I'll do my best to understand.");
  }, []);

  return (
    <AppShell>
      <h1>Voice learning</h1>
      <p className="muted">You don't need to memorize special phrases. These are examples of ways you could speak naturally.</p>
      <section className="card">
        <ul>
          {EXAMPLES.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
    </AppShell>
  );
}
