import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentEngineInfo,
  AgentJobEventRecord,
  AgentJobEventType,
  AgentJobRecord,
  AgentJobStatus,
  AgentRunRecord,
  AgentStage,
} from "../types/domain.js";
import { createId, formatDate } from "../utils/energy.js";

type SqlRow = Record<string, unknown>;

const runtimeDbFile = new URL("../../data/agent-runtime.db", import.meta.url);
const runtimeDbPath = runtimeDbFile.pathname;
const runtimeDbDir = path.dirname(runtimeDbPath);

fs.mkdirSync(runtimeDbDir, { recursive: true });

const runtimeDb = new DatabaseSync(runtimeDbPath);

runtimeDb.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS agent_jobs (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    operator TEXT NOT NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL,
    workflow_json TEXT NOT NULL,
    current_stage TEXT NOT NULL,
    latest_message TEXT NOT NULL,
    engine_json TEXT,
    started_at TEXT NOT NULL,
    started_at_iso TEXT NOT NULL,
    finished_at TEXT,
    finished_at_iso TEXT,
    error_message TEXT,
    result_json TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_job_events (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    stage TEXT NOT NULL,
    agent_name TEXT,
    message TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT NOT NULL,
    created_at_iso TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_agent_jobs_started_at_iso
  ON agent_jobs(started_at_iso DESC);

  CREATE INDEX IF NOT EXISTS idx_agent_job_events_job_time
  ON agent_job_events(job_id, created_at_iso DESC);
`);

function finalizeStaleRunningJobs(): void {
  const finishedAtISO = new Date().toISOString();
  const finishedAt = formatDate();
  const message = "服务已重新启动，上一轮未完成的智能体作业已终止。";

  runtimeDb
    .prepare(
      `
        UPDATE agent_jobs
        SET
          status = 'failed',
          current_stage = 'failed',
          latest_message = ?,
          finished_at = ?,
          finished_at_iso = ?,
          error_message = ?
        WHERE status = 'running'
      `,
    )
    .run(message, finishedAt, finishedAtISO, message);
}

finalizeStaleRunningJobs();

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) return fallback;

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function mapEvent(row: SqlRow): AgentJobEventRecord {
  return {
    id: asString(row.id),
    jobId: asString(row.job_id),
    eventType: asString(row.event_type, "status") as AgentJobEventType,
    stage: asString(row.stage, "boot") as AgentStage,
    agentName: asNullableString(row.agent_name),
    message: asString(row.message),
    payload: parseJson<Record<string, unknown> | null>(row.payload_json, null),
    createdAt: asString(row.created_at),
    createdAtISO: asString(row.created_at_iso),
  };
}

function loadEvents(jobId: string, limit = 8): AgentJobEventRecord[] {
  const rows = runtimeDb
    .prepare(
      `
        SELECT id, job_id, event_type, stage, agent_name, message, payload_json, created_at, created_at_iso
        FROM agent_job_events
        WHERE job_id = ?
        ORDER BY created_at_iso DESC, rowid DESC
        LIMIT ?
      `,
    )
    .all(jobId, limit) as SqlRow[];

  return rows.reverse().map((row) => mapEvent(row));
}

function mapJob(row: SqlRow, eventsLimit = 8): AgentJobRecord {
  return {
    id: asString(row.id),
    runId: asNullableString(row.run_id),
    operator: asString(row.operator),
    goal: asString(row.goal),
    status: asString(row.status, "running") as AgentJobStatus,
    workflow: parseJson<string[]>(row.workflow_json, []),
    currentStage: asString(row.current_stage, "boot") as AgentStage,
    latestMessage: asString(row.latest_message),
    engine: parseJson<AgentEngineInfo | undefined>(row.engine_json, undefined),
    startedAt: asString(row.started_at),
    startedAtISO: asString(row.started_at_iso),
    finishedAt: asNullableString(row.finished_at),
    finishedAtISO: asNullableString(row.finished_at_iso),
    errorMessage: asNullableString(row.error_message),
    events: loadEvents(asString(row.id), eventsLimit),
  };
}

function getJobRow(jobId: string): SqlRow | undefined {
  return runtimeDb
    .prepare(
      `
        SELECT
          id,
          run_id,
          operator,
          goal,
          status,
          workflow_json,
          current_stage,
          latest_message,
          engine_json,
          started_at,
          started_at_iso,
          finished_at,
          finished_at_iso,
          error_message
        FROM agent_jobs
        WHERE id = ?
      `,
    )
    .get(jobId) as SqlRow | undefined;
}

function updateJobStage(jobId: string, stage: AgentStage, latestMessage: string): void {
  runtimeDb
    .prepare(
      `
        UPDATE agent_jobs
        SET current_stage = ?, latest_message = ?
        WHERE id = ?
      `,
    )
    .run(stage, latestMessage, jobId);
}

export function createAgentJob(input: {
  operator: string;
  goal: string;
  workflow?: string[];
  engine?: AgentEngineInfo;
}): AgentJobRecord {
  const startedAtISO = new Date().toISOString();
  const startedAt = formatDate();
  const workflow = input.workflow ?? ["planner", "reviewer"];
  const latestMessage = "智能体作业已创建，等待开始分析。";
  const jobId = createId();

  runtimeDb
    .prepare(
      `
        INSERT INTO agent_jobs (
          id,
          run_id,
          operator,
          goal,
          status,
          workflow_json,
          current_stage,
          latest_message,
          engine_json,
          started_at,
          started_at_iso,
          finished_at,
          finished_at_iso,
          error_message,
          result_json
        )
        VALUES (?, NULL, ?, ?, 'running', ?, 'boot', ?, ?, ?, ?, NULL, NULL, NULL, NULL)
      `,
    )
    .run(
      jobId,
      input.operator,
      input.goal,
      JSON.stringify(workflow),
      latestMessage,
      input.engine ? JSON.stringify(input.engine) : null,
      startedAt,
      startedAtISO,
    );

  return getAgentJobById(jobId) as AgentJobRecord;
}

export function appendAgentJobEvent(input: {
  jobId: string;
  eventType: AgentJobEventType;
  stage: AgentStage;
  agentName?: string | null;
  message: string;
  payload?: Record<string, unknown> | null;
}): AgentJobEventRecord {
  const createdAtISO = new Date().toISOString();
  const createdAt = formatDate();
  const event: AgentJobEventRecord = {
    id: createId(),
    jobId: input.jobId,
    eventType: input.eventType,
    stage: input.stage,
    agentName: input.agentName ?? null,
    message: input.message,
    payload: input.payload ?? null,
    createdAt,
    createdAtISO,
  };

  runtimeDb
    .prepare(
      `
        INSERT INTO agent_job_events (
          id,
          job_id,
          event_type,
          stage,
          agent_name,
          message,
          payload_json,
          created_at,
          created_at_iso
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      event.id,
      event.jobId,
      event.eventType,
      event.stage,
      event.agentName,
      event.message,
      event.payload ? JSON.stringify(event.payload) : null,
      event.createdAt,
      event.createdAtISO,
    );

  updateJobStage(input.jobId, input.stage, input.message);
  return event;
}

export function markAgentJobPlanned(jobId: string, run: AgentRunRecord): AgentJobRecord | null {
  const finishedAtISO = new Date().toISOString();
  const finishedAt = formatDate();
  const latestMessage = `计划已生成，共 ${run.plan.selectedCount} 个动作，当前门控 ${run.gate.mode === "manual" ? "人工审批" : "自动放行"}。`;

  runtimeDb
    .prepare(
      `
        UPDATE agent_jobs
        SET
          run_id = ?,
          status = 'planned',
          current_stage = 'completed',
          latest_message = ?,
          engine_json = ?,
          finished_at = ?,
          finished_at_iso = ?,
          error_message = NULL,
          result_json = ?
        WHERE id = ?
      `,
    )
    .run(
      run.id,
      latestMessage,
      run.engine ? JSON.stringify(run.engine) : null,
      finishedAt,
      finishedAtISO,
      JSON.stringify({
        runId: run.id,
        selectedCount: run.plan.selectedCount,
        riskLevel: run.simulation.risk.level,
        gateMode: run.gate.mode,
      }),
      jobId,
    );

  return getAgentJobById(jobId);
}

export function markAgentJobExecuted(jobId: string, run: AgentRunRecord): AgentJobRecord | null {
  const finishedAtISO = new Date().toISOString();
  const finishedAt = formatDate();
  const executedCount = run.execution?.applied.length ?? 0;
  const totalImpact = run.execution?.totalImpact ?? 0;
  const latestMessage = `计划已执行 ${executedCount} 项，累计节能影响 ${totalImpact.toFixed(1)}。`;

  runtimeDb
    .prepare(
      `
        UPDATE agent_jobs
        SET
          status = 'executed',
          current_stage = 'execution',
          latest_message = ?,
          engine_json = ?,
          finished_at = ?,
          finished_at_iso = ?,
          result_json = ?
        WHERE id = ?
      `,
    )
    .run(
      latestMessage,
      run.engine ? JSON.stringify(run.engine) : null,
      finishedAt,
      finishedAtISO,
      JSON.stringify({
        runId: run.id,
        executedCount,
        totalImpact: Number(totalImpact.toFixed(1)),
      }),
      jobId,
    );

  return getAgentJobById(jobId);
}

export function markAgentJobSkipped(jobId: string, message: string, details?: Record<string, unknown>): AgentJobRecord | null {
  const finishedAtISO = new Date().toISOString();
  const finishedAt = formatDate();

  runtimeDb
    .prepare(
      `
        UPDATE agent_jobs
        SET
          status = 'skipped',
          current_stage = 'completed',
          latest_message = ?,
          finished_at = ?,
          finished_at_iso = ?,
          error_message = NULL,
          result_json = ?
        WHERE id = ?
      `,
    )
    .run(message, finishedAt, finishedAtISO, JSON.stringify(details ?? { message }), jobId);

  return getAgentJobById(jobId);
}

export function failAgentJob(jobId: string, message: string): AgentJobRecord | null {
  const finishedAtISO = new Date().toISOString();
  const finishedAt = formatDate();

  runtimeDb
    .prepare(
      `
        UPDATE agent_jobs
        SET
          status = 'failed',
          current_stage = 'failed',
          latest_message = ?,
          finished_at = ?,
          finished_at_iso = ?,
          error_message = ?
        WHERE id = ?
      `,
    )
    .run(message, finishedAt, finishedAtISO, message, jobId);

  return getAgentJobById(jobId);
}

export function getAgentJobById(jobId: string, eventsLimit = 8): AgentJobRecord | null {
  const row = getJobRow(jobId);
  return row ? mapJob(row, eventsLimit) : null;
}

export function listAgentJobs(limit = 20, eventsLimit = 6): AgentJobRecord[] {
  const rows = runtimeDb
    .prepare(
      `
        SELECT
          id,
          run_id,
          operator,
          goal,
          status,
          workflow_json,
          current_stage,
          latest_message,
          engine_json,
          started_at,
          started_at_iso,
          finished_at,
          finished_at_iso,
          error_message
        FROM agent_jobs
        ORDER BY started_at_iso DESC
        LIMIT ?
      `,
    )
    .all(limit) as SqlRow[];

  return rows.map((row) => mapJob(row, eventsLimit));
}
