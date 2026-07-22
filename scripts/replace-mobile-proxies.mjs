/**
 * Replace proxies of the 36 mobile profiles whose IPs are NOT in the
 * proxy-seller order (orders.csv) with the order's unused IPs.
 * Usage: node scripts/replace-mobile-proxies.mjs [--apply]  (default: dry-run)
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "../dist/config.js";
import { AdsPowerClient } from "../dist/adspower/client.js";

const APPLY = process.argv.includes("--apply");
const csv = readFileSync("C:/Users/efsun/Downloads/orders.csv", "utf8")
  .split(/\r?\n/)
  .slice(1)
  .map((l) => l.split(",").map((s) => s.trim()))
  .filter((r) => r[0]);
const inList = new Set(csv.map((r) => r[0]));

const config = loadConfig();
const ads = new AdsPowerClient(config.adspower.baseUrl, config.adspower.apiKey, config.adspower.requestIntervalMs);
const all = await ads.listProfiles();
const pool = all.filter((p) => /^(TR-ISP-|TR-MOBILE-)/.test(p.name || ""));
const usedHosts = new Set(pool.map((p) => p.user_proxy_config?.proxy_host || ""));
const freeIps = csv.filter((r) => !usedHosts.has(r[0]));
const targets = pool.filter((p) => p.name.startsWith("TR-MOBILE-") && !inList.has(p.user_proxy_config?.proxy_host || ""));

console.log(`değişecek profil: ${targets.length} · boş IP: ${freeIps.length}`);
if (targets.length !== freeIps.length) {
  console.error("SAYI UYMUYOR — durdum.");
  process.exit(2);
}

for (let i = 0; i < targets.length; i++) {
  const p = targets[i];
  const [ip, port, user, pass] = freeIps[i];
  console.log(`${p.name}: ${p.user_proxy_config?.proxy_host || "—"} → ${ip}`);
  if (APPLY) {
    await ads.request("/api/v1/user/update", {
      method: "POST",
      body: {
        user_id: p.user_id,
        user_proxy_config: {
          proxy_soft: "other",
          proxy_type: "socks5",
          proxy_host: ip,
          proxy_port: port,
          proxy_user: user,
          proxy_password: pass,
          proxy_url: "",
        },
      },
    });
  }
}
console.log(APPLY ? "TAMAM — uygulandı." : "DRY-RUN (uygulamak için --apply)");
