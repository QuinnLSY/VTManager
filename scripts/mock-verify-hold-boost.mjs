/**
 * 1.0.2-r10 专项验证：播放器长按右方向键 = 临时 2× 当前倍速，松开恢复：
 *  1. 主窗：1× 长按 → 2×（约 400ms 判定窗），松开恢复 1×；控制栏按钮同步显示
 *  2. 主窗：1.5× 长按 → 3×，松开恢复 1.5×
 *  3. 短按（400ms 内松开）不加速，仍执行原「下一个视频」语义（queue.index+1）
 *  4. 左方向键短按仍为「上一个」（不被本次改动破坏）
 *  5. PiP 独立窗口：同一长按 2× / 松开恢复生效（双端共享实现）
 *  6. 无 JS 报错；既有功能（进度条/控制栏/关闭）无回归
 *
 * 前置：VITE_MOCK=1 npm run dev（端口 5173）
 * 运行：node scripts/mock-verify-hold-boost.mjs
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
const ROOT = "/Volumes/VTMock";
const VIDEO = `${ROOT}/电影/千与千寻.mp4`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function playerState(page) {
  return page.evaluate(() => {
    const v = document.querySelector(".player-mask video, .pip-body video");
    const rate = v ? v.playbackRate : 0;
    const label = document.querySelector(".vc-rate-text")?.textContent || "";
    return { rate, label, playing: v ? !v.paused : false };
  });
}
async function openVideoPlayer(main) {
  await main.click('[data-path="/Volumes/VTMock/电影"]');
  await main.waitForFunction(
    () => !!window.__vtStore?.listing?.entries?.length,
    null,
    { timeout: 8000 }
  );
  await sleep(400);
  await main.click(`[data-path="${VIDEO}"]`);
  await main.waitForSelector(".player-mask video", { timeout: 8000 });
  await main.waitForSelector(".vc-bar", { timeout: 8000 });
  await sleep(500);
}
/** 长按 ArrowRight：按下 → 等待超时（判定窗 400ms + 余量）→ 断言加速倍率 */
async function holdRight(page, holdMs) {
  await page.keyboard.down("ArrowRight");
  await sleep(holdMs);
  const during = await playerState(page);
  await page.keyboard.up("ArrowRight");
  await sleep(350);
  const after = await playerState(page);
  return { during, after };
}

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
  main.on("console", (m) => {
    if (m.type() === "error" && !m.location().url.includes("favicon"))
      errors.push(`console: ${m.text()}`);
  });

  await main.goto(BASE, { waitUntil: "domcontentloaded" });
  await main.waitForFunction(() => !!document.querySelector(".app"), null, { timeout: 15000 });
  await sleep(600);

  // ========== 主窗：1× 长按 → 2× ==========
  await openVideoPlayer(main);
  let st = await playerState(main);
  check("播放器打开：默认 1×", st.rate === 1, `rate=${st.rate}`);
  const idx0 = await main.evaluate(() => window.__vtStore.modals?.player?.index ?? -1);
  check("队列可导航（mock 电影目录 ≥2 个视频）", idx0 >= 0, `index=${idx0}`);

  // 长按 650ms（>400ms 判定窗）→ 应进入 2×
  await main.keyboard.down("ArrowRight");
  await sleep(650);
  st = await playerState(main);
  check("1× 长按右方向键 → 临时 2×", st.rate === 2, `rate=${st.rate}`);
  check("加速期间控制栏按钮同步显示 2×", st.label === "2×", `label=${st.label}`);
  await main.screenshot({ path: `${SHOTS}/hb-01-hold-2x.png` });
  await main.keyboard.up("ArrowRight");
  await sleep(400);
  st = await playerState(main);
  check("松开 → 恢复 1×（按钮同步）", st.rate === 1 && st.label === "1×", `rate=${st.rate} label=${st.label}`);
  // 长按不切视频（index 未变）
  const idx1 = await main.evaluate(() => window.__vtStore.modals?.player?.index ?? -1);
  check("长按全程未切换视频（index 不变）", idx1 === idx0, `idx ${idx0} → ${idx1}`);

  // ========== 主窗：1.5× 长按 → 3× ==========
  await main.evaluate(() => {
    const v = document.querySelector(".player-mask video");
    if (v) v.playbackRate = 1.5; // setter 自动派发 ratechange → VideoControls 同步
  });
  await sleep(350);
  st = await playerState(main);
  check("预设倍速切到 1.5×", st.rate === 1.5, `rate=${st.rate}`);
  await main.keyboard.down("ArrowRight");
  await sleep(650);
  st = await playerState(main);
  check("1.5× 长按 → 3×", st.rate === 3, `rate=${st.rate}`);
  await main.keyboard.up("ArrowRight");
  await sleep(400);
  st = await playerState(main);
  check("松开 → 恢复 1.5×", st.rate === 1.5, `rate=${st.rate}`);

  // ========== 短按（<400ms）不加速，保持原「下一个」语义 ==========
  const idx2 = await main.evaluate(() => window.__vtStore.modals?.player?.index ?? -1);
  await main.keyboard.down("ArrowRight");
  await sleep(150);
  st = await playerState(main);
  await main.keyboard.up("ArrowRight");
  await sleep(700); // 等待切换/加载
  const idx3 = await main.evaluate(() => window.__vtStore.modals?.player?.index ?? -1);
  check("短按（150ms）未进入加速", st.rate === 1.5, `rate=${st.rate}`);
  check("短按仍为「下一个视频」（index+1）", idx3 === (idx2 + 1) % 4, `idx ${idx2} → ${idx3}`);

  // ========== 左方向键短按仍为「上一个」 ==========
  const idx4 = await main.evaluate(() => window.__vtStore.modals?.player?.index ?? -1);
  await main.keyboard.press("ArrowLeft");
  await sleep(700);
  const idx5 = await main.evaluate(() => window.__vtStore.modals?.player?.index ?? -1);
  check("左方向键短按仍为「上一个视频」", idx5 === (idx4 + 3) % 4, `idx ${idx4} → ${idx5}`);

  // ========== PiP 独立窗口：长按 2× / 松开恢复 ==========
  // 打开 PiP 全屏（主窗全屏按钮 → mock 记录 label）
  await main.evaluate(() => {
    const v = document.querySelector(".player-mask video");
    if (v) v.playbackRate = 1;
  });
  await sleep(300);
  await main.click(".player-mask .fs-btn");
  await main.waitForFunction(() => !!window.__vtStore?.pipActive, null, { timeout: 8000 });
  await sleep(500);
  const label = await main.evaluate(() => localStorage.getItem("__vt_pip_label"));
  const pipActive = await main.evaluate(() => !!window.__vtStore?.pipActive);
  check("PiP 视频窗口已打开", pipActive && !!label, `label=${label}`);
  const pip = await ctx.newPage();
  pip.on("pageerror", err("pip"));
  if (label) {
    await pip.goto(`${BASE}/pip.html?label=${encodeURIComponent(label)}`, {
      waitUntil: "domcontentloaded",
    });
    await pip.waitForSelector(".pip-body video", { timeout: 12000 });
    await sleep(600);
    let pst = await playerState(pip);
    check("PiP 打开即 1×", pst.rate === 1, `rate=${pst.rate}`);
    await pip.keyboard.down("ArrowRight");
    await sleep(650);
    pst = await playerState(pip);
    check("PiP 长按右方向键 → 2×", pst.rate === 2, `rate=${pst.rate}`);
    await pip.keyboard.up("ArrowRight");
    await sleep(400);
    pst = await playerState(pip);
    check("PiP 松开 → 恢复 1×", pst.rate === 1, `rate=${pst.rate}`);
    await pip.screenshot({ path: `${SHOTS}/hb-02-pip-hold.png` });
    await pip.keyboard.press("Escape");
    await sleep(300);
    await pip.close();
  }
  // 主窗关闭 PiP 状态
  await main.waitForFunction(() => !window.__vtStore?.pipActive, null, { timeout: 8000 }).catch(() => {});

  // 关闭播放器（回归：Esc 正常关闭）
  await main.keyboard.press("Escape");
  await main.waitForFunction(() => !window.__vtStore?.modals?.player, null, { timeout: 8000 });
  check("Esc 关闭播放器正常", true);

  check("全程无 JS 报错", errors.length === 0, errors.slice(0, 3).join(" | "));

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n结果: ${pass}/${results.length} 通过`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("脚本异常:", e);
  process.exit(1);
});
