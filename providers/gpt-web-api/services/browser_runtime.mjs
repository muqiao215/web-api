import fs from "node:fs/promises";
import path from "node:path";

import { pickThinkingControlCandidate } from "./image_generation_modes.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      const existingSources = await snapshotGeneratedImageSources(page);
      await submitPrompt(page, prompt);
      const state = await waitForImageResult(page, existingSources);
      const bytes = await fetchImageBytesInPage(page, state.image.src);
      const created = Math.floor(Date.now() / 1000);
      const filename = `chatgpt-image-${created}.png`;
      const filepath = path.join(outputDir, filename);
      await fs.writeFile(filepath, bytes.buffer);
      return {
        created,
        model: "chatgpt-images",
        prompt,
        conversation_url: state.url,
        output_path: filepath,
        mime_type: bytes.mimeType,
        image_url: state.image.src,
        alt: state.image.alt,
      };
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
