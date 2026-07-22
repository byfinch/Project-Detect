/**
 * Gradual email pool refill: 25 accounts per batch, 60s between batches.
 * Usage: node scripts/refill-email-pool.mjs [targetSize]
 */
import { getEmailPool } from "../dist/report/emailPool.js";

const TARGET = Number(process.argv[2] || 250);
const BATCH = 25;
const GAP_MS = 60_000;

const pool = getEmailPool("data");
let stats = pool.stats();
console.log(`start: ${JSON.stringify(stats)} → hedef ${TARGET}`);

while (stats.active < TARGET) {
  const next = Math.min(TARGET, stats.active + BATCH);
  const r = await pool.refill(next);
  stats = pool.stats();
  console.log(`batch → hedef ${next}: +${r.created} (fail ${r.failed}) · aktif ${stats.active}/${TARGET}`);
  if (stats.active >= TARGET) break;
  if (r.created === 0 && r.failed > 0) {
    console.log("üretim durdu (429/limit?) — 5dk bekleyip devam");
    await new Promise((r2) => setTimeout(r2, 300_000));
  } else {
    await new Promise((r2) => setTimeout(r2, GAP_MS));
  }
}
console.log(`done: ${JSON.stringify(pool.stats())}`);
