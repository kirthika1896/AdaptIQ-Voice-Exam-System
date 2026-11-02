import { useCallback, useEffect, useRef, useState } from "react";
import { cancelSpeech, speak } from "../voice/speech";

function getCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function useVoice({ onFinalTranscript, enabledDefault = false } = {}) {
  const [enabled, setEnabled] = useState(enabledDefault);
  const [status, setStatus] = useState("idle");
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState("");
  const recRef = useRef(null);
  const enabledRef = useRef(enabledDefault);
  const speakingRef = useRef(false);
  const onFinalRef = useRef(onFinalTranscript);

  useEffect(() => {
    onFinalRef.current = onFinalTranscript;
  }, [onFinalTranscript]);

  const stopRec = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    try {
      rec.onend = null;
      rec.stop();
    } catch {
      /* ignore */
    }
    recRef.current = null;
  }, []);

  const startRec = useCallback(() => {
    const Ctor = getCtor();
    if (!Ctor) {
      setStatus("unavailable");
      setError("Speech recognition is not available. Use Chrome or Edge.");
      return;
    }
    stopRec();
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-IN";
    rec.onstart = () => {
      setStatus("listening");
      setError("");
    };
    rec.onresult = (event) => {
      let finalText = "";
      let live = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const piece = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += piece;
        else live += piece;
      }
      if (live) setInterim(live);
      if (finalText && !speakingRef.current) {
        const cleaned = finalText.trim();
        setTranscript(cleaned);
        setInterim("");
        setStatus("processing");
        onFinalRef.current?.(cleaned);
      }
    };
    rec.onerror = (event) => {
      const code = event.error || "error";
      if (code === "not-allowed") {
        setStatus("permission");
        setError("Microphone permission is required for voice control.");
        enabledRef.current = false;
        setEnabled(false);
        return;
      }
      if (code === "no-speech") return;
      setStatus("error");
      setError(`Voice error: ${code}`);
    };
    rec.onend = () => {
      recRef.current = null;
      if (enabledRef.current && !speakingRef.current) {
        setTimeout(() => {
          if (enabledRef.current) startRec();
        }, 250);
      } else if (!enabledRef.current) {
        setStatus("idle");
      }
    };
    recRef.current = rec;
    try {
      rec.start();
    } catch (err) {
      setError(String(err.message || err));
      setStatus("error");
    }
  }, [stopRec]);

  const enable = useCallback(async () => {
    enabledRef.current = true;
    setEnabled(true);
    if (!navigator.mediaDevices?.getUserMedia) {
      startRec();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      startRec();
    } catch {
      setStatus("permission");
      setError("Microphone permission is required for voice control.");
      enabledRef.current = false;
      setEnabled(false);
    }
  }, [startRec]);

  const disable = useCallback(() => {
    enabledRef.current = false;
    setEnabled(false);
    stopRec();
    setStatus("idle");
  }, [stopRec]);

  const speakResponse = useCallback(
    async (text) => {
      if (!text) return;
      speakingRef.current = true;
      setStatus("speaking");
      stopRec();
      await speak(text);
      speakingRef.current = false;
      if (enabledRef.current) startRec();
      else setStatus("idle");
    },
    [startRec, stopRec]
  );

  useEffect(() => () => {
    enabledRef.current = false;
    stopRec();
    cancelSpeech();
  }, [stopRec]);

  return {
    enabled,
    status,
    transcript,
    interim,
    error,
    available: Boolean(getCtor()),
    enable,
    disable,
    speakResponse,
    setStatus,
  };
}
