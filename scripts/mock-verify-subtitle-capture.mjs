/**
 * 播放器字幕 + 截图（1.0.2-r7）专项验证：
 *  1. 打开「电影/千与千寻.mp4」→ 自动探测同目录字幕并加载（tracks/active/cues）
 *  2. 字幕 overlay：seek 到 cue 时间窗 → .player-sub 显示对应文本；CC 按钮高亮
 *  3. CC 菜单：同目录轨道列表 + 当前轨道高亮 + 字号调整（1.5× → fontSize 增大）
 *  4. C 键开关字幕：overlay 消失/恢复，CC 按钮高亮联动
 *  5. 菜单「关闭字幕」→ active/cues 清空；重新点轨道 → 恢复加载
 *  6. 菜单「选择字幕文件…」→ mock 预置路径 → 加载成功
 *  7. S 键截图 → toast「已保存截图」；菜单「截图保存目录…」→ toast 目录
 *  8. 进入全屏 → PiP 载荷含 subtitle 快照、PiP 内渲染同一字幕；PiP 内开关字幕联动
 *  9. 退出全屏 → 主窗口字幕状态保持
 *
 * 前置：VITE_MOCK=1 npm run dev（端口 5173）
 * 运行：node scripts/mock-verify-subtitle-capture.mjs
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
const VIDEO = "/Volumes/VTMock/电影/千与千寻.mp4";

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

  await main.goto(BASE, { waitUntil: "domcontentloaded" });
  await main.waitForFunction(() => !!document.querySelector(".app"), null, { timeout: 15000 });
  await main.click('[data-path="/Volumes/VTMock/电影"]');
  await main.waitForFunction(
    () => location.pathname === "/" && !!window.__vtStore?.listing?.entries?.length,
    null,
    { timeout: 8000 }
  );
  await sleep(400);

  // ---------- 1. 播放千与千寻 → 字幕自动探测 + 自动加载 ----------
  // 电影目录默认分栏视图，用通用 data-path 定位条目
  await main.click(`[data-path="${VIDEO}"]`);
  await main.waitForSelector(".player-mask video", { timeout: 8000 });
  // 等待字幕探测 + 读取 + 解析完成（异步链路，最多 5s）
  await main.waitForFunction(
    () => window.__vtStore?.subtitle?.cues?.length > 0,
    null,
    { timeout: 6000 }
  );
  const sub0 = await main.evaluate(() => {
    const s = window.__vtStore.subtitle;
    return {
      tracks: s.tracks.map((t) => t.name),
      active: s.active,
      cues: s.cues.length,
      first: s.cues[0] ? { s: s.cues[0].s, e: s.cues[0].e, text: s.cues[0].text } : null,
    };
  });
  check(
    "自动探测同目录字幕（tracks 含千与千寻.srt）",
    sub0.tracks.length === 1 && sub0.tracks[0] === "千与千寻.srt",
    JSON.stringify(sub0.tracks)
  );
  check(
    "自动加载同名轨道（active 指向 srt、解析出 3 条 cue）",
    !!sub0.active && sub0.active.endsWith("千与千寻.srt") && sub0.cues === 3,
    `active=${sub0.active} cues=${sub0.cues}`
  );

  // ---------- 2. 字幕 overlay：seek 到第二条 cue 时间窗（1.8–3.2s） ----------
  await main.evaluate(() => {
    const v = document.querySelector(".player-mask video");
    if (v) v.currentTime = 2.2;
  });
  await sleep(450);
  const ov1 = await main.evaluate(() => {
    const el = document.querySelector(".player-sub");
    return el ? { text: el.textContent, size: parseFloat(getComputedStyle(el).fontSize) } : null;
  });
  check(
    "字幕 overlay 显示当前时间点 cue 文本",
    !!ov1 && ov1.text === "欢迎来到 VTManager 字幕测试",
    JSON.stringify(ov1)
  );
  const ccOn = await main.evaluate(() => {
    const b = document.querySelector(".vc-btn.cc");
    return b ? b.className.includes("on") : false;
  });
  check("CC 按钮高亮（字幕已加载且开启）", ccOn);
  await main.screenshot({ path: `${SHOTS}/sub-01-overlay.png` });

  // ---------- 3. CC 菜单：轨道列表 + 字号 ----------
  await main.click(".vc-btn.cc");
  await main.waitForSelector(".vc-sub-menu", { timeout: 3000 });
  const menu1 = await main.evaluate(() => {
    const m = document.querySelector(".vc-sub-menu");
    if (!m) return null;
    const items = Array.from(m.querySelectorAll(".vc-menu-item")).map((i) => i.textContent?.trim());
    const active = Array.from(m.querySelectorAll(".vc-menu-item.on")).map((i) => i.textContent?.trim());
    const chips = Array.from(m.querySelectorAll(".vc-chip")).map((c) => c.textContent?.trim());
    return { items, active, chips };
  });
  check(
    "CC 菜单列出同目录轨道且当前轨道高亮",
    !!menu1 && menu1.items.some((t) => t?.includes("千与千寻.srt")) && menu1.active.some((t) => t?.includes("千与千寻.srt")),
    JSON.stringify(menu1)
  );
  // 字号 → 1.5×
  const sizeBefore = await main.evaluate(() => {
    const el = document.querySelector(".player-sub");
    return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
  });
  await main.evaluate(() => {
    const chip = Array.from(document.querySelectorAll(".vc-chip")).find((c) => c.textContent?.trim() === "1.5×");
    chip?.click();
  });
  await sleep(300);
  const sizeAfter = await main.evaluate(() => {
    const el = document.querySelector(".player-sub");
    return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
  });
  check("字号 1.5× 生效（overlay 字号增大）", sizeAfter > sizeBefore * 1.4, `${sizeBefore}px → ${sizeAfter}px`);
  await main.screenshot({ path: `${SHOTS}/sub-02-bigger.png` });
  // 关闭菜单（点外部）
  await main.evaluate(() => document.body.click());
  await sleep(200);

  // ---------- 4. C 键开关字幕 ----------
  await main.keyboard.press("c");
  await sleep(250);
  const off1 = await main.evaluate(() => ({
    overlay: !!document.querySelector(".player-sub"),
    ccOn: document.querySelector(".vc-btn.cc")?.className.includes("on") || false,
  }));
  check("C 键关闭字幕：overlay 消失、CC 按钮取消高亮", !off1.overlay && !off1.ccOn, JSON.stringify(off1));
  await main.keyboard.press("c");
  await sleep(250);
  const on1 = await main.evaluate(() => ({
    overlay: !!document.querySelector(".player-sub"),
    ccOn: document.querySelector(".vc-btn.cc")?.className.includes("on") || false,
  }));
  check("C 键重新开启：overlay 恢复、CC 按钮高亮", !!on1.overlay && on1.ccOn, JSON.stringify(on1));

  // ---------- 5. 菜单「关闭字幕」→ 清空；重新点轨道 → 恢复 ----------
  await main.click(".vc-btn.cc");
  await main.waitForSelector(".vc-sub-menu", { timeout: 3000 });
  await main.evaluate(() => {
    const item = Array.from(document.querySelectorAll(".vc-sub-menu .vc-menu-item")).find((i) => i.textContent?.includes("关闭字幕"));
    item?.click();
  });
  await sleep(300);
  const closed = await main.evaluate(() => ({
    active: window.__vtStore.subtitle.active,
    cues: window.__vtStore.subtitle.cues.length,
  }));
  check("菜单「关闭字幕」→ active/cues 清空", closed.active === null && closed.cues === 0, JSON.stringify(closed));
  // 重新选择轨道
  await main.click(".vc-btn.cc");
  await main.waitForSelector(".vc-sub-menu", { timeout: 3000 });
  await main.evaluate(() => {
    const item = Array.from(document.querySelectorAll(".vc-sub-menu .vc-menu-item")).find((i) => i.textContent?.includes("千与千寻.srt"));
    item?.click();
  });
  await main.waitForFunction(() => window.__vtStore?.subtitle?.cues?.length > 0, null, { timeout: 4000 });
  check("重新点轨道 → 字幕恢复加载", true, `cues=${await main.evaluate(() => window.__vtStore.subtitle.cues.length)}`);

  // ---------- 6. 菜单「选择字幕文件…」→ 手动加载 ----------
  // 先关闭当前轨道，再走「选择文件」链路（mock 返回预置路径）
  await main.click(".vc-btn.cc");
  await main.waitForSelector(".vc-sub-menu", { timeout: 3000 });
  await main.evaluate(() => {
    const item = Array.from(document.querySelectorAll(".vc-sub-menu .vc-menu-item")).find((i) => i.textContent?.includes("选择字幕文件"));
    item?.click();
  });
  await main.waitForFunction(() => window.__vtStore?.subtitle?.cues?.length > 0, null, { timeout: 4000 });
  check(
    "「选择字幕文件…」加载成功",
    (await main.evaluate(() => window.__vtStore.subtitle.cues.length)) === 3
  );
  await main.screenshot({ path: `${SHOTS}/sub-03-reloaded.png` });
  // 关闭菜单
  await main.evaluate(() => document.body.click());
  await sleep(200);

  // ---------- 7. S 键截图 + 截图保存目录 ----------
  await main.keyboard.press("s");
  await sleep(500);
  const toast1 = await main.evaluate(() => {
    const ts = Array.from(document.querySelectorAll("[class*=toast]")).map((t) => t.textContent || "");
    return ts.join(" | ");
  });
  check("S 键截图：toast 显示保存路径（.png）", toast1.includes("已保存截图") && toast1.includes(".png"), toast1);
  // 打开 CC 菜单 → 截图保存目录
  await main.click(".vc-btn.cc");
  await main.waitForSelector(".vc-sub-menu", { timeout: 3000 });
  await main.evaluate(() => {
    const item = Array.from(document.querySelectorAll(".vc-sub-menu .vc-menu-item")).find((i) => i.textContent?.includes("截图保存目录"));
    item?.click();
  });
  await sleep(500);
  const toast2 = await main.evaluate(() => {
    const ts = Array.from(document.querySelectorAll("[class*=toast]")).map((t) => t.textContent || "");
    return ts.join(" | ");
  });
  check(
    "「截图保存目录…」→ toast 显示自定义目录",
    toast2.includes("截图将保存到") && toast2.includes("/Volumes/VTMock/截图"),
    toast2
  );
  await main.screenshot({ path: `${SHOTS}/sub-04-capture-dir.png` });
  await main.evaluate(() => document.body.click());
  await sleep(200);

  // ---------- 8. 进入全屏 → PiP 载荷含字幕快照 + PiP 内渲染同一字幕 ----------
  await main.click(".player-mask .fs-btn");
  await main.waitForFunction(() => !!window.__vtStore?.pipActive, null, { timeout: 8000 });
  const label = await main.evaluate(() => localStorage.getItem("__vt_pip_label"));
  // 主窗口打开全屏时字幕处于开启状态（前面已恢复）
  const pipPayloadSub = await main.evaluate((lbl) => {
    try {
      const p = JSON.parse(localStorage.getItem("__vt_pip_payload") || "{}");
      return p[lbl]?.subtitle || null;
    } catch {
      return null;
    }
  }, label);
  check(
    "PiP 载荷携带字幕快照（cues/size/enabled）",
    !!pipPayloadSub && Array.isArray(pipPayloadSub.cues) && pipPayloadSub.cues.length === 3 && pipPayloadSub.enabled === true,
    JSON.stringify(pipPayloadSub ? { cues: pipPayloadSub.cues.length, size: pipPayloadSub.size, enabled: pipPayloadSub.enabled } : null)
  );
  const pip = await ctx.newPage();
  pip.on("pageerror", err("pip"));
  await pip.goto(`${BASE}/pip.html?label=${encodeURIComponent(label)}`, { waitUntil: "domcontentloaded" });
  await pip.waitForSelector(".pip-body video", { timeout: 12000 });
  await sleep(800);
  // seek 到 cue 时间窗（PiP 播放 5s 视频，0.3s 起就有 cue）
  await pip.evaluate(() => {
    const v = document.querySelector(".pip-body video");
    if (v) v.currentTime = 2.2;
  });
  await sleep(500);
  const pipSub = await pip.evaluate(() => {
    const el = document.querySelector(".pip-sub");
    return el ? el.textContent : null;
  });
  check("PiP 窗口渲染同一字幕（快照同步）", pipSub === "欢迎来到 VTManager 字幕测试", pipSub);
  await pip.screenshot({ path: `${SHOTS}/sub-05-pip-sub.png` });

  // PiP 内 CC 菜单开关字幕
  await pip.click(".vc-btn.cc");
  await pip.waitForSelector(".vc-sub-menu", { timeout: 3000 });
  await pip.evaluate(() => {
    const item = Array.from(document.querySelectorAll(".vc-sub-menu .vc-menu-item")).find((i) => i.textContent?.includes("字幕显示"));
    item?.click();
  });
  await sleep(300);
  const pipOff = await pip.evaluate(() => !!document.querySelector(".pip-sub"));
  check("PiP 内 CC 菜单可关闭字幕（overlay 消失）", !pipOff);
  await pip.evaluate(() => document.body.click());
  await sleep(200);

  // ---------- 9. 退出全屏 → 主窗口字幕状态保持 ----------
  await pip.keyboard.press("Escape");
  await main.waitForFunction(() => !window.__vtStore?.pipActive, null, { timeout: 8000 });
  await sleep(600);
  const mainState = await main.evaluate(() => ({
    active: window.__vtStore.subtitle.active,
    cues: window.__vtStore.subtitle.cues.length,
    tracks: window.__vtStore.subtitle.tracks.length,
  }));
  check(
    "退出全屏后主窗口字幕状态保持（active/cues/tracks）",
    !!mainState.active && mainState.cues === 3 && mainState.tracks === 1,
    JSON.stringify(mainState)
  );
  await main.screenshot({ path: `${SHOTS}/sub-06-main-resume.png` });

  // ---------- 汇总 ----------
  await main.keyboard.press("Escape");
  await sleep(300);
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
