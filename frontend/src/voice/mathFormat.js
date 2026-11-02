/**
 * Converts mathematical and LaTeX strings into readable Unicode math expressions.
 * e.g. "x^2 + 5x - 6 = 0" -> "x² + 5x − 6 = 0"
 * e.g. "x \\times x + 2" -> "x × x + 2"
 * e.g. "\\sqrt{144}" -> "√144"
 */

const SUPERSCRIPTS = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  "n": "ⁿ",
  "x": "ˣ",
};

export function formatMathDisplay(text) {
  if (text == null) return "";
  let s = String(text).trim();
  if (!s) return "";

  // Replace escaped LaTeX commands
  s = s.replace(/\\times/g, "×");
  s = s.replace(/\\cdot/g, "·");
  s = s.replace(/\\div/g, "÷");
  s = s.replace(/\\pm/g, "±");
  s = s.replace(/\\mp/g, "∓");
  s = s.replace(/\\neq/g, "≠");
  s = s.replace(/\\leq/g, "≤");
  s = s.replace(/\\geq/g, "≥");
  s = s.replace(/\\approx/g, "≈");
  s = s.replace(/\\infty/g, "∞");

  // Square roots: \sqrt{144} -> √144 or \sqrt 144 -> √144
  s = s.replace(/\\sqrt\{([^}]+)\}/g, "√$1");
  s = s.replace(/\\sqrt\s+(\d+|[a-zA-Z])/g, "√$1");
  s = s.replace(/\\sqrt/g, "√");

  // Fractions: \frac{a}{b} -> (a / b)
  s = s.replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, "($1 / $2)");

  // Superscripts / powers: x^2 -> x², x^3 -> x³
  s = s.replace(/\^([0-9\+\-\(\)nx]+)/g, (_, exp) => {
    return exp
      .split("")
      .map((c) => SUPERSCRIPTS[c] || `^${c}`)
      .join("");
  });
  s = s.replace(/\^\{([^}]+)\}/g, (_, exp) => {
    return exp
      .split("")
      .map((c) => SUPERSCRIPTS[c] || `^${c}`)
      .join("");
  });

  // Minus sign formatting: space - space -> space − space
  s = s.replace(/(\s)-(\s)/g, "$1−$2");

  // Remove any remaining stray backslashes
  s = s.replace(/\\([a-zA-Z]+)/g, "$1");

  return s;
}
