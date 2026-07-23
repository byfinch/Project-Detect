import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/opt/project-detect/app/data/detect.sqlite');

console.log('--- cihaz x durum dağılımı (tüm zamanlar) ---');
const rows = db.prepare("SELECT device, status, COUNT(*) c FROM clicks GROUP BY device, status ORDER BY device, c DESC").all();
for (const r of rows) console.log(r.device.padEnd(8), r.status.padEnd(9), r.c);

console.log('--- son 24 saat ---');
const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const recent = db.prepare("SELECT device, status, COUNT(*) c FROM clicks WHERE captured_at > ? GROUP BY device, status ORDER BY device, c DESC").all(since);
for (const r of recent) console.log(r.device.padEnd(8), r.status.padEnd(9), r.c);

console.log('--- skip sebepleri (ilk 5) ---');
const errs = db.prepare("SELECT error, COUNT(*) c FROM clicks WHERE status='skipped' GROUP BY error ORDER BY c DESC LIMIT 5").all();
for (const r of errs) console.log(String(r.c).padEnd(6), (r.error || '-').slice(0, 90));
