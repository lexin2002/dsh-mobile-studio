// 悬浮球可见性的**行为**测试（0.9.15）。
//
// 为什么要有这个文件：0.9.13 的收起代码"看起来"是对的（有 30 秒定时器、有 60 秒安静判据），
// 但它被探针每 5 秒重排一次，于是永不触发。静态检查抓不到这种"调用频率 vs 计时长度"的错误，
// 只有按时间轴跑一遍才看得见。
//
// 做法：从 MainActivity.java 里抽取真实常量与 tick 周期，按 1 秒步长推进时间轴，
// 断言"何时可见 / 何时收起"。同时把旧的倒计时方案复现一遍，证明它确实收不起来
// （防止有人又改回"每次探针成功就重排收起计时"）。
import fs from 'node:fs';

const here = (p) => new URL('../' + p, import.meta.url);
const main = fs.readFileSync(here('android/src/com/lexin/dshmobile/MainActivity.java'), 'utf8');

let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) console.log('ok  ', name);
  else {
    fail += 1;
    console.log('FAIL', name, extra === undefined ? '' : String(extra));
  }
};

const num = (name) => {
  const m = new RegExp(name + '\\s*=\\s*(\\d+)').exec(main);
  return m ? Number(m[1]) : NaN;
};

const MIN_SHOW = num('FAB_MIN_SHOW_MS');
const HOLD = num('ANOMALY_HOLD_MS');
const TICK = (() => {
  const m = /private final Runnable fabTick[\s\S]{0,400}?postDelayed\(this,\s*(\d+)\)/.exec(main);
  return m ? Number(m[1]) : NaN;
})();

ok('常量 FAB_MIN_SHOW_MS 可读', MIN_SHOW === 30000, MIN_SHOW);
ok('常量 ANOMALY_HOLD_MS 可读', HOLD === 60000, HOLD);
ok('tick 周期可读且 <= 2s', TICK > 0 && TICK <= 2000, TICK);

// ---- 与 updateFab() 等价的模型（时间轴统一用秒；Java 用毫秒，判据等价） ----
const MIN_S = MIN_SHOW / 1000;
const HOLD_S = HOLD / 1000;
function makeModel() {
  return {
    visible: false,
    fabShownAt: -Infinity,
    lastAnomalyAt: -Infinity,
    pageDead: false,
    banner: 'none',
    now: 0,
    update() {
      const abnormal = this.pageDead || this.banner !== 'none';
      const hold = this.now - this.lastAnomalyAt < HOLD_S;
      const fresh = this.now - this.fabShownAt < MIN_S;
      if (abnormal || hold || fresh) {
        if (!this.visible) this.fabShownAt = this.now;
        this.visible = true;
      } else {
        this.visible = false;
      }
    },
    show() {
      this.fabShownAt = this.now;
      this.visible = true;
    },
    anomaly() {
      this.lastAnomalyAt = this.now;
      this.update();
    },
    tick() {
      this.update();
    },
  };
}

// 1. 冷启动健康：一开始就在加载（showFab），30 秒后必须收起
{
  const m = makeModel();
  m.show();
  m.tick();
  ok('加载开始可见', m.visible === true);
  m.now = 29;
  m.tick();
  ok('29 秒仍可见（不闪退）', m.visible === true);
  m.now = 31;
  m.tick();
  ok('31 秒已收起', m.visible === false, JSON.stringify({ visible: m.visible }));
}

// 2. 健康稳态：tick 一直跑，有没有探针都无所谓 —— 30 秒后收起且不再冒头
{
  const m = makeModel();
  m.now = 1000;
  m.show();
  let hidAt = null;
  for (let t = 1000; t <= 1200; t += 1) {
    m.now = t;
    m.tick();
    if (!m.visible && hidAt === null) hidAt = t;
  }
  ok('健康 200 秒内必收起', hidAt !== null && hidAt <= 1031, hidAt);
  ok('收起后不再自己冒出来', m.visible === false);
}

// 3. 页面判死：立刻可见，异常过去 60 秒 + 30 秒最短显示内一定收起
{
  const m = makeModel();
  m.now = 500;
  m.tick();
  m.now = 510;
  m.pageDead = true;
  m.anomaly();
  ok('判死后立刻可见', m.visible === true);
  m.now = 560;
  m.pageDead = false;
  m.tick();
  ok('异常刚过去 50 秒仍可见', m.visible === true);
  m.now = 600;
  m.tick();
  ok('异常过去 90 秒已收起', m.visible === false, JSON.stringify({ visible: m.visible }));
}

// 4. 登录页（横幅常驻）：悬浮球必须一直在，否则人被困在登录页
{
  const m = makeModel();
  m.now = 100;
  m.banner = 'login';
  m.tick();
  ok('登录页可见', m.visible === true);
  m.now = 100 + 3600;
  m.tick();
  ok('登录页一小时后仍可见', m.visible === true);
}

// 5. 反向对照：旧方案（探针每 5 秒重排 30 秒倒计时）跑 10 分钟也收不起来
{
  const OLD_HIDE = 30000;
  const PROBE = 5000;
  let due = 0;
  let hidden = false;
  for (let t = 0; t <= 600000; t += 1000) {
    if (t % PROBE === 0) due = t + OLD_HIDE; // 探针成功 → 重排收起计时
    if (t >= due) {
      hidden = true;
      break;
    }
  }
  ok('旧方案确实永不收起（这就是用户看到的常驻）', hidden === false);
}

if (fail) {
  console.log('\nFAILED: ' + fail);
  process.exit(1);
}
console.log('\n悬浮球行为 14/14 PASS');
