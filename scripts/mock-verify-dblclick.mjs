/**
 * 图片查看器「控件双击防误触」专项验证：
 * 连续点击上一/下一/旋转等控件按钮时，不应被浏览器合并成 dblclick 而误触发
 * 「双击图片进入/退出全屏」；同时双击图片本身的全屏功能必须仍然正常。
 *
 * 检测依据：mock 环境下全屏切换会翻转 window.__vtStore.pipActive
 * （该状态由 store 在 openPipFromCurrentModal / closePipWindow 中维护）。
 *
 * 前置：VITE_MOCK=1 npm run dev（端口 5173）
 * 运行：node scripts/mock-verify-dblclick.mjs
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

// playwright-core 装在受管工作区（不污染项目 node_modules）；ESM 不走 NODE_PATH，
// 因此按绝对路径加载。可用 PW_CORE 环境变量覆盖。
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

const pipActive = (page) => page.evaluate(() => !!window.__vtStore?.pipActive);

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

  // ---------- 打开图片查看器（主窗口） ----------
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

  // ---------- 1. 连续双击「下一个」不应进入全屏 ----------
  await main.dblclick(".player-mask .img-nav.next", { delay: 60 });
  await sleep(900); // 覆盖 600ms 防误触时间窗 + 异步开窗
  let active = await pipActive(main);
  check("主窗口双击「下一个」不误入全屏", active === false, `pipActive=${active}`);
  await main.screenshot({ path: `${SHOTS}/dbl-01-main-next.png` });

  // ---------- 2. 连续双击「上一个」不应进入全屏 ----------
  await main.dblclick(".player-mask .img-nav.prev", { delay: 60 });
  await sleep(900);
  active = await pipActive(main);
  check("主窗口双击「上一个」不误入全屏", active === false, `pipActive=${active}`);

  // ---------- 3. 连续双击「旋转」不应进入全屏 ----------
  await main.dblclick(".player-mask .rot-btn", { delay: 60 });
  await sleep(900);
  active = await pipActive(main);
  const rotAfter = await main.evaluate(
    () => document.querySelector(".player-mask .img-stage img")?.style.transform || ""
  );
  check("主窗口双击「旋转」不误入全屏", active === false, `pipActive=${active}`);
  check("双击旋转仍正常生效（180°）", /rotate\(180deg\)/.test(rotAfter), rotAfter);
  await main.screenshot({ path: `${SHOTS}/dbl-02-main-rotate.png` });

  // ---------- 4. 防误伤：双击图片本身仍应进入全屏 ----------
  await main.dblclick(".player-mask .img-stage img", { delay: 60 });
  await main.waitForFunction(() => !!window.__vtStore?.pipActive, null, { timeout: 8000 });
  check("双击图片本身仍可进入全屏（功能未被误伤）", (await pipActive(main)) === true);
  const label = await main.evaluate(() => localStorage.getItem("__vt_pip_label"));

  // ---------- 5. PiP 窗口内双击「下一个」不应退出全屏 ----------
  const pip = await ctx.newPage();
  pip.on("pageerror", err("pip"));
  pip.on("console", (m) => { if (m.type() === "error") errors.push(`pip console: ${m.text()}`); });
  await pip.goto(`${BASE}/pip.html?label=${encodeURIComponent(label)}`, { waitUntil: "domcontentloaded" });
  await pip.waitForSelector(".pip-stage img", { timeout: 12000 });
  await sleep(800);

  await pip.dblclick(".pip-nav.next", { delay: 60 });
  await sleep(900);
  const stillActive = await pipActive(main);
  check("全屏窗口双击「下一个」不误退出全屏", stillActive === true, `pipActive=${stillActive}`);
  await pip.screenshot({ path: `${SHOTS}/dbl-03-pip-next.png` });

  // ---------- 6. PiP 窗口内双击「旋转」不应退出全屏 ----------
  await pip.dblclick(".pip-nav.rot", { delay: 60 });
  await sleep(900);
  check("全屏窗口双击「旋转」不误退出全屏", (await pipActive(main)) === true);

  // ---------- 7. 防误伤：PiP 内双击图片本身仍应退出全屏 ----------
  await pip.dblclick(".pip-stage img", { delay: 60 });
  await main.waitForFunction(() => !window.__vtStore?.pipActive, null, { timeout: 8000 });
  check("全屏窗口双击图片本身仍可退出全屏（功能未被误伤）", (await pipActive(main)) === false);
  await main.screenshot({ path: `${SHOTS}/dbl-04-after-exit.png` });

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
