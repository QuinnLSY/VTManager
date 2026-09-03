/**
 * 独立窗口全屏 + 视频播放 的浏览器联调自动化验证。
 *
 * 前置：VITE_MOCK=1 npm run dev（端口 5173）
 * 运行：node scripts/mock-verify.mjs
 *
 * 真实开两个页面（主窗口 + 独立全屏窗口），共享 localStorage 模拟 Rust 侧共享状态，
 * 端到端验证：视频起播 → 进入全屏 → 全屏窗口渲染（重点：不再是黑屏）→
 * 上一/下一 / 缩略图条 → 退出全屏 → 主窗口按回传节点续播。
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

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const main = await ctx.newPage();

  const errors = [];
  const err = (tag) => (e) => errors.push(`${tag}: ${e.message}\n${(e.stack || "").split("\n").slice(1, 4).join("\n")}`);
  main.on("pageerror", err("main"));
  main.on("console", (m) => {
    if (m.type() === "error") errors.push(`main console: ${m.text()}`);
  });

  // ---------- 1. 主窗口启动 ----------
  await main.goto(BASE, { waitUntil: "domcontentloaded" });
  await main.waitForFunction(() => !!document.querySelector(".app"), null, { timeout: 15000 });
  check("主窗口应用渲染就绪", true);

  // 进入「电影」目录
  await main.click('[data-path="/Volumes/VTMock/电影"]');
  await main.waitForFunction(
    () => location.pathname === "/" && !!window.__vtStore?.listing?.entries?.length,
    null,
    { timeout: 8000 }
  );
  await sleep(400);
  await main.screenshot({ path: `${SHOTS}/01-grid.png` });

  // ---------- 2. 打开播放器，验证真的能播 ----------
  await main.click('[data-path="/Volumes/VTMock/电影/千与千寻.mp4"]');
  await main.waitForSelector(".player-mask video", { timeout: 10000 });
  const src = await main.getAttribute(".player-mask video", "src");
  check("播放器走本地流直连（未触发强制转封装）", !!src && src.includes("__mockstream/raw/"), src || "");

  const noRemux = await main.evaluate(() => !document.querySelector(".player-mask .remux-bar"));
  check("未出现「正在为大文件准备流式播放」转封装面板", noRemux);

  await main.waitForFunction(
    () => {
      const v = document.querySelector(".player-mask video");
      return v && v.readyState >= 2 && v.duration > 0;
    },
    null,
    { timeout: 15000 }
  );
  const meta = await main.evaluate(() => {
    const v = document.querySelector(".player-mask video");
    return { duration: v.duration, w: v.videoWidth, h: v.videoHeight, paused: v.paused };
  });
  check("视频已加载（duration/分辨率可读）", meta.duration > 0 && meta.w > 0, JSON.stringify(meta));

  await main.evaluate(() => document.querySelector(".player-mask video").play().catch(() => {}));
  await sleep(1800);
  const t1 = await main.evaluate(() => document.querySelector(".player-mask video").currentTime);
  check("视频实际在播放（currentTime 前进）", t1 > 0.3, `currentTime=${t1.toFixed(2)}s`);

  // 缩略图条（视频播放器新增）
  const strip = await main.evaluate(() => {
    const s = document.querySelector(".player-mask .img-strip");
    return s ? { count: s.children.length, cur: s.querySelectorAll(".cur").length } : null;
  });
  check("主窗口视频播放器有缩略图条", !!strip && strip.count >= 2, JSON.stringify(strip));
  await main.screenshot({ path: `${SHOTS}/02-player.png` });

  // ---------- 3. 进入独立全屏窗口 ----------
  await main.click(".player-mask .fs-btn");
  await main.waitForFunction(() => !!window.__vtStore?.pipActive, null, { timeout: 8000 });
  const label = await main.evaluate(() => localStorage.getItem("__vt_pip_label"));
  check("点击全屏按钮 → 主窗口进入 pipActive", true, `label=${label}`);

  const hidden = await main.evaluate(() => {
    const el = document.querySelector(".player-mask");
    return el ? getComputedStyle(el).display : "gone";
  });
  check("主窗口播放器被 v-show 隐藏（保持挂载，未销毁）", hidden === "none", `display=${hidden}`);

  const stillMounted = await main.evaluate(
    () => !!window.__vtStore?.modals?.player && !!document.querySelector(".player-mask video")
  );
  check("主窗口播放器仍挂载且 video 元素未销毁", stillMounted);

  const paused = await main.evaluate(() => document.querySelector(".player-mask video").paused);
  check("进入全屏后主窗口视频已暂停", paused);

  // ---------- 4. 独立全屏窗口渲染（黑屏回归点） ----------
  const pip = await ctx.newPage();
  pip.on("pageerror", err("pip-video"));
  pip.on("console", (m) => {
    if (m.type() === "error") errors.push(`pip console: ${m.text()}`);
  });
  await pip.goto(`${BASE}/pip.html?label=${encodeURIComponent(label)}`, {
    waitUntil: "domcontentloaded",
  });
  await pip.waitForSelector(".pip-root", { timeout: 10000 });
  await pip.waitForFunction(
    () => {
      const r = document.querySelector(".pip-root");
      return r && r.children.length > 0 && !document.querySelector(".pip-root .pip-fallback");
    },
    null,
    { timeout: 12000 }
  );
  await sleep(1200);
  await pip.screenshot({ path: `${SHOTS}/03-pip-fullscreen.png` });

  const pipDom = await pip.evaluate(() => {
    const root = document.querySelector(".pip-root");
    const body = document.querySelector(".pip-body");
    const video = document.querySelector(".pip-body video");
    const stripEl = document.querySelector(".pip-strip");
    const r = root.getBoundingClientRect();
    return {
      rootChildren: root.children.length,
      hasBody: !!body,
      videoSrc: video?.getAttribute("src") || null,
      videoReady: video?.readyState ?? -1,
      videoDuration: video?.duration ?? 0,
      stripCount: stripEl ? stripEl.children.length : 0,
      rootH: Math.round(r.height),
      rootW: Math.round(r.width),
      bodyH: body ? Math.round(body.getBoundingClientRect().height) : 0,
    };
  });
  check(
    "独立全屏窗口渲染出组件（不再是黑屏）",
    pipDom.hasBody && pipDom.rootH > 100 && pipDom.bodyH > 100,
    JSON.stringify(pipDom)
  );
  check("全屏窗口视频走本地流", !!pipDom.videoSrc && pipDom.videoSrc.includes("__mockstream/"), pipDom.videoSrc || "");
  check("全屏窗口有视频缩略图条", pipDom.stripCount >= 2, `thumbs=${pipDom.stripCount}`);

  await pip.waitForFunction(
    () => {
      const v = document.querySelector(".pip-body video");
      return v && v.readyState >= 2 && v.duration > 0;
    },
    null,
    { timeout: 15000 }
  );
  await pip.evaluate(() => document.querySelector(".pip-body video").play().catch(() => {}));
  await sleep(2000);
  const pipT = await pip.evaluate(() => document.querySelector(".pip-body video").currentTime);
  check("全屏窗口视频实际在播放", pipT > 0.3, `currentTime=${pipT.toFixed(2)}s`);

  // ---------- 5. 全屏窗口内「下一个」 ----------
  const curBefore = await pip.evaluate(() => {
    const items = [...document.querySelectorAll(".pip-strip > *")];
    return items.findIndex((el) => el.classList.contains("cur"));
  });
  await pip.click(".pip-body .pip-nav.next");
  await sleep(1500);
  const curAfter = await pip.evaluate(() => {
    const items = [...document.querySelectorAll(".pip-strip > *")];
    return items.findIndex((el) => el.classList.contains("cur"));
  });
  check("全屏窗口「下一个」切换条目", curAfter === curBefore + 1, `${curBefore} → ${curAfter}`);
  await pip.screenshot({ path: `${SHOTS}/04-pip-next.png` });

  // ---------- 6. 退出全屏 → 主窗口按回传节点续播 ----------
  const reportBefore = await main.evaluate(() => {
    const st = JSON.parse(localStorage.getItem("__vt_pip_state") || "{}");
    return st[localStorage.getItem("__vt_pip_label")] || null;
  });
  check("全屏窗口已回写状态（index/进度）给主窗口", !!reportBefore, JSON.stringify(reportBefore));

  await pip.click(".pip-body .pip-nav.fs");
  await pip.waitForTimeout(600);
  await main.waitForFunction(() => !window.__vtStore?.pipActive, null, { timeout: 8000 });
  await sleep(1200);
  await main.screenshot({ path: `${SHOTS}/05-main-resumed.png` });

  const after = await main.evaluate(() => {
    const el = document.querySelector(".player-mask");
    const v = document.querySelector(".player-mask video");
    return {
      display: el ? getComputedStyle(el).display : "gone",
      index: window.__vtStore?.modals?.player?.index,
      paused: v?.paused,
      currentTime: v?.currentTime ?? 0,
      pipLabel: window.__vtStore?.pipLabel,
    };
  });
  check("退出全屏后主窗口播放器恢复显示", after.display !== "none" && after.display !== "gone", JSON.stringify(after));
  check(
    "退出全屏后主窗口同步到全屏里翻到的条目",
    reportBefore && after.index === reportBefore.index,
    `主窗口 index=${after.index}，全屏回传 index=${reportBefore?.index}`
  );
  check("退出全屏后主窗口自动续播（未暂停）", after.paused === false, `paused=${after.paused}`);
  check("退出全屏后从回传节点续播", after.currentTime > 0.2, `currentTime=${after.currentTime.toFixed(2)}s`);

  // ---------- 7. 图片查看器全屏链路 ----------
  await main.evaluate(() => {
    window.__vtStore.modals.player = null;
  });
  await sleep(300);
  await main.evaluate(() => {
    const s = window.__vtStore;
    s.path = "/Volumes/VTMock/照片";
  });
  await main.goto(BASE, { waitUntil: "domcontentloaded" });
  await main.waitForFunction(() => !!document.querySelector(".app"), null, { timeout: 15000 });
  await main.click('[data-path="/Volumes/VTMock/照片"]');
  await sleep(600);
  await main.click('[data-path="/Volumes/VTMock/照片/海边.jpg"]');
  await main.waitForSelector(".player-mask .img-stage", { timeout: 8000 });
  await sleep(600);
  await main.click(".player-mask .fs-btn");
  await main.waitForFunction(() => !!window.__vtStore?.pipActive, null, { timeout: 8000 });
  const imgLabel = await main.evaluate(() => localStorage.getItem("__vt_pip_label"));

  const pipImg = await ctx.newPage();
  pipImg.on("pageerror", err("pip-image"));
  await pipImg.goto(`${BASE}/pip.html?label=${encodeURIComponent(imgLabel)}`, {
    waitUntil: "domcontentloaded",
  });
  await pipImg.waitForSelector(".pip-stage", { timeout: 12000 });
  await sleep(1000);
  await pipImg.screenshot({ path: `${SHOTS}/06-pip-image.png` });
  const imgDom = await pipImg.evaluate(() => {
    const st = document.querySelector(".pip-stage");
    const img = document.querySelector(".pip-stage img");
    const r = st.getBoundingClientRect();
    return {
      stageW: Math.round(r.width),
      stageH: Math.round(r.height),
      imgW: img ? Math.round(img.getBoundingClientRect().width) : 0,
      imgH: img ? Math.round(img.getBoundingClientRect().height) : 0,
      hasRotate: !!document.querySelector(".pip-nav.fs"),
      strip: document.querySelectorAll(".pip-strip img").length,
    };
  });
  check(
    "图片全屏窗口渲染出查看器（不再是黑屏）",
    imgDom.stageH > 100 && imgDom.imgW > 1 && imgDom.imgH > 1,
    JSON.stringify(imgDom)
  );

  // 旋转 + 下一个
  await pipImg.keyboard.press("r");
  await sleep(500);
  const rot = await pipImg.evaluate(() => {
    const img = document.querySelector(".pip-stage img");
    return img?.style.transform || "";
  });
  check("全屏窗口内旋转生效（R 键）", /rotate\(90deg\)/.test(rot), rot);
  await pipImg.screenshot({ path: `${SHOTS}/07-pip-image-rotated.png` });

  const imgIdxBefore = await main.evaluate(() => window.__vtStore?.modals?.viewer?.index);
  await pipImg.click(".pip-stage .pip-nav.next");
  await sleep(600);
  // 主窗口拿到的最终回传状态（退出前最后一次 set_pip_state）
  const imgReport = await main.evaluate(() => {
    const st = JSON.parse(localStorage.getItem("__vt_pip_state") || "{}");
    return st[localStorage.getItem("__vt_pip_label")] || null;
  });
  await pipImg.click(".pip-stage .pip-nav.fs");
  await pipImg.waitForTimeout(600);
  await main.waitForFunction(() => !window.__vtStore?.pipActive, null, { timeout: 8000 });
  await sleep(800);
  const imgAfter = await main.evaluate(() => ({
    index: window.__vtStore?.modals?.viewer?.index,
    display: getComputedStyle(document.querySelector(".player-mask")).display,
  }));
  check(
    "退出图片全屏后主窗口同步到翻到的那一页",
    imgReport && imgAfter.index === imgReport.index,
    `进入前=${imgIdxBefore}，全屏回传=${imgReport?.index}，退出后=${imgAfter.index}`
  );
  check("退出图片全屏后主窗口查看器恢复显示", imgAfter.display !== "none", imgAfter.display);
  await main.screenshot({ path: `${SHOTS}/08-main-image-resumed.png` });

  // ---------- 汇总 ----------
  const realErrors = errors.filter(
    (e) => !/favicon|Failed to load resource.*40[34]/i.test(e)
  );
  check("运行期无 JS 报错", realErrors.length === 0, realErrors.slice(0, 4).join(" | "));

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n===== ${results.length - failed.length}/${results.length} 项通过 =====` +
      `截图目录: ${SHOTS}`
  );
  if (failed.length) {
    console.log("失败项：");
    failed.forEach((f) => console.log(`  ✗ ${f.name} — ${f.detail}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch(async (e) => {
  console.error("验证脚本异常：", e);
  process.exit(2);
});
