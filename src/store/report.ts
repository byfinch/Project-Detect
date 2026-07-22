import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Store } from "./db.js";

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvCell(row[h])).join(","));
  }
  return lines.join("\n");
}

export interface ReportPaths {
  json?: string;
  csv?: string;
}

/** Export a scan's results as JSON and/or CSV next to the SQLite DB. */
export function exportScan(
  store: Store,
  scanId: number,
  outputDir: string,
  opts: { json: boolean; csv: boolean }
): ReportPaths {
  const rows = store.resultsForScan(scanId);
  const stamp = `scan-${scanId}`;
  const paths: ReportPaths = {};

  if (opts.json) {
    const p = resolve(outputDir, `${stamp}.json`);
    writeFileSync(p, JSON.stringify(rows, null, 2), "utf8");
    paths.json = p;
  }
  if (opts.csv) {
    const p = resolve(outputDir, `${stamp}.csv`);
    writeFileSync(p, toCsv(rows), "utf8");
    paths.csv = p;
  }
  return paths;
}
