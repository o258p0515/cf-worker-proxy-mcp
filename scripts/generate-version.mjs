import { writeFile, appendFile } from "node:fs/promises";
const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
const version = `v.${p.year}.${p.month}${p.day}.${p.hour}${p.minute}`;
await writeFile(new URL("../src/version.ts", import.meta.url), `// Generated for this build in Asia/Ho_Chi_Minh. Do not edit.\nexport const MCP_VERSION = ${JSON.stringify(version)};\n`);
if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `MCP_VERSION=${version}\n`);
console.log(`Build version: ${version} (Asia/Ho_Chi_Minh)`);
