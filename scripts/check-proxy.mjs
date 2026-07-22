import { loadConfig } from "../dist/config.js";
import { AdsPowerClient, captchaProxyFromProfile } from "../dist/adspower/client.js";
import { execSync } from "node:child_process";

const name = process.argv[2] || "TR-MOBILE-079";
const config = loadConfig();
const ads = new AdsPowerClient(config.adspower.baseUrl, config.adspower.apiKey, config.adspower.requestIntervalMs);
const all = await ads.listProfiles();
const p = all.find((x) => x.name === name);
const px = captchaProxyFromProfile(p);
if (!px) { console.log("no proxy config"); process.exit(0); }
const m = px.proxy.match(/^(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/);
const [, user, pass, host, port] = m;
console.log("type:", px.proxytype, "| host:", host, "| port:", port, "| user:", user ? user.slice(0, 3) + "***" : "yok", "| pass:", pass ? pass.length + " kr" : "yok");
const scheme = px.proxytype === "SOCKS5" ? "socks5h" : px.proxytype.toLowerCase();
try {
  const out = execSync(`curl -s --max-time 20 -x "${scheme}://${px.proxy}" https://api.ipify.org`, { encoding: "utf8" });
  console.log("proxy OK, exit IP:", out.trim());
} catch (e) {
  console.log("proxy curl FAIL:", String(e.message).slice(0, 200));
}
