let currentUtterance = null;
let speakingActive = false;
const listeners = new Set();

function notify(speaking) {
  speakingActive = speaking;
  for (const fn of listeners) {
    try {
      fn(speaking);
    } catch {
      /* ignore subscriber error */
    }
  }
}

export function subscribeSpeech(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isSpeaking() {
  return speakingActive || Boolean(window.speechSynthesis?.speaking);
}

function pickVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  return (
    voices.find((v) => v.lang?.toLowerCase() === "en-in") ||
    voices.find((v) => v.lang?.toLowerCase().startsWith("en-in")) ||
    voices.find((v) => v.lang?.toLowerCase().startsWith("en")) ||
    null
  );
}

export function cancelSpeech() {
  if (typeof window !== "undefined" && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  currentUtterance = null;
  if (speakingActive) {
    notify(false);
  }
}

export function speak(text, { interrupt = true, onStart, onEnd } = {}) {
  const value = String(text || "").trim();
  if (!value || typeof window === "undefined" || !window.speechSynthesis) {
    onEnd?.();
    return Promise.resolve();
  }

  if (interrupt) {
    cancelSpeech();
  }

  return new Promise((resolve) => {
    const utter = new SpeechSynthesisUtterance(value);
    utter.rate = 0.95;
    utter.pitch = 1;
    utter.lang = "en-IN";
    const voice = pickVoice();
    if (voice) utter.voice = voice;
    currentUtterance = utter;

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (currentUtterance === utter) currentUtterance = null;
      notify(false);
      onEnd?.();
      resolve();
    };

    utter.onstart = () => {
      notify(true);
      onStart?.();
    };

    utter.onend = finish;
    utter.onerror = finish;

    // Safety timeout in case browser speech synthesis hangs
    const wordCount = value.split(/\s+/).length;
    const estDurationMs = Math.max(3000, wordCount * 600);
    setTimeout(() => {
      if (!finished && currentUtterance === utter && !window.speechSynthesis?.speaking) {
        finish();
      }
    }, estDurationMs + 2000);

    try {
      notify(true);
      window.speechSynthesis.speak(utter);
    } catch {
      finish();
    }
  });
}

if (typeof window !== "undefined" && window.speechSynthesis) {
  window.speechSynthesis.addEventListener?.("voiceschanged", () => pickVoice());
}
