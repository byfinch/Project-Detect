import { cpSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const src = resolve(process.cwd(), "src", "web", "public");
const dest = resolve(process.cwd(), "dist", "web", "public");

if (!existsSync(src)) {
  console.error("Source web assets not found:", src);
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true, force: true });
console.log("Web assets copied to", dest);
