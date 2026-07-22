import { loadConfig } from "../dist/config.js";
import { AdsPowerClient } from "../dist/adspower/client.js";
import { Store } from "../dist/store/db.js";

const cfg = loadConfig();
const ads = new AdsPowerClient(cfg.adspower.baseUrl, cfg.adspower.apiKey, cfg.adspower.requestIntervalMs);
const list = await ads.listProfiles();

const p32 = list.find(
  (p) => p.serial_number === "32" || p.name === "TR-ISP-032" || (p.name || "").endsWith("-032")
);
console.log("profile32", p32 ? { id: p32.user_id, name: p32.name, serial: p32.serial_number } : "NOT FOUND");
if (p32) {
  try {
    await ads.stopBrowser(p32.user_id, true);
    console.log("STOPPED profile 32", p32.name, p32.user_id);
  } catch (e) {
    console.log("stop 32:", String(e).slice(0, 160));
  }
}

let closed = 0;
for (const p of list) {
  try {
    const a = await ads.browserActive(p.user_id);
    if (a?.status === "Active") {
      await ads.stopBrowser(p.user_id, true);
      closed++;
      console.log("closed", p.name, p.serial_number);
    }
  } catch {}
}
console.log("total closed active", closed);

// verify 32 inactive
if (p32) {
  const a = await ads.browserActive(p32.user_id).catch(() => null);
  console.log("32 status after", a?.status || "unknown");
}

const s = new Store(cfg.output.dir);
const r = s.db.prepare("UPDATE scans SET finished_at=?, notes=? WHERE finished_at IS NULL").run(
  new Date().toISOString(),
  "killed: user — start full desktop-50"
);
console.log("orphan scans closed", r.changes);
console.log("desktop count", list.filter((p) => (p.name || "").startsWith("TR-ISP-")).length);
s.close();
