export function parseHistory(input: string | undefined | null): number[] {
  if (!String(input || "").trim()) return [];

  return String(input)
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

    if (char === `"` && inQuotes && nextChar === `"`) {
      current += `"`;
      index += 1;
      continue;
    }

    if (char === `"`) {
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

export function parseCsvRows(text: string): Array<{ line: number; values: string[] }> {
  const rows = String(text || "")
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);

  if (rows.length <= 1) {
    return [];
  }

  return rows.slice(1).map((row, index) => ({
    line: index + 2,
    values: parseCsvLine(row),
  }));
}
