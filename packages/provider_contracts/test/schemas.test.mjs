import assert from "node:assert/strict";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SCHEMAS_DIR = path.join(__dirname, "../schemas");
const SCHEMA_FILES = [
  "provider-capability.schema.json",
  "artifact-record.schema.json",
  "runtime-health.schema.json",
  "browser-worker-runtime.schema.json",
  "image-task.schema.json",
  "account-pool.schema.json",
  "proxy-pool.schema.json",
  "queue-state.schema.json",
  "audit-event.schema.json",
  "artifact-output.schema.json",
];

// Build Ajv once with all schemas
// Pre-load all schemas by their $id so cross-$ref resolution works at compile time.
// Ajv v8 resolves $ref immediately during compile; loadSchema is only a fallback
// for truly unknown URIs. By pre-loading, all local refs resolve without callback.
const ajv = new Ajv({ allErrors: true, strict: false, validateSchema: false });
addFormats(ajv);

// Load all schemas into memory first
const schemaByFile = {};
for (const file of SCHEMA_FILES) {
  const schemaPath = path.join(SCHEMAS_DIR, file);
  const raw = await fs.readFile(schemaPath, "utf8");
  schemaByFile[file] = JSON.parse(raw);
}

// Register each schema under its $id so $ref resolution finds them
for (const [file, schema] of Object.entries(schemaByFile)) {
  if (schema.$id) ajv.addSchema(schema);
}

// Compile validators after all schemas are pre-registered
const validators = {};
for (const [file, schema] of Object.entries(schemaByFile)) {
  validators[file] = ajv.compile(schema);
}

test("All schema files are valid JSON", async () => {
  for (const file of SCHEMA_FILES) {
    const schemaPath = path.join(SCHEMAS_DIR, file);
    const raw = await fs.readFile(schemaPath, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(typeof parsed.$schema, "string", `${file}: missing $schema`);
    assert.equal(typeof parsed.title, "string", `${file}: missing title`);
    assert.equal(parsed.$schema, "https://json-schema.org/draft/2020-12/schema");
  }
});

// --- provider-capability.schema.json ---

test("provider-capability: minimal valid instance passes", () => {
  const validate = validators["provider-capability.schema.json"];
  const instance = {
    contract_version: "1.0.0",
    id: "gpt-web",
    type: "browser-session",
    health_tier: "api_surface_aligned",
    capabilities: { chat: true, images: true },
    models: ["gpt-image-2"],
  };
  assert.ok(validate(instance), JSON.stringify(validate.errors, null, 2));
});

test("provider-capability: health_tier enum values", () => {
  const validate = validators["provider-capability.schema.json"];
  for (const tier of ["api_surface_aligned", "routed", "healthy"]) {
    assert.ok(
      validate({ contract_version: "1.0.0", id: "p", type: "browser-session", health_tier: tier, capabilities: {}, models: [] }),
      `health_tier=${tier} should pass`
    );
  }
  assert.ok(
    !validate({ contract_version: "1.0.0", id: "p", type: "browser-session", health_tier: "invalid", capabilities: {}, models: [] }),
    "health_tier=invalid should fail"
  );
});

// --- artifact-record.schema.json ---

test("artifact-record: minimal valid instance passes", () => {
  const validate = validators["artifact-record.schema.json"];
  const instance = {
    contract_version: "1.0.0",
    id: "art_xxx",
    object: "artifact",
    provider: "chatgpt-web",
    kind: "image",
    model: "chatgpt-images",
    created_at: 1713000000,
    local_path: "/tmp/out.png",
    metadata: {},
  };
  assert.ok(validate(instance), JSON.stringify(validate.errors, null, 2));
});

// --- image-task.schema.json ---

test("image-task: all status values accepted", () => {
  const validate = validators["image-task.schema.json"];
  const base = {
    contract_version: "1.0.0",
    id: "imgtask_xxx",
    provider: "gpt-web",
    model: "gpt-image-2",
    prompt: "a glass apple",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  for (const status of ["queued", "running", "succeeded", "failed", "partial", "cancelled"]) {
    assert.ok(
      validate({ ...base, status }),
      `status=${status} should pass`
    );
  }
});

test("image-task: output artifact shape", () => {
  const validate = validators["image-task.schema.json"];
  const instance = {
    contract_version: "1.0.0",
    id: "imgtask_yyy",
    provider: "gpt-web",
    model: "gpt-image-2",
    status: "succeeded",
    prompt: "red sphere",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    outputs: [
      {
        artifact_id: "art_abc",
        url: "/v1/artifacts/art_abc",
        mime: "image/png",
        width: 1024,
        height: 1024,
        sha256: "abc123",
      },
    ],
  };
  assert.ok(validate(instance), JSON.stringify(validate.errors, null, 2));
});

test("image-task: error object shape", () => {
  const validate = validators["image-task.schema.json"];
  const instance = {
    contract_version: "1.0.0",
    id: "imgtask_err",
    provider: "gpt-web",
    model: "gpt-image-2",
    status: "failed",
    prompt: "test",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    error: { code: "RATE_LIMIT", message: "too many requests", retriable: true },
  };
  assert.ok(validate(instance), JSON.stringify(validate.errors, null, 2));
});

// --- account-pool.schema.json ---

test("account-pool: account with lease and health", () => {
  const validate = validators["account-pool.schema.json"];
  const instance = {
    contract_version: "1.0.0",
    provider: "gpt-web",
    accounts: [
      {
        id: "gpt-profile-a",
        label: "Default",
        lease: {
          task_id: "imgtask_123",
          leased_by: "scheduler",
          leased_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60000).toISOString(),
        },
        health: {
          status: "healthy",
          last_checked_at: new Date().toISOString(),
          direct_worker_ok: true,
          sub2api_smoke_ok: true,
          failure_count: 0,
        },
        usage: { requests_count: 42, images_count: 7 },
      },
    ],
  };
  assert.ok(validate(instance), JSON.stringify(validate.errors, null, 2));
});

test("account-pool: account in cooldown", () => {
  const validate = validators["account-pool.schema.json"];
  const instance = {
    contract_version: "1.0.0",
    provider: "gpt-web",
    accounts: [
      {
        id: "gpt-profile-b",
        label: "Secondary",
        health: {
          status: "cooldown",
          cooldown_until: new Date(Date.now() + 300000).toISOString(),
          failure_count: 3,
          reason: "rate_limit",
        },
      },
    ],
  };
  assert.ok(validate(instance), JSON.stringify(validate.errors, null, 2));
});

// --- proxy-pool.schema.json ---

test("proxy-pool: proxy with health and auth", () => {
  const validate = validators["proxy-pool.schema.json"];
  const instance = {
    contract_version: "1.0.0",
    provider: "gpt-web",
    proxies: [
      {
        id: "proxy-1",
        enabled: true,
        url: "http://proxy.example.com:8080",
        protocol: "http",
        host: "proxy.example.com",
        port: 8080,
        auth: { username: "user", password: "pass" },
        bound_account_ids: ["gpt-profile-a"],
        health: {
          score: 0.95,
          last_checked_at: new Date().toISOString(),
          failure_count: 1,
          status: "active",
        },
        geolocation: { country: "US", city: "New York" },
      },
    ],
  };
  assert.ok(validate(instance), JSON.stringify(validate.errors, null, 2));
});

test("proxy-pool: proxy without auth (null)", () => {
  const validate = validators["proxy-pool.schema.json"];
  const instance = {
    contract_version: "1.0.0",
    provider: "gpt-web",
    proxies: [
      {
        id: "proxy-2",
        host: "open.proxy.com",
        port: 3128,
        auth: null,
        health: { score: 0.8, status: "degraded" },
      },
    ],
  };
  assert.ok(validate(instance), JSON.stringify(validate.errors, null, 2));
});

// --- queue-state.schema.json ---

test("queue-state: profile-scoped serial queue with lease", () => {
  const validate = validators["queue-state.schema.json"];
  const instance = {
    contract_version: "1.0.0",
    provider: "gpt-web",
    queues: [
      {
        scope: "profile",
        scope_id: "gpt-web-default",
        mode: "profile-serial",
        enabled: true,
        depth: { pending: 2, running: 1, completed: 10, failed: 1 },
        capacity: { max_pending: 10, max_concurrent: 1 },
        leases: [
          {
            task_id: "imgtask_abc",
            profile_lock: "gpt-web-default",
            leased_by: "job-queue",
            leased_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 30000).toISOString(),
          },
        ],
        lock_policy: { scope: "profile", implementation: "Redis" },
      },
    ],
  };
  assert.ok(validate(instance), JSON.stringify(validate.errors, null, 2));
});

test("queue-state: upstream-managed global queue", () => {
  const validate = validators["queue-state.schema.json"];
  const instance = {
    contract_version: "1.0.0",
    provider: "canvas-to-api",
    queues: [
      {
        scope: "global",
        scope_id: "global",
        mode: "upstream-managed",
        depth: { pending: 5, running: 2, completed: 0, failed: 0 },
      },
    ],
  };
  assert.ok(validate(instance), JSON.stringify(validate.errors, null, 2));
});

// --- audit-event.schema.json ---

test("audit-event: provider_selection event", () => {
  const validate = validators["audit-event.schema.json"];
  const instance = {
    contract_version: "1.0.0",
    id: "audit_001",
    event_type: "provider_selection",
    actor: { type: "scheduler", id: "scheduler-1" },
    timestamp: new Date().toISOString(),
    provider: "gpt-web",
    account_id: "gpt-profile-a",
    success: true,
    metadata: { model: "gpt-image-2", route: "sub2api" },
  };
  assert.ok(validate(instance), JSON.stringify(validate.errors, null, 2));
});

test("audit-event: all event_type values accepted", () => {
  const validate = validators["audit-event.schema.json"];
  const base = {
    contract_version: "1.0.0",
    id: "audit_x",
    actor: { type: "system" },
    timestamp: new Date().toISOString(),
  };
  const types = [
    "admin_action", "provider_selection", "route_decision",
    "account_lease", "account_release", "proxy_binding",
    "proxy_failure", "task_submitted", "task_completed",
    "task_failed", "artifact_written", "health_check",
    "config_change", "unknown",
  ];
  for (const t of types) {
    assert.ok(
      validate({ ...base, event_type: t }),
      `event_type=${t} should pass`
    );
  }
});

test("audit-event: task_completed with duration and artifact_id", () => {
  const validate = validators["audit-event.schema.json"];
  const instance = {
    contract_version: "1.0.0",
    id: "audit_done",
    event_type: "task_completed",
    actor: { type: "worker", id: "gpt-web-1" },
    timestamp: new Date().toISOString(),
    provider: "gpt-web",
    task_id: "imgtask_xyz",
    artifact_id: "art_xyz",
    success: true,
    duration_ms: 12340,
  };
  assert.ok(validate(instance), JSON.stringify(validate.errors, null, 2));
});

// --- browser-worker-runtime.schema.json ---

test("browser-worker-runtime: extends runtime-health", () => {
  const validate = validators["browser-worker-runtime.schema.json"];
  const instance = {
    contract_version: "1.0.0",
    provider_id: "gpt-web",
    provider_id_canonical: "gpt-web",
    provider_id_legacy: "gpt-web",
    provider_family: "gpt-web",
    provider_aliases: ["gpt-web"],
    provider_type: "browser-session",
    checked_at: new Date().toISOString(),
    status: "ok",
    service_alive: true,
    logged_in: true,
    cdp_ready: true,
    browser_connected: true,
    queue: { supported: true, mode: "profile-serial", pending: 1, running: 1, locks_active: 1 },
    profiles: [
      {
        id: "gpt-web-default",
        label: "Default",
        logged_in: true,
        cdp_ready: true,
        browser_connected: true,
      },
    ],
  };
  assert.ok(validate(instance), JSON.stringify(validate.errors, null, 2));
});

// --- artifact-output.schema.json ---

test("artifact-output: minimal valid instance passes", () => {
  const validate = validators["artifact-output.schema.json"];
  const instance = {
    artifact_id: "art_abc",
    url: "/v1/artifacts/art_abc",
  };
  assert.ok(validate(instance), JSON.stringify(validate.errors, null, 2));
});

test("artifact-output: full valid instance passes", () => {
  const validate = validators["artifact-output.schema.json"];
  const instance = {
    artifact_id: "art_xyz",
    url: "http://127.0.0.1:4242/generated/xyz.png",
    mime: "image/png",
    width: 1024,
    height: 1024,
    sha256: "abc123def456",
  };
  assert.ok(validate(instance), JSON.stringify(validate.errors, null, 2));
});

// --- image-task + artifact-output $ref ---

test("image-task: outputs reference artifact-output schema", () => {
  const validate = validators["image-task.schema.json"];
  const instance = {
    contract_version: "1.0.0",
    id: "imgtask_ref",
    provider: "gpt-web",
    model: "gpt-image-2",
    status: "succeeded",
    prompt: "red cube",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    outputs: [
      {
        artifact_id: "art_ref1",
        url: "/v1/artifacts/art_ref1",
        mime: "image/png",
        width: 1024,
        height: 1024,
        sha256: "deadbeef",
      },
    ],
  };
  assert.ok(validate(instance), JSON.stringify(validate.errors, null, 2));
});

// --- artifact-record with width/height in metadata ---

test("artifact-record: width/height/sha256 in metadata from image-task output", () => {
  const validate = validators["artifact-record.schema.json"];
  // Simulate converting an image-task output to an artifact-record
  const taskOutput = {
    artifact_id: "art_conv",
    url: "http://127.0.0.1:4242/generated/conv.png",
    mime: "image/png",
    width: 512,
    height: 512,
    sha256: "feedface",
  };
  const task = {
    provider: "gpt-web",
    model: "gpt-image-2",
    prompt: "blue sphere",
    id: "imgtask_conv",
    account_id: "gpt-profile-a",
    profile_lock: "gpt-web-default",
    completed_at: new Date().toISOString(),
  };
  // Mapping per ARTIFACT_MAPPING.md
  const artifactRecord = {
    contract_version: "wcapi.artifact.v1",
    id: taskOutput.artifact_id,
    object: "artifact",
    provider: task.provider,
    kind: "image",
    model: task.model,
    prompt: task.prompt,
    mime_type: taskOutput.mime,
    created_at: Math.floor(new Date(task.completed_at).getTime() / 1000),
    local_path: `/tmp/${taskOutput.artifact_id}.png`,
    url: taskOutput.url,
    metadata: {
      width: taskOutput.width,
      height: taskOutput.height,
      sha256: taskOutput.sha256,
      job_id: task.id,
      provider_profile_id: task.account_id,
      provider_profile_label: task.profile_lock,
    },
  };
  assert.ok(validate(artifactRecord), JSON.stringify(validate.errors, null, 2));
});

test("artifact-record: metadata.width and metadata.height are optional integers", () => {
  const validate = validators["artifact-record.schema.json"];
  const instance = {
    contract_version: "wcapi.artifact.v1",
    id: "art_dims",
    object: "artifact",
    provider: "gpt-web",
    kind: "image",
    model: "gpt-image-2",
    created_at: 1713000000,
    local_path: "/tmp/dims.png",
    metadata: {
      width: 2048,
      height: 2048,
      sha256: "abcd1234",
    },
  };
  assert.ok(validate(instance), JSON.stringify(validate.errors, null, 2));
});
