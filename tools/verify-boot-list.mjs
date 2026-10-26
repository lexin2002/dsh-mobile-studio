import fs from "node:fs";
import { bootBounds } from "../mobile-filter.js";
const html = await (await fetch("http://127.0.0.1:3081/m")).text();
const b = bootBounds(html);
if (!b) { console.log("no boot"); process.exit(1); }
const boot = JSON.parse(html.slice(b.start, b.end));
const ids = new Set((boot.entries || []).map((e) => e && e.id).filter(Boolean));
for (const batch of boot.batches ?? []) for (const id of batch.entries || []) ids.add(id);
console.log("手机页实际会加载的插件:", [...ids].sort().join("\n  "));
for (const id of ["dsh-mobile-studio", "dsh-curator", "@modusensus/dsh-mneme"]) console.log(id, "->", ids.has(id) ? "在清单里" : "不在清单里");

