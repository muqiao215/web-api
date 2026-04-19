import { errorBody } from "../lib/api_error.mjs";
import { readJsonBody, sendJson } from "../services/http_utils.mjs";

export function createResearchRouteHandler({ researchService, publicBaseUrl }) {
  if (!researchService) {
    throw new Error("researchService is required");
  }

  return async function handleResearchRoute(req, res, url) {
    const { pathname } = url;

    if (req.method === "POST" && pathname === "/v1/research/jobs") {
      try {
        const body = await readJsonBody(req);
        const job = await researchService.createJob(body);
        sendJson(res, 202, serializeResearchJob(job, publicBaseUrl));
      } catch (error) {
        const { status, body } = errorBody(error);
        sendJson(res, status, body);
      }
      return true;
    }

    const jobResultMatch = /^\/v1\/research\/jobs\/([^/]+)\/result$/.exec(pathname);
    if (req.method === "GET" && jobResultMatch) {
      const jobId = decodeURIComponent(jobResultMatch[1]);
      const job = researchService.getJob(jobId);
      if (!job) {
        sendJson(res, 404, { error: { message: `Unknown research job: ${jobId}` } });
        return true;
      }
      if (job.status === "queued" || job.status === "running") {
        sendJson(res, 202, {
          object: "research.result.pending",
          id: job.id,
          status: job.status,
          urls: buildUrls(job.id, publicBaseUrl),
        });
        return true;
      }
      if (job.status === "failed") {
        sendJson(res, 409, {
          error: job.error || { message: "research job failed" },
          job: serializeResearchJob(job, publicBaseUrl),
        });
        return true;
      }
      sendJson(res, 200, job.result);
      return true;
    }

    const jobMatch = /^\/v1\/research\/jobs\/([^/]+)$/.exec(pathname);
    if (req.method === "GET" && jobMatch) {
      const jobId = decodeURIComponent(jobMatch[1]);
      const job = researchService.getJob(jobId);
      if (!job) {
        sendJson(res, 404, { error: { message: `Unknown research job: ${jobId}` } });
        return true;
      }
      sendJson(res, 200, serializeResearchJob(job, publicBaseUrl));
      return true;
    }

    return false;
  };
}

function serializeResearchJob(job, publicBaseUrl) {
  return {
    object: "research.job",
    id: job.id,
    type: job.type,
    status: job.status,
    created_at: job.created_at,
    updated_at: job.updated_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    metadata: job.metadata,
    error: job.error,
    urls: buildUrls(job.id, publicBaseUrl),
  };
}

function buildUrls(jobId, publicBaseUrl) {
  return {
    self: `${publicBaseUrl}/v1/research/jobs/${jobId}`,
    result: `${publicBaseUrl}/v1/research/jobs/${jobId}/result`,
  };
}
