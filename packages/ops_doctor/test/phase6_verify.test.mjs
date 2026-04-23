import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  fetchHealth,
  main,
  smokeCanvas,
  smokeGptAdmin,
  smokeSub2api,
} from "../src/phase6_verify.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function withJsonServer(handler, fn) {
  const server = http.createServer(handler);
  try {
    const baseUrl = await listen(server);
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test("fetchHealth clears timeout on success", async () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const issuedTimers = [];
  const clearedTimers = [];

  global.setTimeout = ((fn, ms, ...args) => {
    const timer = originalSetTimeout(fn, ms, ...args);
    issuedTimers.push(timer);
    return timer;
  });
  global.clearTimeout = ((timer) => {
    clearedTimers.push(timer);
    return originalClearTimeout(timer);
  });

  try {
    const fetchStub = async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    const result = await fetchHealth("http://unit.test/health", 50, fetchStub);
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { status: "ok" });
    assert.equal(issuedTimers.length, 1);
    assert.deepEqual(clearedTimers, issuedTimers);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("fetchHealth clears timeout on fetch failure", async () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const issuedTimers = [];
  const clearedTimers = [];

  global.setTimeout = ((fn, ms, ...args) => {
    const timer = originalSetTimeout(fn, ms, ...args);
    issuedTimers.push(timer);
    return timer;
  });
  global.clearTimeout = ((timer) => {
    clearedTimers.push(timer);
    return originalClearTimeout(timer);
  });

  try {
    const fetchStub = async () => {
      throw new Error("fetch failed");
    };
    const result = await fetchHealth("http://unit.test/health", 50, fetchStub);
    assert.equal(result.ok, false);
    assert.match(result.error, /unreachable/i);
    assert.equal(issuedTimers.length, 1);
    assert.deepEqual(clearedTimers, issuedTimers);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("fetchHealth maps aborts to timeout", async () => {
  await withJsonServer((req, res) => {
    req.socket.on("close", () => {
      res.end();
    });
  }, async (baseUrl) => {
    const result = await fetchHealth(`${baseUrl}/slow`, 25);
    assert.equal(result.ok, false);
    assert.equal(result.error, "timeout");
  });
});

test("smokeGptAdmin passes on expected runtime_contract shape", async () => {
  await withJsonServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      service: "gpt_web_api",
      cdp: "http://127.0.0.1:9222",
      provider_count: 1,
      runtime_contract: {
        service_alive: true,
      },
    }));
  }, async (baseUrl) => {
    const result = await smokeGptAdmin(baseUrl);
    assert.equal(result.status, "PASS");
    assert.equal(result.evidence.provider_count, 1);
  });
});

test("smokeSub2api treats thin status-only health as control-plane-only PASS", async () => {
  await withJsonServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok" }));
  }, async (baseUrl) => {
    const result = await smokeSub2api(baseUrl);
    assert.equal(result.status, "PASS");
    assert.equal(result.evidence.routing_verified, false);
    assert.match(result.detail, /not proven/i);
    assert.match(result.evidence.limitation, /control-plane reachability/i);
  });
});

test("smokeSub2api only claims routing when provider metadata is present", async () => {
  await withJsonServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      status: "ok",
      providers: [{ id: "chatgpt-web" }],
    }));
  }, async (baseUrl) => {
    const result = await smokeSub2api(baseUrl);
    assert.equal(result.status, "PASS");
    assert.equal(result.evidence.routing_verified, true);
    assert.match(result.detail, /routing is present/i);
  });
});

test("smokeCanvas passes on canonical Gemini Web runtime health shape", async () => {
  await withJsonServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      status: "ok",
      service_alive: true,
      provider_id_canonical: "gemini-web",
      blocked_by: "none",
    }));
  }, async (baseUrl) => {
    const result = await smokeCanvas(baseUrl);
    assert.equal(result.status, "PASS");
    assert.equal(result.evidence.service_alive, true);
    assert.equal(result.evidence.provider_id_canonical, "gemini-web");
  });
});

test("smokeCanvas fails on unhealthy canonical Gemini Web runtime health", async () => {
  await withJsonServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      status: "blocked",
      service_alive: false,
      provider_id_canonical: "gemini-web",
      blocked_by: "cookie_missing",
    }));
  }, async (baseUrl) => {
    const result = await smokeCanvas(baseUrl);
    assert.equal(result.status, "FAIL");
    assert.match(result.detail, /unhealthy/i);
    assert.equal(result.evidence.blocked_by, "cookie_missing");
  });
});

test("smokeCanvas fails on invalid thin health shape", async () => {
  await withJsonServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      status: "ok",
      service_alive: true,
    }));
  }, async (baseUrl) => {
    const result = await smokeCanvas(baseUrl);
    assert.equal(result.status, "FAIL");
    assert.match(result.detail, /unexpected shape/i);
  });
});

test("main returns exit code 1 when canvas is blocked even if GPT and sub2api pass", async () => {
  const gptServer = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      service: "gpt_web_api",
      cdp: "http://127.0.0.1:9222",
      provider_count: 1,
      runtime_contract: { service_alive: true },
    }));
  });
  const sub2apiServer = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok" }));
  });
  const canvasServer = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "blocked", service_alive: false, provider_id_canonical: "gemini-web" }));
  });

  try {
    const [gptUrl, sub2apiUrl, canvasUrl] = await Promise.all([
      listen(gptServer),
      listen(sub2apiServer),
      listen(canvasServer),
    ]);
    const { exitCode, output } = await main({
      gptAdminUrl: gptUrl,
      sub2apiUrl,
      canvasHealthUrl: canvasUrl,
      emit: false,
    });

    assert.equal(exitCode, 1);
    assert.equal(output.summary.gpt_worker_smoke, "PASS");
    assert.equal(output.summary.sub2api_smoke, "PASS");
    assert.equal(output.summary.gemini_web_smoke, "FAIL");
  } finally {
    await Promise.all([
      new Promise((resolve, reject) => gptServer.close((error) => (error ? reject(error) : resolve()))),
      new Promise((resolve, reject) => sub2apiServer.close((error) => (error ? reject(error) : resolve()))),
      new Promise((resolve, reject) => canvasServer.close((error) => (error ? reject(error) : resolve()))),
    ]);
  }
});

test("main returns exit code 0 only when GPT, sub2api, and canvas all pass", async () => {
  const gptServer = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      service: "gpt_web_api",
      cdp: "http://127.0.0.1:9222",
      provider_count: 1,
      runtime_contract: { service_alive: true },
    }));
  });
  const sub2apiServer = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok" }));
  });
  const canvasServer = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", service_alive: true, provider_id_canonical: "gemini-web" }));
  });

  try {
    const [gptUrl, sub2apiUrl, canvasUrl] = await Promise.all([
      listen(gptServer),
      listen(sub2apiServer),
      listen(canvasServer),
    ]);
    const { exitCode, output } = await main({
      gptAdminUrl: gptUrl,
      sub2apiUrl,
      canvasHealthUrl: canvasUrl,
      emit: false,
    });

    assert.equal(exitCode, 0);
    assert.equal(output.summary.gpt_worker_smoke, "PASS");
    assert.equal(output.summary.sub2api_smoke, "PASS");
    assert.equal(output.summary.gemini_web_smoke, "PASS");
  } finally {
    await Promise.all([
      new Promise((resolve, reject) => gptServer.close((error) => (error ? reject(error) : resolve()))),
      new Promise((resolve, reject) => sub2apiServer.close((error) => (error ? reject(error) : resolve()))),
      new Promise((resolve, reject) => canvasServer.close((error) => (error ? reject(error) : resolve()))),
    ]);
  }
});

test("main returns exit code 1 when sub2api health is unhealthy", async () => {
  const gptServer = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      service: "gpt_web_api",
      cdp: "http://127.0.0.1:9222",
      provider_count: 1,
      runtime_contract: { service_alive: true },
    }));
  });
  const sub2apiServer = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "degraded" }));
  });
  const canvasServer = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", service_alive: true, provider_id_canonical: "gemini-web" }));
  });

  try {
    const [gptUrl, sub2apiUrl, canvasUrl] = await Promise.all([
      listen(gptServer),
      listen(sub2apiServer),
      listen(canvasServer),
    ]);
    const { exitCode, output } = await main({
      gptAdminUrl: gptUrl,
      sub2apiUrl,
      canvasHealthUrl: canvasUrl,
      emit: false,
    });

    assert.equal(exitCode, 1);
    assert.equal(output.summary.sub2api_smoke, "FAIL");
  } finally {
    await Promise.all([
      new Promise((resolve, reject) => gptServer.close((error) => (error ? reject(error) : resolve()))),
      new Promise((resolve, reject) => sub2apiServer.close((error) => (error ? reject(error) : resolve()))),
      new Promise((resolve, reject) => canvasServer.close((error) => (error ? reject(error) : resolve()))),
    ]);
  }
});
