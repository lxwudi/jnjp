import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
  AdviceRecord,
  AutonomyConfig,
  AgentProviderConfig,
  AgentRunRecord,
  AuditRecord,
  ExecutionRecord,
  InterfaceRecord,
  SnmpConfig,
  StateShape,
} from "../types/domain.js";
import { createId } from "../utils/energy.js";

type SqlRow = Record<string, unknown>;

const databaseFile = new URL("../../data/console.db", import.meta.url);
const databasePath = fileURLToPath(databaseFile);
const databaseDir = path.dirname(databasePath);

fs.mkdirSync(databaseDir, { recursive: true });

const database = new DatabaseSync(databasePath);
const LEGACY_DAYTIME_SCHEDULE = "07:30 - 22:00";
const LEGACY_NIGHT_SCHEDULE = "22:00 - 07:30";
const DEFAULT_ALWAYS_ON_SCHEDULE = "00:00 - 23:59";

database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS interfaces (
    id TEXT PRIMARY KEY,
    sort_index INTEGER NOT NULL,
    name TEXT NOT NULL,
    ip TEXT NOT NULL,
    mask TEXT NOT NULL,
    usage REAL NOT NULL,
    history_json TEXT NOT NULL,
    connections INTEGER NOT NULL,
    applied INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS advice (
    id TEXT PRIMARY KEY,
    sort_index INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    sort_index INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS execution_records (
    id TEXT PRIMARY KEY,
    sort_index INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    sort_index INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_interfaces_sort_index
  ON interfaces(sort_index ASC);
`);

function buildSeedInterfaces(): InterfaceRecord[] {
  return [
    {
      id: createId(),
      name: "GE1/0/03",
      ip: "10.10.1.13",
      mask: "255.255.255.0",
      usage: 6,
      history: [7, 6, 6, 5, 6],
      connections: 0,
      applied: false,
    },
    {
      id: createId(),
      name: "GE1/0/07",
      ip: "10.10.1.17",
      mask: "255.255.255.0",
      usage: 14,
      history: [15, 14, 13, 12, 14],
      connections: 1,
      applied: false,
    },
    {
      id: createId(),
      name: "GE1/0/12",
      ip: "10.10.1.22",
      mask: "255.255.255.0",
      usage: 4,
      history: [5, 4, 4, 3, 4],
      connections: 0,
      applied: false,
    },
    {
      id: createId(),
      name: "GE1/0/18",
      ip: "10.10.1.28",
      mask: "255.255.255.0",
      usage: 27,
      history: [24, 26, 29, 28, 27],
      connections: 4,
      applied: false,
    },
    {
      id: createId(),
      name: "GE1/0/21",
      ip: "10.10.1.31",
      mask: "255.255.255.0",
      usage: 11,
      history: [10, 11, 12, 10, 11],
      connections: 2,
      applied: false,
    },
    {
      id: createId(),
      name: "GE1/0/24",
      ip: "10.10.1.34",
      mask: "255.255.255.0",
      usage: 38,
      history: [36, 39, 41, 37, 38],
      connections: 7,
      applied: false,
    },
  ];
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) return fallback;

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseHistory(value: unknown): number[] {
  return parseJson<number[]>(value, []).map((item) => Number(item)).filter((item) => Number.isFinite(item));
}

function normalizeSnmpConfig(config: SnmpConfig, fallback: SnmpConfig): SnmpConfig {
  const schedule = String(config.schedule || fallback.schedule || "").trim();
  return {
    ...fallback,
    ...config,
    schedule:
      schedule === LEGACY_DAYTIME_SCHEDULE || schedule === LEGACY_NIGHT_SCHEDULE
        ? DEFAULT_ALWAYS_ON_SCHEDULE
        : schedule || fallback.schedule,
  };
}

function countRows(tableName: "interfaces" | "app_settings" | "advice" | "audit_logs" | "execution_records" | "agent_runs"): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as SqlRow | undefined;
  return Math.max(0, Math.trunc(asNumber(row?.count)));
}

function listInterfaceRows(): SqlRow[] {
  return database
    .prepare(
      `
        SELECT id, sort_index, name, ip, mask, usage, history_json, connections, applied
        FROM interfaces
        ORDER BY sort_index ASC
      `,
    )
    .all() as SqlRow[];
}

function mapInterfaceRow(row: SqlRow): InterfaceRecord {
  return {
    id: asString(row.id),
    name: asString(row.name),
    ip: asString(row.ip),
    mask: asString(row.mask),
    usage: asNumber(row.usage),
    history: parseHistory(row.history_json),
    connections: Math.max(0, Math.trunc(asNumber(row.connections))),
    applied: Boolean(row.applied),
  };
}

function replaceInterfaces(records: InterfaceRecord[]): void {
  const deleteStatement = database.prepare("DELETE FROM interfaces");
  const insertStatement = database.prepare(`
    INSERT INTO interfaces (
      id,
      sort_index,
      name,
      ip,
      mask,
      usage,
      history_json,
      connections,
      applied
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  database.exec("BEGIN");
  try {
    deleteStatement.run();
    records.forEach((record, index) => {
      insertStatement.run(
        record.id,
        index,
        record.name,
        record.ip,
        record.mask,
        record.usage,
        JSON.stringify(record.history),
        record.connections,
        record.applied ? 1 : 0,
      );
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function loadJsonRows<T>(tableName: "advice" | "audit_logs" | "execution_records" | "agent_runs"): T[] {
  const rows = database
    .prepare(
      `
        SELECT payload_json
        FROM ${tableName}
        ORDER BY sort_index ASC
      `,
    )
    .all() as SqlRow[];

  return rows.map((row) => parseJson<T>(row.payload_json, {} as T));
}

function replaceJsonRows<T extends { id: string }>(
  tableName: "advice" | "audit_logs" | "execution_records" | "agent_runs",
  items: T[],
): void {
  const deleteStatement = database.prepare(`DELETE FROM ${tableName}`);
  const insertStatement = database.prepare(
    `
      INSERT INTO ${tableName} (
        id,
        sort_index,
        payload_json
      ) VALUES (?, ?, ?)
    `,
  );

  database.exec("BEGIN");
  try {
    deleteStatement.run();
    items.forEach((item, index) => {
      insertStatement.run(item.id, index, JSON.stringify(item));
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function saveSetting<T>(key: string, value: T): void {
  database
    .prepare(
      `
        INSERT INTO app_settings (key, value_json)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
      `,
    )
    .run(key, JSON.stringify(value));
}

function deleteSetting(key: string): void {
  database.prepare("DELETE FROM app_settings WHERE key = ?").run(key);
}

function hasSetting(key: string): boolean {
  const row = database.prepare("SELECT 1 AS matched FROM app_settings WHERE key = ?").get(key) as SqlRow | undefined;
  return Boolean(row?.matched);
}

function loadSetting<T>(key: string, fallback: T): T {
  const row = database.prepare("SELECT value_json FROM app_settings WHERE key = ?").get(key) as SqlRow | undefined;
  return row ? parseJson<T>(row.value_json, fallback) : fallback;
}

type AppSettingLease = {
  owner: string;
  expiresAt: string;
  updatedAt: string;
};

type AppSettingLeaseSnapshot = {
  acquired: boolean;
  owner: string | null;
  expiresAt: string | null;
};

function loadLeaseSetting(key: string): AppSettingLease | null {
  const row = database.prepare("SELECT value_json FROM app_settings WHERE key = ?").get(key) as SqlRow | undefined;
  if (!row) return null;
  const parsed = parseJson<Partial<AppSettingLease> | null>(row.value_json, null);
  if (!parsed || typeof parsed !== "object") return null;

  const owner = asString(parsed.owner);
  const expiresAt = asString(parsed.expiresAt);
  const updatedAt = asString(parsed.updatedAt);

  if (!owner || !expiresAt) return null;

  return {
    owner,
    expiresAt,
    updatedAt,
  };
}

export function tryAcquireAppSettingLease(input: {
  key: string;
  owner: string;
  ttlMs: number;
  now?: Date;
}): AppSettingLeaseSnapshot {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + Math.max(15_000, input.ttlMs)).toISOString();

  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = loadLeaseSetting(input.key);
    const expiresAtMs = existing ? Date.parse(existing.expiresAt) : Number.NaN;
    const expired = !existing || !Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime();

    if (expired || existing.owner === input.owner) {
      saveSetting(input.key, {
        owner: input.owner,
        expiresAt,
        updatedAt: nowIso,
      });
      database.exec("COMMIT");
      return {
        acquired: true,
        owner: input.owner,
        expiresAt,
      };
    }

    database.exec("ROLLBACK");
    return {
      acquired: false,
      owner: existing.owner,
      expiresAt: existing.expiresAt,
    };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Ignore rollback failures after a failed transaction.
    }
    throw error;
  }
}

export function releaseAppSettingLease(key: string, owner: string): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = loadLeaseSetting(key);
    if (existing?.owner === owner) {
      deleteSetting(key);
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Ignore rollback failures after a failed transaction.
    }
    throw error;
  }
}

function loadSettingWithFallbacks<T>(key: string, fallback: T, legacyKeys: string[] = []): T {
  const primary = database.prepare("SELECT value_json FROM app_settings WHERE key = ?").get(key) as SqlRow | undefined;
  if (primary) {
    return parseJson<T>(primary.value_json, fallback);
  }

  for (const legacyKey of legacyKeys) {
    const legacy = database.prepare("SELECT value_json FROM app_settings WHERE key = ?").get(legacyKey) as SqlRow | undefined;
    if (legacy) {
      return parseJson<T>(legacy.value_json, fallback);
    }
  }

  return fallback;
}

function seedSettings(
  seed: Pick<
    StateShape,
    "manualThreshold" | "idleDuration" | "guardrailsEnabled" | "autonomyConfig" | "agentProviderConfig" | "snmpConfig"
  >,
): void {
  saveSetting("manualThreshold", seed.manualThreshold);
  saveSetting("idleDuration", seed.idleDuration);
  saveSetting("guardrailsEnabled", seed.guardrailsEnabled);
  saveSetting("autonomyConfig", seed.autonomyConfig);
  saveSetting("agentProviderConfig", seed.agentProviderConfig);
  saveSetting("snmpConfig", seed.snmpConfig);
  deleteSetting("automationActive");
}

function buildInitialState(seed: StateShape): StateShape {
  return {
    ...seed,
    interfaces: seed.interfaces.length ? seed.interfaces : buildSeedInterfaces(),
  };
}

function loadStateFromDatabase(seed: StateShape): StateShape {
  const loadedSnmpConfig = normalizeSnmpConfig(loadSetting<SnmpConfig>("snmpConfig", seed.snmpConfig), seed.snmpConfig);
  return {
    interfaces: listInterfaceRows().map((row) => mapInterfaceRow(row)),
    advice: loadJsonRows<AdviceRecord>("advice"),
    auditLogs: loadJsonRows<AuditRecord>("audit_logs"),
    executionRecords: loadJsonRows<ExecutionRecord>("execution_records"),
    agentRuns: loadJsonRows<AgentRunRecord>("agent_runs"),
    manualThreshold: Number(loadSetting("manualThreshold", seed.manualThreshold)),
    idleDuration: Number(loadSetting("idleDuration", seed.idleDuration)),
    guardrailsEnabled: Boolean(
      loadSettingWithFallbacks("guardrailsEnabled", seed.guardrailsEnabled, ["automationActive"]),
    ),
    autonomyConfig: loadSetting<AutonomyConfig>("autonomyConfig", seed.autonomyConfig),
    agentProviderConfig: loadSetting<AgentProviderConfig>("agentProviderConfig", seed.agentProviderConfig),
    snmpConfig: loadedSnmpConfig,
  };
}

export function initializeConsoleState(seed: StateShape): StateShape {
  const initial = buildInitialState(seed);
  const hasAutonomySetting = hasSetting("autonomyConfig");

  if (countRows("interfaces") === 0) {
    replaceInterfaces(initial.interfaces);
  }
  if (countRows("app_settings") === 0) {
    seedSettings(initial);
  }
  if (countRows("advice") === 0 && initial.advice.length > 0) {
    replaceJsonRows("advice", initial.advice);
  }
  if (countRows("audit_logs") === 0 && initial.auditLogs.length > 0) {
    replaceJsonRows("audit_logs", initial.auditLogs);
  }
  if (countRows("execution_records") === 0 && initial.executionRecords.length > 0) {
    replaceJsonRows("execution_records", initial.executionRecords);
  }
  if (countRows("agent_runs") === 0 && initial.agentRuns.length > 0) {
    replaceJsonRows("agent_runs", initial.agentRuns);
  }

  const loaded = loadStateFromDatabase(initial);
  if (!hasAutonomySetting && !loaded.guardrailsEnabled) {
    loaded.guardrailsEnabled = true;
  }
  saveSetting("guardrailsEnabled", loaded.guardrailsEnabled);
  saveSetting("autonomyConfig", loaded.autonomyConfig);
  saveSetting("agentProviderConfig", loaded.agentProviderConfig);
  saveSetting("snmpConfig", loaded.snmpConfig);
  deleteSetting("automationActive");
  return loaded;
}

export function persistConsoleState(state: StateShape): void {
  replaceInterfaces(state.interfaces);
  seedSettings(state);
  replaceJsonRows("advice", state.advice);
  replaceJsonRows("audit_logs", state.auditLogs);
  replaceJsonRows("execution_records", state.executionRecords);
  replaceJsonRows("agent_runs", state.agentRuns);
}
