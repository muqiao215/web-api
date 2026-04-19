import { ApiError } from "../lib/api_error.mjs";

const VALID_DEPTHS = new Set(["quick", "standard", "deep"]);
const VALID_REPORT_STYLES = new Set(["briefing", "report", "bullets"]);
const MAX_SOURCES_LIMIT = 10;
const MAX_SOURCE_CONTENT_CHARS = 12000;

export function createResearchService({
  jobQueue,
  providerRouter,
  withTimeout = (work) => work(),
  fetchImpl = globalThis.fetch,
  researchTimeoutMs = 240000,
  defaultLanguage = "zh-CN",
}) {
  if (!jobQueue) {
    throw new Error("jobQueue is required");
  }
  if (!providerRouter) {
    throw new Error("providerRouter is required");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl must be a function");
  }

  function getJob(jobId) {
    const job = jobQueue.get(jobId);
    if (!job || job.type !== "research.job") {
      return null;
    }
    return job;
  }

  async function createJob(input = {}) {
    const request = normalizeResearchRequest(input, defaultLanguage);
    const selectedProvider = providerRouter.resolveProvider({
      providerId: request.provider,
      modelId: request.model,
    });
    const selectedModel = request.model || selectedProvider.models?.()[0]?.id || selectedProvider.id;

    return jobQueue.enqueue(
      "research.job",
      async () => {
        const sources = await collectSources(request, fetchImpl);
        const synthesis = await withTimeout(
          () =>
            selectedProvider.chatCompletion(buildResearchMessages(request, sources), {
              providerId: selectedProvider.id,
              model: selectedModel,
            }),
          researchTimeoutMs,
          "Research synthesis"
        );
        return buildResearchResult({
          request,
          sources,
          provider: {
            id: selectedProvider.id,
            model: selectedModel,
          },
          synthesis,
        });
      },
      {
        kind: "research",
        request: {
          query: request.query,
          language: request.language,
          depth: request.depth,
          report_style: request.report_style,
          max_sources: request.max_sources,
          url_count: request.urls.length,
          inline_source_count: request.inlineSources.length,
        },
        provider: {
          id: selectedProvider.id,
          model: selectedModel,
        },
        pipeline: ["search", "read", "synthesize"],
      }
    );
  }

  return {
    createJob,
    getJob,
  };
}

function normalizeResearchRequest(input, defaultLanguage) {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) {
    throw new ApiError("query is required", {
      status: 400,
      type: "invalid_request_error",
      code: "research_query_required",
    });
  }

  const language = typeof input.language === "string" && input.language.trim() ? input.language.trim() : defaultLanguage;
  const depth = typeof input.depth === "string" && input.depth.trim() ? input.depth.trim() : "standard";
  const reportStyle =
    typeof input.report_style === "string" && input.report_style.trim() ? input.report_style.trim() : "briefing";
  const maxSources = Number.isInteger(input.max_sources) ? input.max_sources : Number(input.max_sources || 5);

  if (!VALID_DEPTHS.has(depth)) {
    throw new ApiError(`depth must be one of: ${[...VALID_DEPTHS].join(", ")}`, {
      status: 400,
      type: "invalid_request_error",
      code: "research_invalid_depth",
    });
  }

  if (!VALID_REPORT_STYLES.has(reportStyle)) {
    throw new ApiError(`report_style must be one of: ${[...VALID_REPORT_STYLES].join(", ")}`, {
      status: 400,
      type: "invalid_request_error",
      code: "research_invalid_report_style",
    });
  }

  if (!Number.isInteger(maxSources) || maxSources < 1 || maxSources > MAX_SOURCES_LIMIT) {
    throw new ApiError(`max_sources must be an integer between 1 and ${MAX_SOURCES_LIMIT}`, {
      status: 400,
      type: "invalid_request_error",
      code: "research_invalid_max_sources",
    });
  }

  const urls = normalizeUrls(input.urls);
  const inlineSources = normalizeInlineSources(input.sources);
  if (urls.length + inlineSources.length === 0) {
    throw new ApiError("provide at least one source via urls[] or sources[]", {
      status: 400,
      type: "invalid_request_error",
      code: "research_source_required",
    });
  }

  return {
    query,
    language,
    depth,
    report_style: reportStyle,
    max_sources: maxSources,
    provider: typeof input.provider === "string" ? input.provider.trim() : "",
    model: typeof input.model === "string" ? input.model.trim() : "",
    context: typeof input.context === "string" ? input.context.trim() : "",
    urls: urls.slice(0, maxSources),
    inlineSources: inlineSources.slice(0, Math.max(0, maxSources - urls.length)),
  };
}

function normalizeUrls(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const urls = [];
  for (const candidate of value) {
    const url = typeof candidate === "string" ? candidate.trim() : "";
    if (!url || seen.has(url)) {
      continue;
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new ApiError(`invalid url: ${url}`, {
        status: 400,
        type: "invalid_request_error",
        code: "research_invalid_url",
      });
    }
    if (!/^https?:$/i.test(parsed.protocol)) {
      throw new ApiError(`unsupported source protocol for research url: ${url}`, {
        status: 400,
        type: "invalid_request_error",
        code: "research_invalid_url_protocol",
      });
    }
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function normalizeInlineSources(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = [];
  for (const [index, item] of value.entries()) {
    if (typeof item === "string" && item.trim()) {
      normalized.push({
        title: `Inline Source ${index + 1}`,
        text: item.trim(),
      });
      continue;
    }
    if (!item || typeof item !== "object") {
      continue;
    }
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!text) {
      continue;
    }
    normalized.push({
      title:
        typeof item.title === "string" && item.title.trim() ? item.title.trim() : `Inline Source ${index + 1}`,
      text,
      url: typeof item.url === "string" && item.url.trim() ? item.url.trim() : "",
    });
  }
  return normalized;
}

async function collectSources(request, fetchImpl) {
  const collected = [];
  let ordinal = 1;

  for (const url of request.urls) {
    const fetched = await fetchSource(url, ordinal, fetchImpl);
    collected.push(fetched);
    ordinal += 1;
  }

  for (const inline of request.inlineSources) {
    collected.push({
      id: `S${ordinal}`,
      kind: "inline",
      url: inline.url || null,
      title: inline.title,
      content_type: "text/plain",
      excerpt: buildExcerpt(inline.text),
      content: truncateText(normalizeWhitespace(inline.text), MAX_SOURCE_CONTENT_CHARS),
      fetched_at: new Date().toISOString(),
    });
    ordinal += 1;
  }

  return collected;
}

async function fetchSource(url, ordinal, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      "user-agent": "gpt-web-api research/0.1",
      accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new ApiError(`failed to fetch source ${url}: HTTP ${response.status}`, {
      status: 502,
      type: "provider_error",
      code: "research_fetch_failed",
    });
  }

  const contentType = response.headers.get("content-type") || "text/plain";
  const raw = await response.text();
  const title = extractSourceTitle(url, contentType, raw);
  const content = extractSourceContent(contentType, raw);

  if (!content.trim()) {
    throw new ApiError(`source ${url} returned no readable content`, {
      status: 422,
      type: "invalid_request_error",
      code: "research_source_empty",
    });
  }

  return {
    id: `S${ordinal}`,
    kind: "url",
    url,
    title,
    content_type: contentType.split(";")[0].trim().toLowerCase() || "text/plain",
    excerpt: buildExcerpt(content),
    content: truncateText(content, MAX_SOURCE_CONTENT_CHARS),
    fetched_at: new Date().toISOString(),
  };
}

function extractSourceTitle(url, contentType, raw) {
  if (/html/i.test(contentType)) {
    const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch?.[1]) {
      return normalizeWhitespace(decodeHtmlEntities(titleMatch[1])).slice(0, 140);
    }
    const h1Match = raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match?.[1]) {
      return normalizeWhitespace(decodeHtmlEntities(stripTags(h1Match[1]))).slice(0, 140);
    }
  }
  return fallbackTitleFromUrl(url);
}

function extractSourceContent(contentType, raw) {
  if (/application\/json/i.test(contentType)) {
    try {
      return truncateText(JSON.stringify(JSON.parse(raw), null, 2), MAX_SOURCE_CONTENT_CHARS);
    } catch {
      return truncateText(normalizeWhitespace(raw), MAX_SOURCE_CONTENT_CHARS);
    }
  }

  if (/html/i.test(contentType)) {
    const withoutScripts = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
    return truncateText(normalizeWhitespace(decodeHtmlEntities(stripTags(withoutScripts))), MAX_SOURCE_CONTENT_CHARS);
  }

  return truncateText(normalizeWhitespace(raw), MAX_SOURCE_CONTENT_CHARS);
}

function buildResearchMessages(request, sources) {
  const sourceBlocks = sources
    .map((source) =>
      [
        `[${source.id}] ${source.title}`,
        source.url ? `URL: ${source.url}` : "URL: (inline source)",
        `Excerpt: ${source.excerpt}`,
        "Content:",
        source.content,
      ].join("\n")
    )
    .join("\n\n---\n\n");

  return [
    {
      role: "system",
      content: [
        `You are a rigorous research analyst.`,
        `Write the final answer in ${request.language}.`,
        `Use only the provided source material.`,
        `Do not invent facts beyond the source text.`,
        `Return Markdown with clear headings and cite sources using labels like [S1], [S2].`,
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Research query: ${request.query}`,
        request.context ? `Additional context: ${request.context}` : "",
        `Depth: ${request.depth}`,
        `Report style: ${request.report_style}`,
        "",
        "Output requirements:",
        "1. Start with a concise executive summary.",
        "2. Then give key findings.",
        "3. Include evidence and source mapping.",
        "4. Explicitly state limitations or unresolved questions.",
        "5. End with three follow-up questions.",
        "",
        "Sources:",
        sourceBlocks,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
}

function buildResearchResult({ request, sources, provider, synthesis }) {
  const summaryMarkdown = typeof synthesis?.content === "string" ? synthesis.content.trim() : "";
  const sections = parseMarkdownSections(summaryMarkdown || `# 研究摘要\n\n${request.query}`);

  return {
    object: "research.result",
    query: request.query,
    language: request.language,
    depth: request.depth,
    report_style: request.report_style,
    provider,
    created_at: new Date().toISOString(),
    summary_markdown: summaryMarkdown,
    sections,
    sources: sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      title: source.title,
      url: source.url,
      content_type: source.content_type,
      excerpt: source.excerpt,
      fetched_at: source.fetched_at,
    })),
    followup_suggestions: buildFollowupSuggestions(request, sources),
    pipeline: {
      stages: [
        {
          name: "search",
          status: "completed",
          input_url_count: request.urls.length,
          inline_source_count: request.inlineSources.length,
        },
        {
          name: "read",
          status: "completed",
          collected_source_count: sources.length,
        },
        {
          name: "synthesize",
          status: "completed",
          provider: provider.id,
          model: provider.model,
        },
      ],
    },
  };
}

function buildFollowupSuggestions(request, sources) {
  const firstTitle = sources[0]?.title || "主要来源";
  return [
    `围绕“${request.query}”，还有哪些反例或失败案例没有覆盖？`,
    `如果只进一步核查一个来源，为什么应该优先回到《${firstTitle}》？`,
    `要把这份研究转成行动方案，还缺哪些一手数据或现场验证？`,
  ];
}

function parseMarkdownSections(markdown) {
  const lines = String(markdown || "").split("\n");
  const sections = [];
  let current = null;

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) {
      if (current) {
        sections.push(finalizeSection(current));
      }
      current = {
        level: match[1].length,
        title: match[2].trim(),
        lines: [],
      };
      continue;
    }

    if (!current) {
      current = {
        level: 1,
        title: "研究摘要",
        lines: [],
      };
    }
    current.lines.push(line);
  }

  if (current) {
    sections.push(finalizeSection(current));
  }

  return sections.filter((section) => section.content_markdown.trim());
}

function finalizeSection(section) {
  return {
    title: section.title,
    level: section.level,
    content_markdown: section.lines.join("\n").trim(),
  };
}

function stripTags(input) {
  return input.replace(/<[^>]+>/g, " ");
}

function decodeHtmlEntities(input) {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function normalizeWhitespace(input) {
  return String(input || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function truncateText(input, maxChars) {
  const normalized = String(input || "");
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function buildExcerpt(input) {
  return truncateText(normalizeWhitespace(input).replace(/\n/g, " "), 280);
}

function fallbackTitleFromUrl(input) {
  try {
    const url = new URL(input);
    const tail = url.pathname.split("/").filter(Boolean).at(-1);
    return tail ? decodeURIComponent(tail) : url.hostname;
  } catch {
    return input;
  }
}
