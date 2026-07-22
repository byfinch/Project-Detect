import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ClickStore } from "./store.js";
import type { ClickRunSummary } from "./types.js";

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const escape = (v: unknown) => {
    const s = String(v ?? "");
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(","), ...rows.map((r) => headers.map((h) => escape(r[h])).join(","))];
  return lines.join("\n");
}

export function exportClickRun(store: ClickStore, runId: number, outputDir: string): ClickRunSummary["reportPaths"] {
  const run = store.getRun(runId);
  if (!run) throw new Error(`Click run #${runId} not found`);

  const clicks = store.clicksForRun(runId);
  const payload = { run, clicks };

  const jsonPath = resolve(outputDir, `click-run-${runId}.json`);
  const csvPath = resolve(outputDir, `click-run-${runId}.csv`);

  writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");
  writeFileSync(csvPath, toCsv(clicks), "utf8");

  return { json: jsonPath, csv: csvPath };
}
