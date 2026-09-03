/**
 * 本轮 3 项优化专项验证：
 *  1. 日夜状态全局持久：切换后写入全局偏好（__vt_prefs.theme），
 *     更换目录 / 刷新页面均不影响；PiP 窗口同步应用主题
 *  2. 适应窗口保留旋转（旋转后点「适应窗口」rot 不清零）；
 *     旋转图标为方形（svg 含 rect，非圆形刷新箭头）
 *  3. 控件统一自动隐藏：主窗口 / PiP 视频播放中静止 2.6s 后
 *     上一/下一、全屏、缩略图条、顶部信息栏一起淡出，鼠标一动一起浮现；
 *     暂停时常驻；图片查看器（主窗口 / PiP）同样静止即隐
 *
 * 前置：VITE_MOCK=1 npm run dev（端口 5173）
 * 运行：node scripts/mock-verify-theme-chrome.mjs
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

/** 读取一组元素的 computed opacity */
async function opacities(page, selectors) {
  return await page.evaluate((sels) => {
    const out = {};
    for (const s of sels) {
      const el = document.querySelector(s);
      out[s] = el ? getComputedStyle(el).opacity : null;
    }
    return out;
  }, selectors);
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
  main.on("console", (m) => { if (m.type() === "error") errors.push(`main console: ${m.text()}`); });

  // ---------- 1. 日夜状态全局 ----------
  await main.goto(BASE, { waitUntil: "domcontentloaded" });
  await main.waitForFunction(() => !!document.querySelector(".app"), null, { timeout: 15000 });
  const theme0 = await main.evaluate(() => document.documentElement.dataset.theme || "(none)");
  // 切到夜间
  await main.click(".theme-row");
  await sleep(400);
  const theme1 = await main.evaluate(() => ({
    attr: document.documentElement.dataset.theme,
    pref: JSON.parse(localStorage.getItem("__vt_prefs") || "{}").theme,
  }));
  check(
    "日夜切换按钮生效并写入全局偏好（__vt_prefs.theme）",
    theme1.attr === "dark" && theme1.pref === "dark",
    `attr=${theme1.attr}, pref=${theme1.pref}`
  );
  // 更换操作目录不影响日夜状态（设置 path + 刷新 = 换目录后重新初始化）
  await main.evaluate(() => { window.__vtStore.path = "/Volumes/VTMock/照片"; });
  await main.goto(BASE, { waitUntil: "domcontentloaded" });
  await main.waitForFunction(() => !!document.querySelector(".app"), null, { timeout: 15000 });
  await sleep(500);
  const theme2 = await main.evaluate(() => document.documentElement.dataset.theme);
  check("更换操作目录（刷新重初始化）后日夜状态不变", theme2 === "dark", `theme=${theme2}`);
  await main.click('[data-path="/Volumes/VTMock/照片"]');
  await sleep(600);
  const theme2b = await main.evaluate(() => document.documentElement.dataset.theme);
  check("进入目录后日夜状态不变", theme2b === "dark", `theme=${theme2b}`);
  await main.screenshot({ path: `${SHOTS}/opt3-01-dark.png` });

  // ---------- 3a. 主窗口视频：播放中静止即全部隐藏，一动即现 ----------
  await main.evaluate(() => { window.__vtStore.path = "/Volumes/VTMock/电影"; });
  await main.goto(BASE, { waitUntil: "domcontentloaded" });
  await main.waitForFunction(() => !!document.querySelector(".app"), null, { timeout: 15000 });
  await main.click('[data-path="/Volumes/VTMock/电影"]');
  await sleep(500);
  await main.click('[data-path="/Volumes/VTMock/电影/千与千寻.mp4"]');
  await main.waitForSelector(".player-mask video", { timeout: 10000 });
  await sleep(1000); // 等起播 + 起始 wake 计时结束前缓冲
  const sels = [
    ".player-mask .img-nav.next",
    ".player-mask .fs-btn",
    ".player-mask .img-strip",
    ".player-mask .player-head",
  ];
  await sleep(3400); // idle 2600ms + 过渡 350ms + 余量
  const hiddenWhilePlaying = await opacities(main, sels);
  const allHidden = Object.values(hiddenWhilePlaying).every((o) => o === "0");
  check(
    "主窗口视频播放中静止后：按钮/缩略图条/顶部栏一起隐藏",
    allHidden,
    JSON.stringify(hiddenWhilePlaying)
  );
  await main.screenshot({ path: `${SHOTS}/opt3-02-video-chrome-hidden.png` });
  // 鼠标一动一起浮现
  await main.mouse.move(680, 430);
  await sleep(600);
  const shownAfterMove = await opacities(main, sels);
  const allShown = Object.values(shownAfterMove).every((o) => o === "1");
  check("主窗口视频：鼠标一动后所有控件一起浮现", allShown, JSON.stringify(shownAfterMove));
  // 暂停后控件常驻（先确保视频还在播放中 —— mock 视频仅 5s，前面流程可能已播完，
  // 此时按空格会变成"重新播放"而非"暂停"，3.4s 后控件又因播放中而隐藏，误判失败）
  await main.evaluate(() => {
    const v = document.querySelector(".player-mask video");
    if (!v) return;
    if (v.ended || v.currentTime > 4) {
      v.currentTime = 0.5;
      v.play().catch(() => {});
    }
  });
  await sleep(600);
  await main.keyboard.press(" "); // 暂停
  await sleep(400);
  await sleep(3400);
  const shownPaused = await opacities(main, sels);
  const allShownPaused = Object.values(shownPaused).every((o) => o === "1");
  check("主窗口视频暂停后控件常驻（不自动隐藏）", allShownPaused, JSON.stringify(shownPaused));
  await main.screenshot({ path: `${SHOTS}/opt3-03-video-paused.png` });

  // ---------- 3b. PiP 视频全屏：同样静止即隐 ----------
  await main.keyboard.press(" "); // 继续播放
  await sleep(400);
  await main.click(".player-mask .fs-btn");
  await main.waitForFunction(() => !!window.__vtStore?.pipActive, null, { timeout: 8000 });
  const label = await main.evaluate(() => localStorage.getItem("__vt_pip_label"));
  const pip = await ctx.newPage();
  pip.on("pageerror", err("pip"));
  await pip.goto(`${BASE}/pip.html?label=${encodeURIComponent(label)}`, { waitUntil: "domcontentloaded" });
  await pip.waitForSelector(".pip-body video", { timeout: 12000 });
  await sleep(1200);
  const pipSels = [".pip-nav.next", ".pip-nav.fs", ".pip-strip"];
  await sleep(3400);
  const pipHidden = await opacities(pip, pipSels);
  check(
    "PiP 视频全屏播放中静止后：按钮/缩略图条一起隐藏",
    Object.values(pipHidden).every((o) => o === "0"),
    JSON.stringify(pipHidden)
  );
  await pip.screenshot({ path: `${SHOTS}/opt3-04-pip-video-hidden.png` });
  await pip.mouse.move(680, 430);
  await sleep(600);
  const pipShown = await opacities(pip, pipSels);
  check("PiP 视频：鼠标一动后控件一起浮现", Object.values(pipShown).every((o) => o === "1"), JSON.stringify(pipShown));

  // ---------- 1b. PiP 窗口同步应用全局主题 ----------
  const pipTheme = await pip.evaluate(() => document.documentElement.dataset.theme);
  check("PiP 独立窗口应用同一全局主题（夜间）", pipTheme === "dark", `theme=${pipTheme}`);
  await pip.evaluate(() => window.close?.());

  // ---------- 3c. 主窗口图片查看器：静止即隐 ----------
  await main.evaluate(() => { window.__vtStore.modals.player = null; });
  await sleep(300);
  await main.evaluate(() => { window.__vtStore.path = "/Volumes/VTMock/照片"; });
  await main.goto(BASE, { waitUntil: "domcontentloaded" });
  await main.waitForFunction(() => !!document.querySelector(".app"), null, { timeout: 15000 });
  await main.click('[data-path="/Volumes/VTMock/照片"]');
  await sleep(600);
  await main.click('[data-path="/Volumes/VTMock/照片/海边.jpg"]');
  await main.waitForSelector(".player-mask .img-stage img", { timeout: 8000 });
  await sleep(800);
  const imgSels = [
    ".player-mask .img-nav.next",
    ".player-mask .fs-btn",
    ".player-mask .fs-btn.rot-btn",
    ".player-mask .img-strip",
    ".player-mask .player-head",
    ".player-mask .img-count",
  ];
  await sleep(3400);
  const imgHidden = await opacities(main, imgSels);
  check(
    "主窗口图片查看器静止后：按钮/缩略图条/顶部栏/提示一起隐藏",
    Object.values(imgHidden).every((o) => o === "0"),
    JSON.stringify(imgHidden)
  );
  await main.screenshot({ path: `${SHOTS}/opt3-05-image-chrome-hidden.png` });
  await main.mouse.move(680, 430);
  await sleep(600);
  const imgShown = await opacities(main, imgSels);
  check("主窗口图片查看器：鼠标一动后控件一起浮现", Object.values(imgShown).every((o) => o === "1"), JSON.stringify(imgShown));

  // ---------- 2. 适应窗口保留旋转 + 方形图标 ----------
  // 旋转 90°（此时按钮已浮现）
  await main.keyboard.press("r");
  await sleep(300);
  const rotBefore = await main.evaluate(() => document.querySelector(".player-mask .img-stage img")?.style.transform || "");
  // 点击「适应窗口」按钮
  const fitClicked = await main.evaluate(() => {
    const btns = [...document.querySelectorAll(".player-mask .player-head .btn")];
    const b = btns.find((x) => x.textContent?.trim() === "适应窗口");
    if (!b) return false;
    b.click();
    return true;
  });
  await sleep(400);
  const afterFit = await main.evaluate(() => document.querySelector(".player-mask .img-stage img")?.style.transform || "");
  check(
    "适应窗口保留旋转（rot 不被清零）",
    fitClicked && /rotate\(90deg\)/.test(rotBefore) && /rotate\(90deg\)/.test(afterFit) && /scale\(1\)/.test(afterFit),
    `旋转后=${rotBefore}，适应窗口后=${afterFit}`
  );
  // 方形图标：svg 含 rect（方形主体），且不含旧的圆形刷新弧线
  const rotIcon = await main.evaluate(() => {
    const btn = document.querySelector(".player-mask .fs-btn.rot-btn");
    if (!btn) return { ok: false };
    const svg = btn.querySelector("svg");
    return {
      ok: true,
      hasRect: !!svg?.querySelector("rect"),
      paths: [...(svg?.querySelectorAll("path") || [])].map((p) => p.getAttribute("d") || "").join(";"),
    };
  });
  const isRefreshArc = /a9 9|M21 12a/.test(rotIcon.paths || "");
  check(
    "旋转图标为方形（svg 含 rect，非圆形刷新箭头）",
    rotIcon.ok && rotIcon.hasRect && !isRefreshArc,
    `hasRect=${rotIcon.hasRect}`
  );
  await main.screenshot({ path: `${SHOTS}/opt3-06-fit-keeps-rot.png` });

  // ---------- 3d. PiP 图片全屏：上一/下一静止即隐 ----------
  await main.click(".player-mask .fs-btn");
  await main.waitForFunction(() => !!window.__vtStore?.pipActive, null, { timeout: 8000 });
  const imgLabel = await main.evaluate(() => localStorage.getItem("__vt_pip_label"));
  const pipImg = await ctx.newPage();
  pipImg.on("pageerror", err("pip-img"));
  await pipImg.goto(`${BASE}/pip.html?label=${encodeURIComponent(imgLabel)}`, { waitUntil: "domcontentloaded" });
  await pipImg.waitForSelector(".pip-stage img", { timeout: 12000 });
  await sleep(1000);
  const pipImgSels = [".pip-nav.next", ".pip-nav.fs", ".pip-nav.fs.rot", ".pip-strip", ".pip-count"];
  await sleep(3400);
  const pipImgHidden = await opacities(pipImg, pipImgSels);
  check(
    "PiP 图片全屏静止后：按钮/缩略图条/提示一起隐藏",
    Object.values(pipImgHidden).every((o) => o === "0"),
    JSON.stringify(pipImgHidden)
  );
  await pipImg.screenshot({ path: `${SHOTS}/opt3-07-pip-image-hidden.png` });
  await pipImg.mouse.move(680, 430);
  await sleep(600);
  const pipImgShown = await opacities(pipImg, pipImgSels);
  check("PiP 图片：鼠标一动后控件一起浮现", Object.values(pipImgShown).every((o) => o === "1"), JSON.stringify(pipImgShown));

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
    failed.forEach((f) => console.log(`  ✗ ${f.name} — ${f.detail}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch(async (e) => {
  console.error("验证脚本异常：", e);
  process.exit(2);
});
