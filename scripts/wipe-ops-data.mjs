/**
 * Wipe scan/click history + screenshots. Keeps ip_trust vault.
 * Usage: node scripts/wipe-ops-data.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dataDir = resolve(root, "data");
const dbPath = resolve(dataDir, "detect.sqlite");

function wipeDir(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      n += wipeDir(p);
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        /* */
      }
    } else {
      rmSync(p, { force: true });
      n += 1;
    }
  }
  return n;
}

if (!existsSync(dbPath)) {
  console.log("no db at", dbPath);
  process.exit(0);
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON;");

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
console.log("tables:", tables.join(", "));

const wipeOrder = ["hops", "results", "scans", "click_hops", "clicks", "click_runs"];
for (const t of wipeOrder) {
  if (!tables.includes(t)) continue;
  const before = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  db.prepare(`DELETE FROM ${t}`).run();
  // reset autoincrement
  try {
    db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(t);
  } catch {
    /* no sequence */
  }
  console.log(`wiped ${t}: ${before} rows`);
}

// keep ip_trust
if (tables.includes("ip_trust")) {
  const v = db.prepare("SELECT COUNT(*) AS c FROM ip_trust").get().c;
  console.log(`kept ip_trust: ${v} rows`);
}

db.close();

const shotN = wipeDir(resolve(dataDir, "screenshots"));
const debugN = wipeDir(resolve(dataDir, "debug-captcha"));
console.log(`deleted screenshots files: ${shotN}, debug-captcha: ${debugN}`);
console.log("done — ops history reset");
