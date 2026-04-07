import type { InterfaceRecord } from "../types";

export function parseHistory(input: string): number[] {
  if (!input.trim()) return [];

  return input
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
}

export function parseCsvLine(row: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    const nextChar = row[index + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current);
  return result;
}

export function parseCsvRows(text: string, createId: () => string): InterfaceRecord[] {
  const rows = text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);

  if (rows.length <= 1) return [];

  return rows.slice(1).map((row) => {
    const [name, ip, mask, usage, history, connections] = parseCsvLine(row);

    return {
      id: createId(),
      name: name?.trim(),
      ip: ip?.trim(),
      mask: mask?.trim(),
      usage: Number(usage?.trim()),
      history: parseHistory(history || ""),
      connections: Number(connections?.trim()),
      applied: false,
    };
  });
}
