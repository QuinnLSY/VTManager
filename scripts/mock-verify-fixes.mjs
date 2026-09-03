/**
 * 4 项优化专项验证：
 *  1. 视频播放器缩略图条不再遮挡进度条（主窗口 80px / PiP 80px）
 *  2. 图片切换不再"先突然放大"（fitW/fitH 不清零，切换瞬间 style.width 保留非空值）
 *  3. 旋转按钮固定在全屏按钮正下方（间距 22px=半个按钮高度）+ 旋转图标（主窗口 + PiP）
 *  4. 旋转 270° 后再旋转顺时针 90° 回正（rot 累加不取模 → rotate(360deg)，非 rotate(0deg)）
 *
 * 前置：VITE_MOCK=1 npm run dev（端口 5173）
 * 运行：node scripts/mock-verify-fixes.mjs
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

  // ---------- 1. 视频播放器：缩略图条 bottom 上移 ----------
  await main.goto(BASE, { waitUntil: "domcontentloaded" });
  await main.waitForFunction(() => !!document.querySelector(".app"), null, { timeout: 15000 });
  await main.click('[data-path="/Volumes/VTMock/电影"]');
  await main.waitForFunction(
    () => location.pathname === "/" && !!window.__vtStore?.listing?.entries?.length,
    null,
    { timeout: 8000 }
  );
  await sleep(400);
  await main.click('[data-path="/Volumes/VTMock/电影/千与千寻.mp4"]');
  await main.waitForSelector(".player-mask video", { timeout: 10000 });
  await sleep(800);
  const mainStripBottom = await main.evaluate(() => {
    const s = document.querySelector(".player-mask .img-strip");
    return s ? parseFloat(getComputedStyle(s).bottom) : null;
  });
  // 1.0.2-r6：缩略条恢复贴底 12px；自定义控制栏（r5 起）整体上移避开缩略条
  const mainNoOverlap = await main.evaluate(() => {
    const bar = document.querySelector(".player-mask .vc-bar")?.getBoundingClientRect();
    const strip = document.querySelector(".player-mask .img-strip")?.getBoundingClientRect();
    return bar && strip ? bar.bottom <= strip.top + 1 : null;
  });
  check(
    "主窗口视频缩略图条贴底（12px）且控制栏不遮挡",
    mainStripBottom === 12 && mainNoOverlap === true,
    `bottom=${mainStripBottom}px 不重叠=${mainNoOverlap}（r6：自定义控制栏上移让位）`
  );

  // PiP 视频窗口
  await main.click(".player-mask .fs-btn");
  await main.waitForFunction(() => !!window.__vtStore?.pipActive, null, { timeout: 8000 });
  const label = await main.evaluate(() => localStorage.getItem("__vt_pip_label"));
  const pip = await ctx.newPage();
  pip.on("pageerror", err("pip"));
  await pip.goto(`${BASE}/pip.html?label=${encodeURIComponent(label)}`, { waitUntil: "domcontentloaded" });
  await pip.waitForSelector(".pip-body video", { timeout: 12000 });
  await sleep(800);
  const pipStripBottom = await pip.evaluate(() => {
    const s = document.querySelector(".pip-strip");
    return s ? parseFloat(getComputedStyle(s).bottom) : null;
  });
  const pipNoOverlap = await pip.evaluate(() => {
    const bar = document.querySelector(".pip-body .vc-bar")?.getBoundingClientRect();
    const strip = document.querySelector(".pip-strip")?.getBoundingClientRect();
    return bar && strip ? bar.bottom <= strip.top + 1 : null;
  });
  check(
    "PiP 视频缩略图条贴底（12px）且控制栏不遮挡",
    pipStripBottom === 12 && pipNoOverlap === true,
    `bottom=${pipStripBottom}px 不重叠=${pipNoOverlap}（r6：自定义控制栏上移让位）`
  );

  // ---------- 2. 图片查看器：切换不闪原始尺寸 + 旋转按钮 ----------
  await pip.evaluate(() => window.close?.()); // 关掉 PiP 视频页
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

  // 旋转按钮：存在 + 图标 + 位置（全屏按钮正下方，间距 22px=半个按钮高度）
  const rotBtnMain = await main.evaluate(() => {
    const fs = document.querySelector(".player-mask .fs-btn");
    const rot = document.querySelector(".player-mask .fs-btn.rot-btn");
    if (!fs || !rot) return { ok: false, detail: "fs/rot 按钮缺失" };
    const fr = fs.getBoundingClientRect();
    const rr = rot.getBoundingClientRect();
    const hasSvg = !!rot.querySelector("svg path");
    const fsSvg = !!fs.querySelector("svg path");
    return {
      ok: true,
      gap: Math.round(rr.top - (fr.top + fr.height)),
      sameRight: Math.abs(rr.right - fr.right) < 2,
      size: Math.round(rr.width) + "x" + Math.round(rr.height),
      hasSvg,
      fsSvg,
      title: rot.getAttribute("title"),
      bg: getComputedStyle(rot).background,
    };
  });
  check(
    "主窗口旋转按钮在全屏按钮正下方（间距 22px）",
    rotBtnMain.ok && rotBtnMain.gap === 22 && rotBtnMain.sameRight,
    JSON.stringify(rotBtnMain)
  );
  check(
    "主窗口旋转按钮用旋转图标（SVG 线条）且风格与全屏按钮一致",
    rotBtnMain.hasSvg && rotBtnMain.size === "44x44" && rotBtnMain.title === "旋转 90°（R）",
    JSON.stringify({ size: rotBtnMain.size, title: rotBtnMain.title })
  );
  await main.screenshot({ path: `${SHOTS}/fix-01-main-rotbtn.png` });

  // 图片切换：新图 src 变化瞬间 style.width 保留非空（不清零 → 不闪原始尺寸）
  const imgBefore = await main.evaluate(() => {
    const img = document.querySelector(".player-mask .img-stage img");
    return { src: img.src, w: img.style.width, h: img.style.height };
  });
  check("初始图片已按适配尺寸渲染", !!imgBefore.w && !!imgBefore.h, `${imgBefore.w}×${imgBefore.h}`);

  await main.click(".player-mask .img-nav.next");
  await main.waitForFunction(
    (prev) => {
      const img = document.querySelector(".player-mask .img-stage img");
      return img && img.src !== prev;
    },
    imgBefore.src,
    { timeout: 8000 }
  );
  const imgSwitch = await main.evaluate(() => {
    const img = document.querySelector(".player-mask .img-stage img");
    return { w: img.style.width, h: img.style.height, naturalW: img.naturalWidth, srcChanged: true };
  });
  check(
    "切换图片瞬间 style 尺寸保留非空（不再闪原始像素尺寸）",
    !!imgSwitch.w && !!imgSwitch.h,
    `切换后 style.width=${imgSwitch.w}（修复前为空→闪原始尺寸 ${imgSwitch.naturalW}px）`
  );

  // 旋转 270° → 再旋转顺时针 90° 回正（主窗口 R 键 4 次 → rotate(360deg)）
  const mainRots = [];
  for (let i = 0; i < 4; i++) {
    await main.keyboard.press("r");
    await sleep(220);
    mainRots.push(
      await main.evaluate(() => {
        const img = document.querySelector(".player-mask .img-stage img");
        return img?.style.transform || "";
      })
    );
  }
  const has360 = /rotate\(360deg\)/.test(mainRots[3]);
  const has270 = /rotate\(270deg\)/.test(mainRots[2]);
  check(
    "主窗口旋转：270° 后再旋转顺时针 90° 回正（270→360）",
    has270 && has360,
    JSON.stringify(mainRots)
  );
  await main.screenshot({ path: `${SHOTS}/fix-02-main-rot360.png` });

  // ---------- 3. PiP 图片：旋转按钮 + 270° 回正 ----------
  await main.click(".player-mask .fs-btn");
  await main.waitForFunction(() => !!window.__vtStore?.pipActive, null, { timeout: 8000 });
  const imgLabel = await main.evaluate(() => localStorage.getItem("__vt_pip_label"));
  const pipImg = await ctx.newPage();
  pipImg.on("pageerror", err("pip-img"));
  await pipImg.goto(`${BASE}/pip.html?label=${encodeURIComponent(imgLabel)}`, { waitUntil: "domcontentloaded" });
  await pipImg.waitForSelector(".pip-stage img", { timeout: 12000 });
  await sleep(800);

  const rotBtnPip = await pipImg.evaluate(() => {
    const fs = document.querySelector(".pip-nav.fs");
    const rot = document.querySelector(".pip-nav.fs.rot");
    if (!fs || !rot) return { ok: false, detail: "缺失" };
    const fr = fs.getBoundingClientRect();
    const rr = rot.getBoundingClientRect();
    return {
      ok: true,
      gap: Math.round(rr.top - (fr.top + fr.height)),
      sameRight: Math.abs(rr.right - fr.right) < 2,
      hasSvg: !!rot.querySelector("svg path"),
      size: Math.round(rr.width) + "x" + Math.round(rr.height),
    };
  });
  check(
    "PiP 旋转按钮在全屏按钮正下方（间距 22px）",
    rotBtnPip.ok && rotBtnPip.gap === 22 && rotBtnPip.sameRight,
    JSON.stringify(rotBtnPip)
  );
  check(
    "PiP 旋转按钮用旋转图标且与全屏按钮同尺寸",
    rotBtnPip.hasSvg && rotBtnPip.size === "44x44",
    JSON.stringify(rotBtnPip)
  );
  await pipImg.screenshot({ path: `${SHOTS}/fix-03-pip-rotbtn.png` });

  // PiP 窗口一打开即继承主窗口的旋转状态（进入前主窗口已旋转 4 次 → 360°）
  const pipInitTransform = await pipImg.evaluate(() => {
    const img = document.querySelector(".pip-stage img");
    return img?.style.transform || "";
  });
  check(
    "PiP 进入全屏即继承主窗口旋转状态（初始 rotate(360deg)）",
    /rotate\(360deg\)/.test(pipInitTransform),
    pipInitTransform
  );
  await pipImg.screenshot({ path: `${SHOTS}/fix-05-pip-inherit-rot.png` });

  // 继承 360° 基础上再按 4 次：450/540/630/720 —— 270→360 顺时针最短路径在 PiP 依旧成立
  const pipRots = [];
  for (let i = 0; i < 4; i++) {
    await pipImg.keyboard.press("r");
    await sleep(220);
    pipRots.push(
      await pipImg.evaluate(() => {
        const img = document.querySelector(".pip-stage img");
        return img?.style.transform || "";
      })
    );
  }
  check(
    "PiP 旋转：继承 360° 基础上 270→360 仍走顺时针最短路径（630→720）",
    /rotate\(630deg\)/.test(pipRots[2]) && /rotate\(720deg\)/.test(pipRots[3]),
    JSON.stringify(pipRots)
  );
  await pipImg.screenshot({ path: `${SHOTS}/fix-04-pip-rot360.png` });

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
