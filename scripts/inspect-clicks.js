const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/project-detect/app/data/detect.sqlite');
const rows = db.prepare("SELECT device,status,error,report_status,captured_at FROM clicks ORDER BY id DESC LIMIT 15").all();
for (const r of rows) console.log(r.captured_at.slice(11,19), r.device, r.status, '|', r.error || '-', '|', r.report_status || '-');
