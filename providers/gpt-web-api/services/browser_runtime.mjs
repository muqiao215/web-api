import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { pickThinkingControlCandidate } from "./image_generation_modes.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute SHA-256 hex digest of a Buffer.
 * Uses Node.js built-in crypto — no external dependencies.
 */
function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Read image dimensions from a file on disk.
 * PNG: reads first 24 bytes to extract width/height from IHDR chunk (no external deps).
 * JPEG: reads first bytes to find SOF0/SOF2 frame marker.
 * Returns {width, height} or null if dimensions cannot be determined.
 */
async function readImageDimensions(filepath) {
  const header = await fs.readFile(filepath, { length: 24 });
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) {
    // PNG: width at bytes 16-19, height at bytes 20-23 (big-endian 32-bit)
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    return { width, height };
  }
  // JPEG: SOF0 (0xFF 0xC0) or SOF2 (0xFF 0xC2) — read more bytes to find it
  if (header[0] === 0xff && header[1] === 0xd8) {
    const full = await fs.readFile(filepath);
    for (let i = 2; i < full.length - 1; i++) {
      if (full[i] === 0xff && (full[i + 1] === 0xc0 || full[i + 1] === 0xc2)) {
        const height = full.readUInt16BE(i + 5);
        const width = full.readUInt16BE(i + 7);
        return { width, height };
      }
    }
  }
  return null;
}

async function waitFor(page, expression, timeoutMs = 10000, intervalMs = 500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await page.evaluate(expression);
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

function isImageFile(file) {
  return /^image\//i.test(file.mime_type || "") || /\.(png|jpe?g|webp|gif)$/i.test(file.filename || file.path || "");
}

function normalizeComposerText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function classifyImageComposerFailure({
  reason = "",
  editorText = "",
  prompt = "",
  hadPreflightStale = false,
  attemptedKeyboardFallback = false,
} = {}) {
  const normalizedPrompt = normalizeComposerText(prompt);
  const normalizedEditorText = normalizeComposerText(editorText);
  const appendedPrompt =
    normalizedPrompt &&
    normalizedEditorText.includes(normalizedPrompt) &&
    normalizedEditorText !== normalizedPrompt;
  const oversizedEditorText =
    normalizedPrompt &&
    normalizedEditorText.length > Math.max(normalizedPrompt.length + 32, normalizedPrompt.length * 2);
  const recoverable =
    reason === "send button still disabled" &&
    (hadPreflightStale || appendedPrompt || oversizedEditorText);

  if (recoverable) {
    return {
      recoverable: true,
      code: "browser_image_composer_stale",
      message: "Image composer stale-state: send button still disabled after fill",
    };
  }

  if (reason === "send button still disabled" && attemptedKeyboardFallback) {
    return {
      recoverable: false,
      code: "browser_image_composer_inert",
      message: "Image composer inert after synthetic input: send button still disabled",
    };
  }

  return {
    recoverable: false,
    code: "",
    message: reason || "Failed to submit image prompt",
  };
}

function shouldCleanupImageComposerError(error) {
  const message = String(error?.message || error || "");
  return /send button still disabled|Image composer stale-state|Image composer inert|Timed out waiting for image result/i.test(message);
}

async function readImageComposerState(page) {
  return page.evaluate(`(() => { /* image-composer-read */
    const editor = document.querySelector('div[contenteditable="true"][role="textbox"]');
    const send = document.querySelector('button[data-testid="send-button"]');
    if (!editor) return { ok: false, reason: 'editor not found', editorText: '', sendDisabled: true };
    if (!send) return { ok: false, reason: 'send button not found', editorText: editor.innerText || '', sendDisabled: true };
    return {
      ok: true,
      editorText: editor.innerText || '',
      sendDisabled: !!send.disabled || send.getAttribute('aria-disabled') === 'true',
    };
  })()`);
}

async function focusImageComposer(page) {
  const focusResult = await page.evaluate(`(() => { /* image-composer-focus */
    const editor = document.querySelector('div[contenteditable="true"][role="textbox"]');
    if (!editor) return { ok: false, reason: 'editor not found' };
    editor.focus();
    return { ok: true };
  })()`);

  if (!focusResult?.ok) {
    throw new Error(focusResult?.reason || "Failed to focus image editor");
  }
}

async function clearImageComposer(page) {
  const result = await page.evaluate(`(() => { /* image-composer-clear */
    const editor = document.querySelector('div[contenteditable="true"][role="textbox"]');
    const send = document.querySelector('button[data-testid="send-button"]');
    if (!editor) return { ok: false, reason: 'editor not found', editorText: '', sendDisabled: true };
    editor.focus();
    editor.innerHTML = '';
    editor.textContent = '';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      ok: true,
      editorText: editor.innerText || '',
      sendDisabled: !!send?.disabled || send?.getAttribute('aria-disabled') === 'true',
    };
  })()`);

  if (!result?.ok) {
    throw new Error(result?.reason || "Failed to clear image composer");
  }
  return result;
}

async function cleanupImageComposer(page) {
  try {
    return await clearImageComposer(page);
  } catch {
    return null;
  }
}

async function preflightImageComposer(page) {
  let state = await readImageComposerState(page);
  if (!state?.ok) {
    throw new Error(state?.reason || "Failed to inspect image composer");
  }

  let clearedStaleComposer = false;
  if (normalizeComposerText(state.editorText)) {
    await clearImageComposer(page);
    clearedStaleComposer = true;
    state = await readImageComposerState(page);
    if (!state?.ok) {
      throw new Error(state?.reason || "Failed to inspect image composer after cleanup");
    }
  }

  await focusImageComposer(page);
  return {
    clearedStaleComposer,
    state,
  };
}

async function wakeImageComposerAfterInsert(page, prompt) {
  const result = await page.evaluate(`(() => { /* image-composer-wake */
    const editor = document.querySelector('div[contenteditable="true"][role="textbox"]');
    const send = document.querySelector('button[data-testid="send-button"]');
    if (!editor) return { ok: false, reason: 'editor not found', editorText: '', sendDisabled: true };
    if (!send) return { ok: false, reason: 'send button not found', editorText: editor.innerText || '', sendDisabled: true };

    const text = editor.innerText || editor.textContent || '';
    editor.focus();

    const selection = window.getSelection?.();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    const dispatch = (event) => {
      try {
        editor.dispatchEvent(event);
      } catch {}
    };

    dispatch(new Event('beforeinput', { bubbles: true, cancelable: true }));
    if (typeof InputEvent === 'function') {
      dispatch(new InputEvent('input', {
        bubbles: true,
        data: ${JSON.stringify(prompt)},
        inputType: 'insertText',
      }));
    } else {
      dispatch(new Event('input', { bubbles: true }));
    }
    dispatch(new Event('change', { bubbles: true }));
    dispatch(new KeyboardEvent('keydown', { bubbles: true, key: ' ', code: 'Space' }));
    dispatch(new KeyboardEvent('keyup', { bubbles: true, key: ' ', code: 'Space' }));

    return {
      ok: true,
      editorText: text,
      sendDisabled: !!send.disabled || send.getAttribute('aria-disabled') === 'true',
    };
  })()`);

  if (!result?.ok) {
    throw new Error(result?.reason || "Failed to wake image composer");
  }
  return result;
}

async function typeIntoImageComposerViaKeyboard(page, prompt, settleDelayMs) {
  await clearImageComposer(page);
  await focusImageComposer(page);
  await page.typeText(prompt);
  if (settleDelayMs > 0) {
    await sleep(settleDelayMs);
  }
  const state = await readImageComposerState(page);
  if (!state?.ok) {
    throw new Error(state?.reason || "Failed to inspect image composer after keyboard input");
  }
  return state;
}

async function fillImageComposer(page, prompt, settleDelayMs) {
  await page.insertText(prompt);
  if (settleDelayMs > 0) {
    await sleep(settleDelayMs);
  }

  let state = await readImageComposerState(page);
  if (!state?.ok) {
    throw new Error(state?.reason || "Failed to inspect image composer after fill");
  }

  let attemptedKeyboardFallback = false;

  if (state.sendDisabled && normalizeComposerText(state.editorText) === normalizeComposerText(prompt)) {
    await wakeImageComposerAfterInsert(page, prompt);
    if (settleDelayMs > 0) {
      await sleep(settleDelayMs);
    }
    state = await readImageComposerState(page);
    if (!state?.ok) {
      throw new Error(state?.reason || "Failed to inspect image composer after wake");
    }
  }

  if (state.sendDisabled && normalizeComposerText(state.editorText) === normalizeComposerText(prompt)) {
    attemptedKeyboardFallback = true;
    state = await typeIntoImageComposerViaKeyboard(page, prompt, settleDelayMs);
    if (state.sendDisabled && normalizeComposerText(state.editorText) === normalizeComposerText(prompt)) {
      throw new Error("Image composer inert after synthetic input: send button still disabled");
    }
  }

  return {
    state,
    attemptedKeyboardFallback,
  };
}

async function submitImagePrompt(page, prompt, { settleDelayMs = 800, maxComposerRetries = 1 } = {}) {
  let attempts = 0;
  let retries = 0;

  while (true) {
    attempts += 1;
    const preflight = await preflightImageComposer(page);

    const fill = await fillImageComposer(page, prompt, settleDelayMs);

    const result = await page.evaluate(`(() => { /* image-composer-submit */
      const send = document.querySelector('button[data-testid="send-button"]');
      const editor = document.querySelector('div[contenteditable="true"][role="textbox"]');
      if (!send) return { ok: false, reason: 'send button not found', editorText: editor?.innerText || '' };
      if (send.disabled || send.getAttribute('aria-disabled') === 'true') {
        return {
          ok: false,
          reason: 'send button still disabled',
          editorText: editor?.innerText || '',
        };
      }
      send.click();
      return { ok: true, editorText: editor?.innerText || '' };
    })()`);

    if (result?.ok) {
      return {
        attempts,
        retriedComposerStale: retries > 0,
        clearedStaleComposer: preflight.clearedStaleComposer,
      };
    }

    const failure = classifyImageComposerFailure({
      reason: result?.reason,
      editorText: result?.editorText,
      prompt,
      hadPreflightStale: preflight.clearedStaleComposer,
      attemptedKeyboardFallback: fill.attemptedKeyboardFallback,
    });

    await cleanupImageComposer(page);

    if (failure.recoverable && retries < maxComposerRetries) {
      retries += 1;
      continue;
    }

    throw new Error(failure.message);
  }
}

function keyDescriptorForChar(char) {
  if (char === " ") return { key: " ", code: "Space", keyCode: 32 };
  if (char === "\n") return { key: "Enter", code: "Enter", keyCode: 13 };
  if (/^[a-z]$/.test(char)) {
    return { key: char, code: `Key${char.toUpperCase()}`, keyCode: char.toUpperCase().charCodeAt(0) };
  }
  if (/^[A-Z]$/.test(char)) {
    return { key: char, code: `Key${char}`, keyCode: char.charCodeAt(0), modifiers: 8 };
  }
  if (/^[0-9]$/.test(char)) {
    return { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0) };
  }
  return { key: char, code: "", keyCode: char.charCodeAt(0) };
}

function detectLoginFromPages(pages) {
  const pageSummaries = pages
    .filter((page) => page.type === "page")
    .map((page) => ({
      url: page.url || "",
      title: page.title || "",
    }));
  const signInPage = pageSummaries.find((page) => {
    const text = `${page.url} ${page.title}`;
    const decodedUrl = decodeURIComponent(page.url);
    return (
      /chatgpt\.com\/auth|chatgpt\.com\/login|chatgpt\.com\/signin|chatgpt\.com\/signup/i.test(text) ||
      (/accounts\.google\.com/i.test(page.url) && /chatgpt\.com/i.test(decodedUrl))
    );
  });
  if (signInPage) return false;
  const chatgptPage = pageSummaries.find((page) =>
    /^https:\/\/chatgpt\.com\//.test(page.url) && !/login|sign in|sign up/i.test(page.title)
  );
  if (chatgptPage) return true;
  return null;
}

class CdpPage {
  constructor(target) {
    this.target = target;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.target.webSocketDebuggerUrl);
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data.toString());
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
    };
    this.ws.onerror = (event) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`CDP websocket error: ${event.message || "unknown"}`));
      }
      this.pending.clear();
    };
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("DOM.enable");
  }

  close() {
    if (this.ws) this.ws.close();
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
    });
  }

  async evaluate(expression, { awaitPromise = false, returnByValue = true } = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return result.result?.value;
  }

  async navigate(url) {
    await this.send("Page.navigate", { url });
  }

  async insertText(text) {
    await this.send("Input.insertText", { text });
  }

  async typeText(text) {
    for (const char of String(text || "")) {
      const key = keyDescriptorForChar(char);
      await this.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: key.key,
        code: key.code,
        windowsVirtualKeyCode: key.keyCode,
        nativeVirtualKeyCode: key.keyCode,
        ...(key.modifiers ? { modifiers: key.modifiers } : {}),
      });
      await this.send("Input.dispatchKeyEvent", {
        type: "char",
        text: char,
        unmodifiedText: char,
        ...(key.modifiers ? { modifiers: key.modifiers } : {}),
      });
      await this.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: key.key,
        code: key.code,
        windowsVirtualKeyCode: key.keyCode,
        nativeVirtualKeyCode: key.keyCode,
        ...(key.modifiers ? { modifiers: key.modifiers } : {}),
      });
    }
  }

  async setFileInputFiles(selector, files) {
    const doc = await this.send("DOM.getDocument", { depth: -1, pierce: true });
    const node = await this.send("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector,
    });
    if (!node.nodeId) {
      throw new Error(`file input not found: ${selector}`);
    }
    await this.send("DOM.setFileInputFiles", {
      nodeId: node.nodeId,
      files,
    });
  }
}

export function createBrowserRuntime({
  cdpHttp,
  chatPageUrl,
  imagePageUrl,
  outputDir,
  cdpHttpTimeoutMs = 15000,
  getQueueStats = () => ({ pending: null, running: null, total: null }),
  getSessionLockCount = () => null,
}) {
  async function fetchJson(url, init = {}) {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(cdpHttpTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return response.json();
  }

  async function openNewPage(url) {
    const response = await fetch(`${cdpHttp}/json/new?${encodeURIComponent(url)}`, {
      method: "PUT",
      signal: AbortSignal.timeout(cdpHttpTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Failed to open CDP page: HTTP ${response.status}`);
    }
    return response.json();
  }

  async function closePage(targetId) {
    const response = await fetch(`${cdpHttp}/json/close/${targetId}`, {
      signal: AbortSignal.timeout(cdpHttpTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Failed to close CDP page ${targetId}: HTTP ${response.status}`);
    }
  }

  async function openChatPage(url = chatPageUrl) {
    return openNewPage(url);
  }

  async function pickImagePage() {
    const pages = await fetchJson(`${cdpHttp}/json/list`);
    const existing = pages.find(
      (page) =>
        page.type === "page" &&
        typeof page.url === "string" &&
        (page.url.startsWith("https://chatgpt.com/images") ||
          page.title === "ChatGPT Images | AI Image Generator")
    );
    if (existing) return existing;

    const healthyChatPage = pages.find(
      (page) =>
        page.type === "page" &&
        typeof page.url === "string" &&
        (page.url === "https://chatgpt.com/" || page.url.startsWith("https://chatgpt.com/c/")) &&
        typeof page.title === "string" &&
        page.title.length > 0
    );
    return healthyChatPage || openNewPage("https://chatgpt.com/");
  }

  async function withImagePage(fn) {
    const pageInfo = await pickImagePage();
    const page = new CdpPage(pageInfo);
    await page.connect();
    try {
      return await fn(page);
    } finally {
      page.close();
    }
  }

  async function withChatPage(fn, url = chatPageUrl) {
    const pageInfo = await openChatPage(url);
    const page = new CdpPage(pageInfo);
    await page.connect();
    try {
      return await fn(page);
    } finally {
      page.close();
      try {
        await closePage(pageInfo.id);
      } catch {}
    }
  }

  async function ensureChatPage(page) {
    const state = await page.evaluate(`(() => ({
      title: document.title,
      url: location.href,
      bodyText: document.body?.innerText || '',
      loggedIn: !/log in|sign up|continue with google|continue with apple/i.test(document.body?.innerText || ''),
    }))()`);

    if (!state.loggedIn) {
      throw new Error("ChatGPT web is not logged in on the current browser profile");
    }

    if (!state.url.startsWith(chatPageUrl) || state.url.startsWith(imagePageUrl)) {
      await page.navigate(chatPageUrl);
      await sleep(2500);
    }

    const ready = await waitFor(
      page,
      `(() => {
        const editor = document.querySelector('div[contenteditable="true"][role="textbox"]');
        const send = document.querySelector('button[data-testid="send-button"], button[aria-label="Start Voice"]');
        return !!editor && !!send;
      })()`,
      15000
    );
    if (!ready) {
      throw new Error("ChatGPT chat page did not become ready");
    }
  }

  async function ensureImagePage(page) {
    const state = await page.evaluate(`(() => ({
      title: document.title,
      url: location.href,
      bodyText: document.body?.innerText || '',
      loggedIn: !/log in|sign up|continue with google|continue with apple/i.test(document.body?.innerText || ''),
      hasPromptBox: !!document.querySelector('textarea'),
    }))()`);

    if (!state.loggedIn) {
      throw new Error("ChatGPT web is not logged in on the current browser profile");
    }

    const failedStandaloneImagePage =
      state.url.startsWith("https://chatgpt.com/images/") &&
      /content failed to load|try again/i.test(state.bodyText || "");

    if (failedStandaloneImagePage) {
      await page.navigate("https://chatgpt.com/");
      await sleep(2500);
    }

    if (!state.url.startsWith("https://chatgpt.com/images/") || failedStandaloneImagePage) {
      await page.navigate(imagePageUrl);
      await sleep(2500);
    }

    const ready = await waitFor(
      page,
      `(() => {
        const editor = document.querySelector('div[contenteditable="true"][role="textbox"]');
        const send = document.querySelector('button[data-testid="send-button"]');
        return !!editor && !!send;
      })()`,
      15000
    );
    if (!ready) {
      throw new Error("ChatGPT Images page did not become ready");
    }
  }

  async function submitPrompt(page, prompt) {
    const focusResult = await page.evaluate(`(() => {
      const editor = document.querySelector('div[contenteditable="true"][role="textbox"]');
      if (!editor) return { ok: false, reason: 'editor not found' };
      editor.focus();
      return { ok: true };
    })()`);

    if (!focusResult?.ok) {
      throw new Error(focusResult?.reason || "Failed to focus editor");
    }

    await page.insertText(prompt);
    await sleep(800);

    const result = await page.evaluate(`(() => {
      const send = document.querySelector('button[data-testid="send-button"]');
      const editor = document.querySelector('div[contenteditable="true"][role="textbox"]');
      if (!send) return { ok: false, reason: 'send button not found' };
      if (send.disabled) {
        return {
          ok: false,
          reason: 'send button still disabled',
          editorText: editor?.innerText || '',
        };
      }
      send.click();
      return { ok: true, editorText: editor?.innerText || '' };
    })()`);

    if (!result?.ok) {
      throw new Error(result?.reason || "Failed to submit prompt");
    }
  }

  async function scanInteractiveControls(page) {
    return page.evaluate(`(() => Array.from(document.querySelectorAll('button,[role="button"],label,[aria-pressed],[aria-haspopup="menu"],[data-testid]'))
      .map((node, domIndex) => ({
        domIndex,
        tag: node.tagName,
        text: (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim(),
        ariaLabel: node.getAttribute('aria-label') || '',
        title: node.getAttribute('title') || '',
        testid: node.getAttribute('data-testid') || '',
        pressed: node.getAttribute('aria-pressed'),
        expanded: node.getAttribute('aria-expanded'),
        disabled: !!node.disabled || node.getAttribute('aria-disabled') === 'true',
      }))
      .filter((item) => item.text || item.ariaLabel || item.title || item.testid))()`);
  }

  async function enableThinkingMode(page) {
    const controls = await scanInteractiveControls(page);
    const candidate = pickThinkingControlCandidate(controls);
    if (!candidate) {
      return {
        attempted: false,
        enabled: false,
        reason: "thinking control not present on current ChatGPT Images page",
        scanned_controls: controls.length,
      };
    }

    const clickResult = await page.evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll('button,[role="button"],label,[aria-pressed],[aria-haspopup="menu"],[data-testid]'));
      const node = nodes[${Number(candidate.domIndex)}];
      if (!node) return { ok: false, reason: 'candidate node disappeared' };
      node.click();
      return {
        ok: true,
        text: (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim(),
        ariaLabel: node.getAttribute('aria-label') || '',
        pressed: node.getAttribute('aria-pressed'),
      };
    })()`);

    if (!clickResult?.ok) {
      return {
        attempted: true,
        enabled: false,
        reason: clickResult?.reason || "thinking control click failed",
        candidate,
      };
    }

    await sleep(700);
    const refreshed = await scanInteractiveControls(page);
    const updated = refreshed.find((control) => control.domIndex === candidate.domIndex) || candidate;
    return {
      attempted: true,
      enabled: updated.pressed !== "false",
      reason: updated.pressed === "false" ? "thinking control clicked but not reported active" : "thinking control clicked",
      candidate: {
        text: candidate.text,
        ariaLabel: candidate.ariaLabel,
        title: candidate.title,
        testid: candidate.testid,
      },
      pressed: updated.pressed,
    };
  }

  async function prepareImageThinkingMode() {
    return withImagePage(async (page) => {
      await ensureImagePage(page);
      return enableThinkingMode(page);
    });
  }

  async function snapshotGeneratedImageSources(page) {
    const sources = await page.evaluate(
      `(() => Array.from(document.querySelectorAll('img'))
        .map(img => ({
          alt: img.alt || '',
          src: img.currentSrc || img.src || '',
        }))
        .filter(img =>
          img.src &&
          !img.src.startsWith('data:') &&
          /Generated image:/i.test(img.alt)
        )
        .map(img => img.src))()`
    );
    return new Set(Array.isArray(sources) ? sources : []);
  }

  async function waitForImageResult(page, existingSources = new Set(), timeoutMs = 120000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const state = await page.evaluate(
        `(() => {
          const bodyText = document.body?.innerText || '';
          const turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"], [data-message-author-role]'))
            .map((node, index) => ({
              index,
              role: node.getAttribute('data-message-author-role') || '',
              text: (node.innerText || '').replace(/\\s+/g, ' ').trim(),
            }))
            .filter((item) => item.text)
            .slice(-8);
          const latestTurnText = turns.at(-1)?.text || '';
          const alerts = Array.from(document.querySelectorAll('[role="alert"], [aria-live="assertive"], [aria-live="polite"]'))
            .map(node => (node.innerText || '').replace(/\\s+/g, ' ').trim())
            .filter(Boolean)
            .slice(0, 20);
          const alertText = alerts.join(' \\n ');
          const image = Array.from(document.querySelectorAll('img'))
            .map(img => ({
              alt: img.alt || '',
              src: img.currentSrc || img.src || ''
            }))
            .filter(img =>
              img.src &&
              !img.src.startsWith('data:') &&
              /Generated image:/i.test(img.alt)
            )
            .at(-1);
          const rateLimitText = [alertText, latestTurnText].filter(Boolean).join(' \\n ');
          const rateLimit = /generating images too quickly|rate_limit_exceeded|wait for an hour|reached your image creation limit|image generation limit|image request limit|you('|’)ve hit the plus plan limit|try again after|limit resets in/i.test(rateLimitText);
          const hardFailure = /something went wrong|unable to generate/i.test(rateLimitText);
          return {
            url: location.href,
            title: document.title,
            bodyText: bodyText.slice(0, 8000),
            alerts,
            latestTurnText: latestTurnText.slice(0, 2000),
            image,
            rateLimit,
            hardFailure,
          };
        })()`
      );

      if (state?.rateLimit) {
        throw new Error(
          `Image generation rate limited: ${state.title || ""} ${[...(state.alerts || []), state.latestTurnText || ""].join(" ").slice(0, 700)}`.trim()
        );
      }
      if (state?.image?.src && !existingSources.has(state.image.src)) {
        return state;
      }
      if (state?.hardFailure) {
        throw new Error(`Image generation failed: ${[...(state.alerts || []), state.latestTurnText || ""].join(" ").slice(0, 700)}`);
      }
      await sleep(2000);
    }
    throw new Error(`Timed out waiting for image result after ${timeoutMs}ms`);
  }

  async function waitForChatResult(page, timeoutMs = 120000) {
    const startedAt = Date.now();
    let lastAssistantText = "";
    let stableSeenAt = 0;
    while (Date.now() - startedAt < timeoutMs) {
      const state = await page.evaluate(
        `(() => {
          const bodyText = document.body?.innerText || '';
          const messages = Array.from(document.querySelectorAll('[data-message-author-role]'))
            .map((node, index) => ({
              index,
              role: node.getAttribute('data-message-author-role'),
              text: node.innerText || ''
            }));
          const assistant = [...messages].reverse().find(msg => msg.role === 'assistant');
          return {
            url: location.href,
            bodyText: bodyText.slice(0, 8000),
            assistant,
          };
        })()`
      );

      const assistantText = state?.assistant?.text?.trim() || "";
      if (assistantText && assistantText === lastAssistantText && Date.now() - stableSeenAt >= 2500) {
        return state;
      }
      if (assistantText !== lastAssistantText) {
        lastAssistantText = assistantText;
        stableSeenAt = Date.now();
      }
      if (/something went wrong|unable to generate|try again/i.test(state?.bodyText || "")) {
        throw new Error(`Chat completion failed: ${state.bodyText.slice(0, 500)}`);
      }
      await sleep(1000);
    }
    throw new Error(`Timed out waiting for chat result after ${timeoutMs}ms`);
  }

  async function streamChatResult(page, onDelta, timeoutMs = 120000) {
    const startedAt = Date.now();
    let lastAssistantText = "";
    let emittedText = "";
    let stableSeenAt = 0;

    while (Date.now() - startedAt < timeoutMs) {
      const state = await page.evaluate(
        `(() => {
          const bodyText = document.body?.innerText || '';
          const messages = Array.from(document.querySelectorAll('[data-message-author-role]'))
            .map((node, index) => ({
              index,
              role: node.getAttribute('data-message-author-role'),
              text: node.innerText || ''
            }));
          const assistant = [...messages].reverse().find(msg => msg.role === 'assistant');
          return {
            url: location.href,
            bodyText: bodyText.slice(0, 8000),
            assistant,
          };
        })()`
      );

      const assistantText = state?.assistant?.text?.trim() || "";
      if (assistantText) {
        if (assistantText.startsWith(emittedText)) {
          const delta = assistantText.slice(emittedText.length);
          if (delta) {
            emittedText = assistantText;
            onDelta(delta);
          }
        } else if (assistantText !== emittedText) {
          emittedText = assistantText;
          onDelta(assistantText);
        }
      }

      if (assistantText && assistantText === lastAssistantText && Date.now() - stableSeenAt >= 2500) {
        return {
          ...state,
          assistant: {
            ...state.assistant,
            text: assistantText,
          },
        };
      }
      if (assistantText !== lastAssistantText) {
        lastAssistantText = assistantText;
        stableSeenAt = Date.now();
      }
      if (/something went wrong|unable to generate|try again/i.test(state?.bodyText || "")) {
        throw new Error(`Chat completion failed: ${state.bodyText.slice(0, 500)}`);
      }
      await sleep(1000);
    }
    throw new Error(`Timed out waiting for streamed chat result after ${timeoutMs}ms`);
  }

  async function fetchImageBytesInPage(page, imageUrl) {
    const data = await page.evaluate(
      `new Promise(async (resolve) => {
        try {
          const response = await fetch(${JSON.stringify(imageUrl)}, { credentials: 'include' });
          if (!response.ok) {
            return resolve({ ok: false, reason: 'fetch failed', status: response.status });
          }
          const blob = await response.blob();
          const reader = new FileReader();
          reader.onloadend = () => resolve({ ok: true, dataUrl: reader.result, mimeType: blob.type, size: blob.size });
          reader.onerror = () => resolve({ ok: false, reason: 'FileReader failed' });
          reader.readAsDataURL(blob);
        } catch (error) {
          resolve({ ok: false, reason: String(error) });
        }
      })`,
      { awaitPromise: true }
    );

    if (!data?.ok || !data.dataUrl) {
      throw new Error(data?.reason || "Failed to fetch image bytes in browser context");
    }
    const commaIndex = data.dataUrl.indexOf(",");
    return {
      mimeType: data.mimeType || "image/png",
      buffer: Buffer.from(data.dataUrl.slice(commaIndex + 1), "base64"),
    };
  }

  async function uploadFilesToChatPage(page, files) {
    if (!files.length) return;
    const imageFiles = files.filter(isImageFile);
    const otherFiles = files.filter((file) => !isImageFile(file));
    if (imageFiles.length) {
      await page.setFileInputFiles("#upload-photos", imageFiles.map((file) => file.path));
      await sleep(3000);
    }
    if (otherFiles.length) {
      await page.setFileInputFiles("#upload-files", otherFiles.map((file) => file.path));
      await sleep(3000);
    }
  }

  async function generateImage(prompt) {
    await fs.mkdir(outputDir, { recursive: true });
    return withImagePage(async (page) => {
      await ensureImagePage(page);
      try {
        const existingSources = await snapshotGeneratedImageSources(page);
        await submitImagePrompt(page, prompt);
        const state = await waitForImageResult(page, existingSources);
        const bytes = await fetchImageBytesInPage(page, state.image.src);
        const created = Math.floor(Date.now() / 1000);
        const filename = `chatgpt-image-${created}.png`;
        const filepath = path.join(outputDir, filename);
        await fs.writeFile(filepath, bytes.buffer);

        // Compute enrichment fields (SHA-256, dimensions) from the written file.
        // artifact_id is generated locally so it can be stored in both
        // jobs.json result[] and media.json without requiring a write-path round-trip.
        const artifact_id = `art_${created}_${Math.random().toString(36).slice(2, 10)}`;
        const digest = sha256(bytes.buffer);
        const dims = await readImageDimensions(filepath);

        return {
          created,
          model: "chatgpt-images",
          prompt,
          conversation_url: state.url,
          output_path: filepath,
          mime_type: bytes.mimeType,
          image_url: state.image.src,
          alt: state.image.alt,
          // New fields aligned with image-task.outputs / ArtifactOutput schema
          artifact_id,
          sha256: digest,
          width: dims?.width ?? null,
          height: dims?.height ?? null,
        };
      } catch (error) {
        if (shouldCleanupImageComposerError(error)) {
          await cleanupImageComposer(page);
        }
        throw error;
      }
    });
  }

  async function chatViaBrowser({ pageUrl, prompt, files = [], model = "chatgpt-web" }) {
    return withChatPage(async (page) => {
      await ensureChatPage(page);
      await uploadFilesToChatPage(page, files);
      await submitPrompt(page, prompt);
      const state = await waitForChatResult(page);
      return {
        created: Math.floor(Date.now() / 1000),
        model,
        prompt,
        conversation_url: state.url,
        content: state.assistant.text.trim(),
      };
    }, pageUrl);
  }

  async function streamChatViaBrowser({ pageUrl, prompt, files = [], model = "chatgpt-web", onDelta }) {
    return withChatPage(async (page) => {
      await ensureChatPage(page);
      await uploadFilesToChatPage(page, files);
      await submitPrompt(page, prompt);
      const state = await streamChatResult(page, onDelta);
      return {
        created: Math.floor(Date.now() / 1000),
        model,
        prompt,
        conversation_url: state.url,
        content: state.assistant.text.trim(),
      };
    }, pageUrl);
  }

  async function inspectBrowserReadiness() {
    const version = await fetchJson(`${cdpHttp}/json/version`);
    const pages = await fetchJson(`${cdpHttp}/json/list`);
    const chatPages = pages.filter(
      (page) =>
        page.type === "page" &&
        typeof page.url === "string" &&
        page.url.startsWith("https://chatgpt.com/")
    );

    return {
      ok: true,
      cdp_http: cdpHttp,
      browser: version.Browser || "",
      websocket_debugger_url: version.webSocketDebuggerUrl || "",
      total_pages: pages.length,
      chatgpt_pages: chatPages.length,
    };
  }

  async function inspectRuntimeStatus() {
    const checkedAt = new Date().toISOString();
    const queueStats = getQueueStats() || {};
    const lockCount = getSessionLockCount();
    const queue = {
      supported: true,
      mode: "profile-serial",
      pending: Number.isInteger(queueStats.pending) ? queueStats.pending : null,
      running: Number.isInteger(queueStats.running) ? queueStats.running : null,
      locks_active: Number.isInteger(lockCount) ? lockCount : null,
      total: Number.isInteger(queueStats.total) ? queueStats.total : null,
    };

    try {
      const version = await fetchJson(`${cdpHttp}/json/version`);
      const pages = await fetchJson(`${cdpHttp}/json/list`);
      const loggedIn = detectLoginFromPages(pages);
      const status = loggedIn === false ? "blocked" : loggedIn === null ? "degraded" : "ok";
      const blockedBy = loggedIn === false ? "login_required" : loggedIn === null ? "unknown" : "none";

      return {
        contract_version: "wcapi.browser_worker_runtime.v1",
        provider_id: "chatgpt-web",
        provider_type: "browser-session",
        checked_at: checkedAt,
        status,
        service_alive: true,
        logged_in: loggedIn,
        cdp_ready: true,
        browser_connected: true,
        browserConnected: true,
        blocked_by: blockedBy,
        queue,
        lock_policy: {
          scope: "profile",
          implementation: "JobQueue + SessionLockRegistry",
          note: "All provider operations are serialized through the single browser profile; conversation locks are nested inside chat operations.",
        },
        profiles: [
          {
            id: "default",
            label: "ChatGPT Web default browser profile",
            cdp_http: cdpHttp,
            cdp_ready: true,
            logged_in: loggedIn,
            browser_connected: true,
            queue,
            details: {
              browser: version.Browser || "",
              websocket_debugger_url: version.webSocketDebuggerUrl || "",
              pages: pages
                .filter((page) => page.type === "page")
                .map((page) => ({
                  id: page.id,
                  title: page.title || "",
                  url: page.url || "",
                }))
                .slice(0, 20),
            },
          },
        ],
        capabilities: {
          chat: true,
          streaming: true,
          images: true,
          files: true,
          vision: true,
          image_edits: false,
        },
        details: {
          cdp_http: cdpHttp,
          chat_page_url: chatPageUrl,
          image_page_url: imagePageUrl,
          browser: version.Browser || "",
          total_pages: pages.length,
        },
      };
    } catch (error) {
      return {
        contract_version: "wcapi.browser_worker_runtime.v1",
        provider_id: "chatgpt-web",
        provider_type: "browser-session",
        checked_at: checkedAt,
        status: "error",
        service_alive: true,
        logged_in: null,
        cdp_ready: false,
        browser_connected: false,
        browserConnected: false,
        blocked_by: "browser_session",
        queue,
        lock_policy: {
          scope: "profile",
          implementation: "JobQueue + SessionLockRegistry",
        },
        profiles: [
          {
            id: "default",
            label: "ChatGPT Web default browser profile",
            cdp_http: cdpHttp,
            cdp_ready: false,
            logged_in: null,
            browser_connected: false,
            queue,
            details: {
              error: String(error?.message || error),
            },
          },
        ],
        capabilities: {
          chat: true,
          streaming: true,
          images: true,
          files: true,
          vision: true,
          image_edits: false,
        },
        details: {
          cdp_http: cdpHttp,
          error: String(error?.message || error),
        },
      };
    }
  }

  return {
    chatViaBrowser,
    streamChatViaBrowser,
    generateImage,
    prepareImageThinkingMode,
    inspectBrowserReadiness,
    inspectRuntimeStatus,
  };
}

export const __testHooks = {
  classifyImageComposerFailure,
  shouldCleanupImageComposerError,
  submitImagePrompt,
};
