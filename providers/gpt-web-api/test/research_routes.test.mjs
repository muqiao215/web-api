import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { JobQueue } from "../lib/job_queue.mjs";
import { createResearchRouteHandler } from "../routes/research_routes.mjs";
import { createResearchService } from "../services/research_service.mjs";
import { sendJson } from "../services/http_utils.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function createSourceServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/alpha") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <html>
          <head><title>Alpha Report</title></head>
          <body>
            <h1>Alpha finding</h1>
            <p>Alpha systems reduced error rates by 18 percent.</p>
          </body>
        </html>
      `);
      return;
    }

    if (req.url === "/beta") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Beta insight: operators still need manual review for edge cases.");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  const baseUrl = await listen(server);
  return { server, baseUrl };
}

function createFakeProvider() {
  return {
    id: "chatgpt-web",
    models() {
      return [{ id: "chatgpt-web" }];
    },
    async chatCompletion(messages, options = {}) {
      const prompt = messages.map((message) => String(message.content || "")).join("\n");
      assert.match(prompt, /Alpha finding/);
      assert.match(prompt, /Beta insight/);
      assert.match(prompt, /工业控制系统/);
      return {
        content: [
          "# 研究摘要",
          "",
          "基于来源，工业控制系统改进带来了更低的错误率，但边缘场景仍需要人工复核。",
          "",
          "## 关键发现",
          "",
          "- Alpha 来源提到错误率下降 18%。",
          "- Beta 来源强调边缘案例仍需人工介入。",
        ].join("\n"),
        model: options.model || "chatgpt-web",
        created: 1776500000,
        conversation_url: null,
        conversation_id: null,
      };
    },
  };
}

async function createResearchApiServer() {
  const provider = createFakeProvider();
  const jobQueue = new JobQueue({ idPrefix: "researchtest" });
  const researchService = createResearchService({
    jobQueue,
    providerRouter: {
      resolveProvider() {
        return provider;
      },
    },
    withTimeout(work) {
      return work();
    },
    fetchImpl: fetch,
  });

  const handleResearchRoute = createResearchRouteHandler({
    researchService,
    publicBaseUrl: "http://127.0.0.1:0",
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (await handleResearchRoute(req, res, url)) {
      return;
    }
    sendJson(res, 404, { error: { message: "not found" } });
  });

  const baseUrl = await listen(server);
  return { server, baseUrl, jobQueue };
}

test("research routes create an async job and expose the synthesized result", async () => {
  const source = await createSourceServer();
  const api = await createResearchApiServer();

  try {
    const createResponse = await fetch(`${api.baseUrl}/v1/research/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "工业控制系统上线后的质量变化",
        urls: [`${source.baseUrl}/alpha`, `${source.baseUrl}/beta`],
        depth: "deep",
        max_sources: 2,
        report_style: "briefing",
      }),
    });

    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    assert.equal(created.object, "research.job");
    assert.equal(created.status, "queued");
    assert.match(created.id, /^researchtest_/);
    assert.equal(new URL(created.urls.result).pathname, `/v1/research/jobs/${created.id}/result`);

    await api.jobQueue.wait(created.id);

    const jobResponse = await fetch(`${api.baseUrl}/v1/research/jobs/${created.id}`);
    assert.equal(jobResponse.status, 200);
    const job = await jobResponse.json();
    assert.equal(job.status, "succeeded");
    assert.equal(job.metadata.request.depth, "deep");

    const resultResponse = await fetch(`${api.baseUrl}/v1/research/jobs/${created.id}/result`);
    assert.equal(resultResponse.status, 200);
    const result = await resultResponse.json();
    assert.equal(result.object, "research.result");
    assert.match(result.summary_markdown, /研究摘要/);
    assert.equal(result.sources.length, 2);
    assert.equal(result.sources[0].title, "Alpha Report");
    assert.match(result.sources[1].excerpt, /Beta insight/);
    assert.equal(result.pipeline.stages.length, 3);
    assert.equal(result.provider.id, "chatgpt-web");
  } finally {
    await close(api.server);
    await close(source.server);
  }
});

test("research routes reject invalid requests and unknown jobs", async () => {
  const api = await createResearchApiServer();

  try {
    const invalidResponse = await fetch(`${api.baseUrl}/v1/research/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls: ["https://example.test/report"] }),
    });

    assert.equal(invalidResponse.status, 400);
    const invalid = await invalidResponse.json();
    assert.match(invalid.error.message, /query is required/);

    const missingJob = await fetch(`${api.baseUrl}/v1/research/jobs/researchtest_missing`);
    assert.equal(missingJob.status, 404);

    const missingResult = await fetch(`${api.baseUrl}/v1/research/jobs/researchtest_missing/result`);
    assert.equal(missingResult.status, 404);
  } finally {
    await close(api.server);
  }
});
