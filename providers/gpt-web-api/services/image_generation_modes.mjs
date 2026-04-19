const THINKING_PATTERNS = [
  /\bthink(?:ing)?\b/i,
  /\breason(?:ing)?\b/i,
  /\bthink longer\b/i,
  /\bmore thoughtful\b/i,
];

const NON_MODE_PATTERNS = [
  /add files/i,
  /send prompt/i,
  /start dictation/i,
  /edit image/i,
  /download/i,
  /open image/i,
  /new chat/i,
  /search chats/i,
];

export function normalizeControlText(control = {}) {
  return [control.text, control.ariaLabel, control.title, control.testid]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function pickThinkingControlCandidate(controls = []) {
  return controls.find((control) => {
    if (control.disabled) return false;
    const text = normalizeControlText(control);
    if (!text) return false;
    if (NON_MODE_PATTERNS.some((pattern) => pattern.test(text))) return false;
    return THINKING_PATTERNS.some((pattern) => pattern.test(text));
  }) || null;
}
