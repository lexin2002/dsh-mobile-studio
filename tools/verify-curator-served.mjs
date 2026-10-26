import { bootBounds } from "../mobile-filter.js";
const html = await (await fetch("http://127.0.0.1:3081/m")).text();
const b = bootBounds(html);
const boot = JSON.parse(html.slice(b.start, b.end));
const urls = new Set();
for (const u of boot.preload ?? []) urls.add(u);
for (const batch of boot.batches ?? []) if (batch.url) urls.add(batch.url);
const list = [...urls];
const hit = list.filter((u) => /dsh-curator|plugin/i.test(u));
console.log("候选 URL 数:", list.length);
let found = 0, total = 0;
for (const u of list.slice(0, 40)) {
  try {
    const r = await fetch(new URL(u, "http://127.0.0.1:3081/").href);
    const t = await r.text();
    total += t.length;
    if (t.includes("box-shadow:0 -8px 32px rgb(0 0 0 / 20%)")) { found++; console.log("命中新代码:", u.slice(0, 90), t.length); }
  } catch (e) { /* skip */ }
}
console.log("扫描字节:", total, "命中:", found);


