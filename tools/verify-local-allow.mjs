import { allow, isOfficial, isLocal, setLocal, setAllow, getLocal } from "../mobile-filter.js";
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
// 复刻 index.js 的 listLocal()
const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const ids = new Set();
for (const dir of fs.readdirSync(path.join(home, "profiles"))) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(home, "profiles", dir, "package.json"), "utf8"));
    for (const [id, spec] of Object.entries(pkg.dependencies || {})) if (/^(link|file):/.test(String(spec))) ids.add(id);
  } catch {}
}
console.log("扫到的兼容插件:", JSON.stringify(setLocal([...ids])));
const compat = getLocal().filter((id) => id !== "dsh-mobile-studio");
let bad = 0;
const check = (id, want, why) => {
  const got = allow(id);
  if (got !== want) bad++;
  console.log((got === want ? "ok  " : "FAIL") + "  allow(" + id + ")=" + got + "  期望 " + want + "  (" + why + ")");
};
// 白名单语义：勾=放行，不勾=不下发。先清空，对谁都不勾 —— 只有官方和本体能过。
setAllow([]);
check("@deepseek-ai/dsh-client-ui-slots", true, "官方始终放行");
check("dsh-mobile-studio", true, "本体永远放行");
check("dsh-curator", false, "兼容插件也要勾选，不勾不下发");
check("dsh-opencode-go-server-error-retry", false, "兼容插件也要勾选，不勾不下发");
check("@modusensus/dsh-mneme", false, "第三方未点名");
check("dsh-pocket", false, "registry 装的，不算兼容");
// 勾上兼容插件 —— 这时才放行（对应页面上默认勾选的那批）。
setAllow(compat);
for (const id of compat) check(id, true, "已勾选就放行");
console.log(bad === 0 ? "ALL PASS" : bad + " FAILED");
if (bad !== 0) process.exit(1);
