/**
 * 1.0.2-r9 专项验证：缩略图条滚轮「前后浏览」（主窗播放器 / 图片查看器 + PiP 双端）
 *
 *  1. 视频播放器：条带可滚动；滚轮向下 → scrollLeft 增大（向后浏览），向上 → 减小（向前浏览）
 *  2. 视频播放器：滚轮只浏览条带，不切换当前视频（index / src 不变）
 *  3. 视频播放器：滚到两端后继续滚不报错、不切换（到头即不吞事件）
 *  4. 视频播放器：滚轮过程中缩略条保持可见（strip-hidden 未生效）
 *  5. 图片查看器：条带上滚轮 → 条带横滚，且主图 scale 不变（不缩放）
 *  6. 图片查看器：主图区域滚轮 → 仍正常缩放（既有能力未回归）
 *  7. 图片查看器：条带上滚轮不切换当前图片
 *  8. PiP 视频窗口：.pip-strip 滚轮 → 横滚
 *  9. PiP 图片窗口：.pip-strip 滚轮 → 横滚且主图 scale 不变
 * 10. 全程无 JS 报错
 *
 * 前置：VITE_MOCK=1 npm run dev（端口 5173）
 * 运行：node scripts/mock-verify-strip-wheel.mjs
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

/** 读取条带滚动状态 */
async function stripState(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    return {
      scrollLeft: Math.round(el.scrollLeft),
      scrollWidth: Math.round(el.scrollWidth),
      clientWidth: Math.round(el.clientWidth),
      hidden: el.classList.contains("strip-hidden") || el.classList.contains("hidden"),
      count: el.querySelectorAll("img, .thumb-ph").length,
    };
  }, sel);
}

/**
 * 进入指定目录：若当前网格里已有该目录卡片就直接点，否则先点面包屑首项回根再点。
 * （关闭播放器/查看器后网格仍停在原子目录，此时目标卡片并不在 DOM 中）
 */
async function gotoDir(page, dir) {
  const card = page.locator(`[data-path="${dir}"]`);
  if ((await card.count()) === 0) {
    await page.locator(".crumb").first().click();
    await sleep(500);
  }
  await page.locator(`[data-path="${dir}"]`).first().click();
  await page.waitForFunction(
    () => !!window.__vtStore?.listing?.entries?.length,
    null,
    { timeout: 8000 }
  );
  await sleep(300);
}

/** 把鼠标移到条带中心并滚动滚轮（真实 wheel 事件，走浏览器默认派发） */
async function wheelOnStrip(page, sel, dy) {
  await page.hover(sel);
  await sleep(120);
  await page.mouse.wheel(0, dy);
  await sleep(220);
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
  const err = (tag) => (e) => errors.push(`${tag} pageerror: ${e.message}`);
  main.on("pageerror", err("main"));
  main.on("console", (m) => {
    if (m.type() === "error" && !m.location().url.includes("favicon"))
      errors.push(`main console: ${m.text()}`);
  });

  await main.goto(BASE, { waitUntil: "domcontentloaded" });
  await main.waitForFunction(() => !!document.querySelector(".app"), null, { timeout: 15000 });
  await sleep(600);

  // ---------- 1. 视频播放器：缩略条滚轮前后浏览 ----------
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

  // 队列加长（mock 目录仅 4 个视频，条带撑不满无法滚动）：
  // 直接往 store 的播放列表追加条目，缩略图缺失时用占位格（同样 60px 宽），布局稳定。
  await main.evaluate(() => {
    const p = window.__vtStore.modals.player;
    const base = p.list[0];
    for (let i = 0; i < 40; i++) {
      p.list.push({
        ...base,
        path: `/Volumes/VTMock/电影/滚轮浏览${String(i + 1).padStart(2, "0")}.mp4`,
        name: `滚轮浏览${String(i + 1).padStart(2, "0")}.mp4`,
      });
    }
  });
  await main.waitForSelector(".player-mask .img-strip", { timeout: 5000 });
  await sleep(600);

  const VSTRIP = ".player-mask .img-strip";
  const s0 = await stripState(main, VSTRIP);
  check(
    "视频播放器：缩略条渲染 40+ 项且可横向滚动",
    !!s0 && s0.count >= 40 && s0.scrollWidth > s0.clientWidth + 20,
    s0 ? `count=${s0.count} scrollWidth=${s0.scrollWidth} clientWidth=${s0.clientWidth}` : "null"
  );

  // 先把条带滚回最左，保证「向后浏览」有空间
  await main.evaluate((s) => {
    document.querySelector(s).scrollLeft = 0;
  }, VSTRIP);
  await sleep(150);

  const before = await stripState(main, VSTRIP);
  await wheelOnStrip(main, VSTRIP, 300);
  const afterDown = await stripState(main, VSTRIP);
  check(
    "视频播放器：滚轮向下 → 条带向后浏览（scrollLeft 增大）",
    afterDown.scrollLeft > before.scrollLeft + 20,
    `${before.scrollLeft} → ${afterDown.scrollLeft}`
  );

  await wheelOnStrip(main, VSTRIP, -300);
  const afterUp = await stripState(main, VSTRIP);
  check(
    "视频播放器：滚轮向上 → 条带向前浏览（scrollLeft 减小）",
    afterUp.scrollLeft < afterDown.scrollLeft - 20,
    `${afterDown.scrollLeft} → ${afterUp.scrollLeft}`
  );

  // 滚轮只浏览条带，不切换当前视频
  const idxBefore = await main.evaluate(() => window.__vtStore.modals.player.index);
  const srcBefore = await main.evaluate(
    () => document.querySelector(".player-mask video")?.getAttribute("src") || ""
  );
  await wheelOnStrip(main, VSTRIP, 600);
  await wheelOnStrip(main, VSTRIP, 600);
  const idxAfter = await main.evaluate(() => window.__vtStore.modals.player.index);
  const srcAfter = await main.evaluate(
    () => document.querySelector(".player-mask video")?.getAttribute("src") || ""
  );
  check(
    "视频播放器：滚轮浏览条带不切换当前视频（index / src 不变）",
    idxBefore === idxAfter && srcBefore === srcAfter,
    `index ${idxBefore}→${idxAfter}`
  );

  // 滚轮时条带保持可见
  const visState = await stripState(main, VSTRIP);
  check("视频播放器：滚轮浏览时缩略条保持可见（未 strip-hidden）", visState.hidden === false);

  // 滚到最右后再滚：到头不切换、不报错
  await main.evaluate((s) => {
    const el = document.querySelector(s);
    el.scrollLeft = el.scrollWidth;
  }, VSTRIP);
  await sleep(150);
  const atEnd = await stripState(main, VSTRIP);
  await wheelOnStrip(main, VSTRIP, 800);
  const stillEnd = await stripState(main, VSTRIP);
  const idxEnd = await main.evaluate(() => window.__vtStore.modals.player.index);
  check(
    "视频播放器：滚到尽头继续滚 → 停在末端且不切换（到头不吞事件）",
    Math.abs(stillEnd.scrollLeft - atEnd.scrollLeft) <= 2 && idxEnd === idxBefore,
    `${atEnd.scrollLeft} → ${stillEnd.scrollLeft}, index=${idxEnd}`
  );
  await main.screenshot({ path: `${SHOTS}/strip-wheel-01-video.png` });

  // ---------- 2. 图片查看器：条带滚轮横滚且不缩放主图 ----------
  await main.keyboard.press("Escape");
  await sleep(500);
  await main.waitForFunction(() => !window.__vtStore?.modals?.player, null, { timeout: 8000 });
  await gotoDir(main, "/Volumes/VTMock/照片");
  await main.click('[data-path="/Volumes/VTMock/照片/海边.jpg"]');
  await main.waitForSelector(".img-stage img", { timeout: 8000 });
  await sleep(700);
  // 同样注入足够多的条目，令条带可滚动
  await main.evaluate(() => {
    const v = window.__vtStore.modals.viewer;
    const base = v.list[0];
    for (let i = 0; i < 40; i++) {
      v.list.push({
        ...base,
        path: `/Volumes/VTMock/照片/滚轮浏览${String(i + 1).padStart(2, "0")}.jpg`,
        name: `滚轮浏览${String(i + 1).padStart(2, "0")}.jpg`,
      });
    }
  });
  await main.waitForSelector(".img-stage .img-strip", { timeout: 5000 });
  await sleep(600);

  const ISTRIP = ".img-stage .img-strip";
  const readScale = () =>
    main.evaluate(() => {
      const img = document.querySelector(".img-stage img");
      const m = /scale\(([\d.]+)\)/.exec(img?.style.transform || "");
      return m ? parseFloat(m[1]) : null;
    });

  const i0 = await stripState(main, ISTRIP);
  check(
    "图片查看器：缩略条渲染 40+ 项且可横向滚动",
    !!i0 && i0.count >= 40 && i0.scrollWidth > i0.clientWidth + 20,
    i0 ? `count=${i0.count} scrollWidth=${i0.scrollWidth} clientWidth=${i0.clientWidth}` : "null"
  );

  await main.evaluate((s) => {
    document.querySelector(s).scrollLeft = 0;
  }, ISTRIP);
  await sleep(150);
  const imgIdxBefore = await main.evaluate(() => window.__vtStore.modals.viewer.index);
  const scaleBefore = await readScale();

  const ib = await stripState(main, ISTRIP);
  await wheelOnStrip(main, ISTRIP, 300);
  const ia = await stripState(main, ISTRIP);
  const scaleAfterStripWheel = await readScale();
  const imgIdxAfter = await main.evaluate(() => window.__vtStore.modals.viewer.index);
  check(
    "图片查看器：条带上滚轮 → 条带前后浏览（scrollLeft 增大）",
    ia.scrollLeft > ib.scrollLeft + 20,
    `${ib.scrollLeft} → ${ia.scrollLeft}`
  );
  check(
    "图片查看器：条带上滚轮不缩放主图（scale 保持）",
    scaleBefore !== null && Math.abs(scaleAfterStripWheel - scaleBefore) < 0.001,
    `scale ${scaleBefore} → ${scaleAfterStripWheel}`
  );
  check(
    "图片查看器：条带上滚轮不切换当前图片（index 不变）",
    imgIdxBefore === imgIdxAfter,
    `index ${imgIdxBefore}→${imgIdxAfter}`
  );

  // 主图区域滚轮仍应缩放（既有能力未回归）
  const box = await main.locator(".img-stage").boundingBox();
  await main.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(150);
  await main.mouse.wheel(0, -300);
  await sleep(300);
  const scaleAfterStageWheel = await readScale();
  check(
    "图片查看器：主图区域滚轮仍正常缩放（既有能力未回归）",
    scaleAfterStageWheel !== null && scaleAfterStageWheel > scaleBefore + 0.05,
    `scale ${scaleBefore} → ${scaleAfterStageWheel}`
  );
  await main.screenshot({ path: `${SHOTS}/strip-wheel-02-image.png` });

  // ---------- 3. PiP 视频窗口：条带滚轮 ----------
  await main.keyboard.press("Escape");
  await sleep(400);
  await main.waitForFunction(() => !window.__vtStore?.modals?.viewer, null, { timeout: 8000 });
  await gotoDir(main, "/Volumes/VTMock/电影");
  await main.click('[data-path="/Volumes/VTMock/电影/千与千寻.mp4"]');
  await main.waitForSelector(".player-mask video", { timeout: 10000 });
  await sleep(600);
  await main.evaluate(() => {
    const p = window.__vtStore.modals.player;
    const base = p.list[0];
    for (let i = 0; i < 40; i++) {
      p.list.push({
        ...base,
        path: `/Volumes/VTMock/电影/PiP滚轮${String(i + 1).padStart(2, "0")}.mp4`,
        name: `PiP滚轮${String(i + 1).padStart(2, "0")}.mp4`,
      });
    }
  });
  await sleep(400);
  await main.click(".player-mask .fs-btn");
  await main.waitForFunction(() => !!window.__vtStore?.pipActive, null, { timeout: 8000 });
  const label = await main.evaluate(() => localStorage.getItem("__vt_pip_label"));
  const pip = await ctx.newPage();
  pip.on("pageerror", err("pip"));
  await pip.goto(`${BASE}/pip.html?label=${encodeURIComponent(label)}`, {
    waitUntil: "domcontentloaded",
  });
  await pip.waitForSelector(".pip-body video", { timeout: 12000 });
  await sleep(1000);

  const PSTRIP = ".pip-strip";
  const pb = await stripState(pip, PSTRIP);
  check(
    "PiP 视频：缩略条渲染 40+ 项且可横向滚动",
    !!pb && pb.count >= 40 && pb.scrollWidth > pb.clientWidth + 20,
    pb ? `count=${pb.count} scrollWidth=${pb.scrollWidth} clientWidth=${pb.clientWidth}` : "null"
  );
  await pip.evaluate((s) => {
    document.querySelector(s).scrollLeft = 0;
  }, PSTRIP);
  await sleep(150);
  const pb0 = await stripState(pip, PSTRIP);
  await wheelOnStrip(pip, PSTRIP, 300);
  const pb1 = await stripState(pip, PSTRIP);
  check(
    "PiP 视频：条带上滚轮 → 前后浏览（scrollLeft 增大）",
    pb1.scrollLeft > pb0.scrollLeft + 20,
    `${pb0.scrollLeft} → ${pb1.scrollLeft}`
  );
  await pip.screenshot({ path: `${SHOTS}/strip-wheel-03-pip-video.png` });
  await pip.keyboard.press("Escape");
  await main.waitForFunction(() => !window.__vtStore?.pipActive, null, { timeout: 8000 });
  await sleep(400);
  await main.keyboard.press("Escape");
  await sleep(400);

  // ---------- 4. PiP 图片窗口：条带滚轮 + 主图不缩放 ----------
  await main.waitForFunction(() => !window.__vtStore?.modals?.player, null, { timeout: 8000 });
  await gotoDir(main, "/Volumes/VTMock/照片");
  await main.click('[data-path="/Volumes/VTMock/照片/海边.jpg"]');
  await main.waitForSelector(".img-stage img", { timeout: 8000 });
  await sleep(600);
  await main.evaluate(() => {
    const v = window.__vtStore.modals.viewer;
    const base = v.list[0];
    for (let i = 0; i < 40; i++) {
      v.list.push({
        ...base,
        path: `/Volumes/VTMock/照片/PiP滚轮${String(i + 1).padStart(2, "0")}.jpg`,
        name: `PiP滚轮${String(i + 1).padStart(2, "0")}.jpg`,
      });
    }
  });
  await sleep(400);
  await main.click(".img-stage .fs-btn:not(.rot-btn)");
  await main.waitForFunction(() => !!window.__vtStore?.pipActive, null, { timeout: 8000 });
  const label2 = await main.evaluate(() => localStorage.getItem("__vt_pip_label"));
  const pipImg = await ctx.newPage();
  pipImg.on("pageerror", err("pip-image"));
  await pipImg.goto(`${BASE}/pip.html?label=${encodeURIComponent(label2)}`, {
    waitUntil: "domcontentloaded",
  });
  await pipImg.waitForSelector(".pip-stage img", { timeout: 12000 });
  await sleep(1000);

  const readPipScale = () =>
    pipImg.evaluate(() => {
      const img = document.querySelector(".pip-stage img");
      const m = /scale\(([\d.]+)\)/.exec(img?.style.transform || "");
      return m ? parseFloat(m[1]) : null;
    });
  const gb = await stripState(pipImg, PSTRIP);
  check(
    "PiP 图片：缩略条渲染 40+ 项且可横向滚动",
    !!gb && gb.count >= 40 && gb.scrollWidth > gb.clientWidth + 20,
    gb ? `count=${gb.count} scrollWidth=${gb.scrollWidth} clientWidth=${gb.clientWidth}` : "null"
  );
  await pipImg.evaluate((s) => {
    document.querySelector(s).scrollLeft = 0;
  }, PSTRIP);
  await sleep(150);
  const gb0 = await stripState(pipImg, PSTRIP);
  const pScaleBefore = await readPipScale();
  await wheelOnStrip(pipImg, PSTRIP, 300);
  const gb1 = await stripState(pipImg, PSTRIP);
  const pScaleAfter = await readPipScale();
  check(
    "PiP 图片：条带上滚轮 → 前后浏览（scrollLeft 增大）",
    gb1.scrollLeft > gb0.scrollLeft + 20,
    `${gb0.scrollLeft} → ${gb1.scrollLeft}`
  );
  check(
    "PiP 图片：条带上滚轮不缩放主图（scale 保持）",
    pScaleBefore !== null && Math.abs(pScaleAfter - pScaleBefore) < 0.001,
    `scale ${pScaleBefore} → ${pScaleAfter}`
  );
  await pipImg.screenshot({ path: `${SHOTS}/strip-wheel-04-pip-image.png` });

  check("全程无 JS 报错（主窗 + PiP 视频 + PiP 图片）", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log("失败项：");
    failed.forEach((f) => console.log(` - ${f.name}${f.detail ? " — " + f.detail : ""}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
