import { loadConfig } from "../dist/config.js";
import { AdsPowerClient, captchaProxyFromProfile } from "../dist/adspower/client.js";

const name = process.argv[2] || "TR-MOBILE-079";
const url = process.argv[3] || "https://k56thc2itt.com/";
const config = loadConfig();
const ads = new AdsPowerClient(config.adspower.baseUrl, config.adspower.apiKey, config.adspower.requestIntervalMs);
const all = await ads.listProfiles();
const p = all.find((x) => x.name === name);
const px = captchaProxyFromProfile(p);
const m = px.proxy.match(/^(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/);
const [, user, pass, host, port] = m;
const capKey = config.captcha.capSolverApiKey;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

for (const type of ["socks5", "http"]) {
  const proxyStr = `${type}:${host}:${port}:${user}:${pass}`;
  console.log(`--- trying proxytype=${type}`);
  const task = { type: "AntiCloudflareTask", websiteURL: url, proxy: proxyStr, userAgent: UA };
  const createRes = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: capKey, task }),
    signal: AbortSignal.timeout(30_000),
  });
  const created = await createRes.json();
  console.log("createTask:", JSON.stringify(created).slice(0, 200));
  if (!created.taskId) continue;
  // poll briefly
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const res = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: capKey, taskId: created.taskId }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = await res.json();
    if (json.errorId || json.status !== "processing") {
      console.log("result:", JSON.stringify(json).slice(0, 300));
      break;
    }
    process.stdout.write(".");
  }
}
