import { loadConfig } from "../dist/config.js";
import { AdsPowerClient, captchaProxyFromProfile } from "../dist/adspower/client.js";

// Isolation test: can 2captcha workers connect through the proxy-seller proxy?
const name = process.argv[2] || "TR-MOBILE-079";
const config = loadConfig();
const ads = new AdsPowerClient(config.adspower.baseUrl, config.adspower.apiKey, config.adspower.requestIntervalMs);
const all = await ads.listProfiles();
const p = all.find((x) => x.name === name);
const px = captchaProxyFromProfile(p);
const m = px.proxy.match(/^(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/);
const [, user, pass, host, port] = m;
const key = config.captcha.twoCaptchaApiKey;

const body = {
  clientKey: key,
  task: {
    type: "TurnstileTask",
    websiteURL: "https://2captcha.com/demo/cloudflare-turnstile",
    websiteKey: "3x00000000000000000000FF",
    proxyType: "socks5",
    proxyAddress: host,
    proxyPort: Number(port),
    proxyLogin: user,
    proxyPassword: pass,
  },
};
const res = await fetch("https://api.2captcha.com/createTask", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(30_000),
});
const created = await res.json();
console.log("createTask:", JSON.stringify(created).slice(0, 300));
if (created.taskId) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const r2 = await fetch("https://api.2captcha.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: key, taskId: created.taskId }),
      signal: AbortSignal.timeout(20_000),
    });
    const j = await r2.json();
    if (j.status !== "processing") {
      console.log("result:", JSON.stringify(j).slice(0, 300));
      break;
    }
    process.stdout.write(".");
  }
}
