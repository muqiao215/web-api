/**
 * packages/audit_log — JSONL audit logger aligned with audit-event.schema.json.
 *
 * Design: factory pattern. createAuditLogger({ dataDir }) returns a logger
 * with log(event) and list() methods. Appends one JSON line per event to
 * {dataDir}/audit.jsonl — append-friendly, no full-file rewrite.
 *
 * Validation: events are checked for required fields (id, event_type, actor,
 * timestamp) before logging. schema validation is available via
 * validateEvent() if ajv is available at runtime.
 *
 * Not todos:
 * - Does NOT rotate or truncate the audit file (caller manages rotation).
 * - Does NOT send events to external logging services.
 * - Does NOT enforce schema validation in production (optional opt-in).
 */

import fs from "node:fs";
import path from "node:path";

export const AUDIT_LOG_VERSION = "wcapi.audit-log.v1";
export const AUDIT_EVENT_TYPES = [
  "admin_action",
  "provider_selection",
  "route_decision",
  "account_lease",
  "account_release",
  "proxy_binding",
  "proxy_failure",
  "task_submitted",
  "task_completed",
  "task_failed",
  "artifact_written",
  "health_check",
  "config_change",
  "unknown",
];

export const ACTOR_TYPES = ["system", "admin", "bot", "user", "worker", "scheduler", "unknown"];

// ─── Event validation ─────────────────────────────────────────────────────

/**
 * Validate required fields of an audit event.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateEvent(event = {}) {
  const errors = [];
  if (!event.id) errors.push("id is required");
  if (!event.event_type) errors.push("event_type is required");
  else if (!AUDIT_EVENT_TYPES.includes(event.event_type)) errors.push(`unknown event_type: ${event.event_type}`);
  if (!event.actor || !event.actor.type) errors.push("actor.type is required");
  else if (!ACTOR_TYPES.includes(event.actor.type)) errors.push(`unknown actor.type: ${event.actor.type}`);
  if (!event.timestamp) errors.push("timestamp is required");
  return { valid: errors.length === 0, errors };
}

// ─── Logger factory ─────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.dataDir  — directory for audit.jsonl (created if missing)
 * @param {boolean} [opts.validate=true] — validate events before logging
 * @param {boolean} [opts.enrich=true] — auto-fill contract_version, timestamp, id if missing
 */
export function createAuditLogger({ dataDir, validate = true, enrich = true } = {}) {
  if (!dataDir) throw new Error("dataDir is required");

  const auditPath = path.join(dataDir, "audit.jsonl");

  // Ensure directory exists
  fs.mkdirSync(dataDir, { recursive: true });

  /**
   * Persist an audit event.
   * @param {object} partial  — partial event; required fields auto-filled if enrich=true
   * @returns {{ id: string, event: object }}  — the final enriched event that was written
   */
  function log(partial = {}) {
    if (validate) {
      // When enrich=false, validate the raw partial (id/event_type/actor must be present).
      // When enrich=true, auto-fill missing required fields before validation.
      const full = enrichEvent(partial, { enrich });
      const { valid, errors } = validateEvent(full);
      if (!valid) throw new Error(`Invalid audit event: ${errors.join("; ")}`);
      fs.appendFileSync(auditPath, JSON.stringify(full) + "\n");
      return { id: full.id, event: full };
    }

    const event = enrichEvent(partial, { enrich });
    fs.appendFileSync(auditPath, JSON.stringify(event) + "\n");
    return { id: event.id, event };
  }

  /**
   * Read all audit events from the file.
   * Returns [] if the file does not exist.
   * @returns {object[]}
   */
  function list() {
    if (!fs.existsSync(auditPath)) return [];
    const raw = fs.readFileSync(auditPath, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  }

  /**
   * Query events by filter.
   * @param {{ event_type?: string, actor_type?: string, since?: string, limit?: number }} opts
   * @returns {object[]}
   */
  function query({ event_type, actor_type, since, limit } = {}) {
    const all = list();
    let events = all;

    if (event_type) events = events.filter((e) => e.event_type === event_type);
    if (actor_type) events = events.filter((e) => e.actor?.type === actor_type);
    if (since) {
      const sinceDate = new Date(since);
      events = events.filter((e) => new Date(e.timestamp) >= sinceDate);
    }

    if (limit) events = events.slice(-limit);
    return events;
  }

  /**
   * Return audit file path.
   */
  function auditPath_() {
    return auditPath;
  }

  return { log, list, query, auditPath: auditPath_ };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function enrichEvent(event, { enrich = true } = {}) {
  const now = new Date().toISOString();
  if (!enrich) {
    // Return raw event with contract_version only — caller is responsible for filling required fields
    return { contract_version: AUDIT_LOG_VERSION, ...event };
  }
  return {
    contract_version: AUDIT_LOG_VERSION,
    id: event.id || `audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    event_type: event.event_type || "unknown",
    actor: event.actor
      ? { type: event.actor.type || "unknown", id: event.actor.id, label: event.actor.label }
      : { type: "system" },
    timestamp: event.timestamp || now,
    provider: event.provider ?? null,
    account_id: event.account_id ?? null,
    proxy_id: event.proxy_id ?? null,
    task_id: event.task_id ?? null,
    artifact_id: event.artifact_id ?? null,
    route: event.route ?? null,
    success: event.success ?? null,
    error: event.error ?? null,
    duration_ms: event.duration_ms ?? null,
    metadata: { ...event.metadata },
  };
}
