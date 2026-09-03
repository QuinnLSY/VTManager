/**
 * 旋转状态全屏/非全屏双向同步专项验证：
 *  1. 主窗口旋转 2 次（180°）→ 进入全屏 → PiP 一打开即继承 rotate(180deg)
 *  2. PiP 内再旋转 1 次（270°）→ set_pip_state 已回写 rot=270
 *  3. 退出全屏 → 主窗口 applyPipResume 恢复 rotate(270deg)
 *
 * 前置：VITE_MOCK=1 npm run dev（端口 5173）
 * 运行：node scripts/mock-verify-rot-sync.mjs
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const PW_DIR =
  process.env.PW_CORE ||
  `${os.homedir()}/.workbuddy/binaries/node/workspace/node_modules/playwright-core`;
const PW = fs.existsSync(`${PW_DIR}/index.mjs`)
  ? pathToFileURL(`${PW_DIR}/index.mjs`).href
  : pathToFileURL(`${PW_DIR}/index.js`).href;
const { chromium } = await import(PW);

const BASE = "http://localhost:5173";
const SHOTS = path.resolve(process.cwd(), ".verify-shots");
const CHROME =
  `${os.homedir()}/.agent-browser/browsers/chrome-152.0.7977.64/` +
  "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const main = await ctx.newPage();
  const errors = [];
  const err = (tag) => (e) => errors.push(`${tag}: ${e.message}`);
  main.on("pageerror", err("main"));
  main.on("console", (m) => { if (m.type() === "error") errors.push(`main console: ${m.text()}`); });

  // ---------- 进入照片目录并打开图片查看器 ----------
  await main.goto(BASE, { waitUntil: "domcontentloaded" });
  await main.waitForFunction(() => !!document.querySelector(".app"), null, { timeout: 15000 });
  await main.click('[data-path="/Volumes/VTMock/照片"]');
  await main.waitForFunction(
    () => location.pathname === "/" && !!window.__vtStore?.listing?.entries?.length,
    null,
    { timeout: 8000 }
  );
  await sleep(400);
  await main.click('[data-path="/Volumes/VTMock/照片/海边.jpg"]');
  await main.waitForSelector(".player-mask .img-stage img", { timeout: 8000 });
  await sleep(800);

  // ---------- 1. 主窗口旋转 2 次 → 180° ----------
  for (let i = 0; i < 2; i++) {
    await main.keyboard.press("r");
    await sleep(250);
  }
  const mainRot180 = await main.evaluate(() => {
    const img = document.querySelector(".player-mask .img-stage img");
    return img?.style.transform || "";
  });
  check("主窗口旋转 2 次后为 rotate(180deg)", /rotate\(180deg\)/.test(mainRot180), mainRot180);
  await main.screenshot({ path: `${SHOTS}/sync-01-main-rot180.png` });

  // ---------- 2. 进入全屏 → PiP 继承 rotate(180deg) ----------
  await main.click(".player-mask .fs-btn");
  await main.waitForFunction(() => !!window.__vtStore?.pipActive, null, { timeout: 8000 });
  const label = await main.evaluate(() => localStorage.getItem("__vt_pip_label"));
  const pip = await ctx.newPage();
  pip.on("pageerror", err("pip"));
  await pip.goto(`${BASE}/pip.html?label=${encodeURIComponent(label)}`, { waitUntil: "domcontentloaded" });
  await pip.waitForSelector(".pip-stage img", { timeout: 12000 });
  await sleep(800);

  const pipInit = await pip.evaluate(() => {
    const img = document.querySelector(".pip-stage img");
    return img?.style.transform || "";
  });
  check("PiP 进入全屏即继承主窗口 rotate(180deg)", /rotate\(180deg\)/.test(pipInit), pipInit);
  await pip.screenshot({ path: `${SHOTS}/sync-02-pip-inherit-180.png` });

  // ---------- 3. PiP 内再旋转 1 次 → 270°，回写 set_pip_state ----------
  await pip.keyboard.press("r");
  await sleep(600); // 等节流回写（>500ms 触发 pushState）
  const pipRot270 = await pip.evaluate(() => {
    const img = document.querySelector(".pip-stage img");
    return img?.style.transform || "";
  });
  check("PiP 内旋转后为 rotate(270deg)", /rotate\(270deg\)/.test(pipRot270), pipRot270);
  const stateBack = await main.evaluate((lbl) => {
    const st = JSON.parse(sessionStorage.getItem("__vt_mock_pip_state") || "{}");
    const all = st[lbl];
    return all;
  }, label).catch(() => null);
  // mock 的 set_pip_state 存 pipStore（BroadcastChannel/localStorage 模拟），通过页面端再读一次
  const stateBack2 = await pip.evaluate(() => {
    // pipStore 用 localStorage 存储时可直接读；BroadcastChannel 方案下从 window 上找
    try {
      return JSON.parse(localStorage.getItem("__vt_pip_state") || "{}");
    } catch {
      return null;
    }
  });
  const rotWritten = stateBack2?.[label]?.rot ?? stateBack?.rot;
  check("PiP 旋转后状态已回写（rot=270）", rotWritten === 270, `rot=${rotWritten}`);
  await pip.screenshot({ path: `${SHOTS}/sync-03-pip-rot270.png` });

  // ---------- 4. 退出全屏 → 主窗口恢复 rotate(270deg) ----------
  await pip.keyboard.press("Escape");
  await main.waitForFunction(() => !window.__vtStore?.pipActive, null, { timeout: 8000 });
  await sleep(700); // applyPipResume + computeFit
  const mainResume = await main.evaluate(() => {
    const img = document.querySelector(".player-mask .img-stage img");
    return img?.style.transform || "";
  });
  check("退出全屏后主窗口恢复 rotate(270deg)", /rotate\(270deg\)/.test(mainResume), mainResume);
  await main.screenshot({ path: `${SHOTS}/sync-04-main-resume-270.png` });

  // ---------- 汇总 ----------
  const realErrors = errors.filter((e) => !/favicon|Failed to load resource.*40[34]/i.test(e));
  check("运行期无 JS 报错", realErrors.length === 0, realErrors.slice(0, 4).join(" | "));

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n===== ${results.length - failed.length}/${results.length} 项通过 =====` +
      ` 截图目录: ${SHOTS}`
  );
  if (failed.length) {
    failed.forEach((f) => console.log(`  ✗ ${f.name}: ${f.detail}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
