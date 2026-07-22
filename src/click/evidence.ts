import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright-core";

export interface EvidencePaths {
  serp: string;
  landing: string;
  final: string;
}

function safeName(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "_").slice(0, 60) || "kw";
}

export function ensureEvidenceDir(baseDir: string, runId: number): string {
  const dir = resolve(baseDir, "screenshots", `click-run-${runId}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function screenshotPage(page: Page, path: string): Promise<string | null> {
  const { screenshotWithoutScrollbar } = await import("../browser/screenshot.js");
  return screenshotWithoutScrollbar(page, path, { fullPage: true });
}

export function buildEvidencePaths(
  dir: string,
  jobId: string,
  device: string,
  keyword: string
): { paths: EvidencePaths; baseName: string } {
  const baseName = `${device}-${safeName(keyword)}-${jobId.slice(0, 8)}`;
  // Internal evidence is JPEG (5-10x smaller than PNG, faster encode).
  return {
    paths: {
      serp: resolve(dir, `serp-${baseName}.jpg`),
      landing: resolve(dir, `landing-${baseName}.jpg`),
      final: resolve(dir, `final-${baseName}.jpg`),
    },
    baseName,
  };
}

