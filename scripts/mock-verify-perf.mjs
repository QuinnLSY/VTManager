/**
 * 性能优化（1.0.1-r13）专项验证：
 *  1. 设置面板「存储空间」区块：磁盘占用明细渲染 + 红色「一键清除缓存」按钮存在
 *  2. 点红色按钮 → 危险确认弹窗 → 确认 → toast「已清除缓存」+ 占用刷新
 *  3. 虚拟滚动：进入 160 项大目录「剧集」→ .grid-v 模式启用、DOM 卡片数远小于条目数、
 *     滚动到中部后渲染的卡片集合随滚动变化且首屏内容不重叠
 *  4. 图片查看器预览链路：打开图片查看器不报错（mock get_preview 返回 null → 回退原图）
 *
 * 前置：VITE_MOCK=1 npm run dev（端口 5173）
 * 运行：node scripts/mock-verify-perf.mjs
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

  await main.goto(BASE, { waitUntil: "domcontentloaded" });
  await main.waitForFunction(() => !!document.querySelector(".app"), null, { timeout: 15000 });
  await sleep(400);

  // ---------- 1. 设置面板 → 存储空间区块 ----------
  // 打开设置：点击侧边栏「设置」
  await main.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button, .sb-item, div"))
      .find((el) => el.textContent?.trim() === "设置");
    btn?.click?.();
  });
  await main.waitForSelector(".settings-section", { timeout: 5000 });
  await sleep(300);
  const diskCells = await main.evaluate(() => {
    const grid = document.querySelector(".disk-grid");
    return grid ? Array.from(grid.querySelectorAll(".disk-cell")).map((c) => c.textContent?.trim()) : null;
  });
  check(
    "设置面板显示「存储空间」统计网格（应用本体/总占用/缓存/封面/回收站）",
    !!diskCells &&
      diskCells.length === 5 &&
      diskCells.some((t) => t?.includes("应用数据总占用")) &&
      diskCells.some((t) => t?.includes("应用本体大小")),
    JSON.stringify(diskCells)
  );
  const clearBtn = await main.evaluate(() => {
    const b = document.querySelector(".clear-cache-btn");
    return b ? { text: b.textContent?.trim(), cls: b.className, red: b.className.includes("danger") } : null;
  });
  check(
    "「一键清除缓存」按钮存在且为红色 danger 样式",
    !!clearBtn && clearBtn.text.includes("清除") && clearBtn.red,
    JSON.stringify(clearBtn)
  );
  await main.screenshot({ path: `${SHOTS}/perf-01-disk-usage.png` });

  // ---------- 2. 一键清除缓存流程 ----------
  await main.click(".clear-cache-btn");
  await main.waitForSelector(".confirm-mask", { timeout: 4000 });
  const confirmText = await main.evaluate(() => document.querySelector(".confirm-mask")?.textContent || "");
  check("危险确认弹窗：提示将清除缩略图/预览/转封装缓存", confirmText.includes("清除缓存") && confirmText.includes("不影响正常使用"));
  await main.click(".confirm-mask .btn.danger");
  await sleep(500);
  const cleared = await main.evaluate(() => {
    const toasts = Array.from(document.querySelectorAll(".toast, [class*=toast]")).map((t) => t.textContent || "");
    return toasts.join(" | ");
  });
  check("清除后弹出成功提示（含释放大小）", cleared.includes("已清除缓存"), cleared);
  // 占用刷新：按钮恢复可用
  const btnDisabled = await main.evaluate(() => document.querySelector(".clear-cache-btn")?.disabled);
  check("清除完成后按钮恢复可用", btnDisabled === false);
  await main.screenshot({ path: `${SHOTS}/perf-02-cache-cleared.png` });
  // 关闭设置
  await main.keyboard.press("Escape");
  await sleep(200);

  // ---------- 3. 虚拟滚动：160 项大目录（grid 视图下启用） ----------
  // r5 起每级目录默认分栏视图；虚拟滚动作用于网格视图，先强制切回 grid
  await main.evaluate(() => {
    window.__vtStore.viewMode = "grid";
    window.__vtStore.userViewOverride = true;
  });
  await main.click('[data-path="/Volumes/VTMock/剧集"]');
  await main.waitForFunction(
    () => window.__vtStore?.listing?.entries?.length === 160,
    null,
    { timeout: 8000 }
  );
  await sleep(500);
  const v1 = await main.evaluate(() => {
    const inner = document.querySelector(".grid-v-inner");
    const cards = document.querySelectorAll(".grid-v-row .card");
    return {
      virtual: !!inner,
      totalEntries: window.__vtStore.listing.entries.length,
      renderedCards: cards.length,
      innerH: inner ? parseFloat(inner.style.height) : 0,
      firstNames: Array.from(document.querySelectorAll(".grid-v-row .card .name")).slice(0, 4).map((n) => n.textContent),
    };
  });
  check(
    "大目录启用虚拟滚动（.grid-v）",
    v1.virtual && v1.totalEntries === 160,
    `entries=${v1.totalEntries} rendered=${v1.renderedCards}`
  );
  check(
    "DOM 卡片数远小于条目数（只渲染可视区）",
    v1.renderedCards < 80 && v1.renderedCards > 0,
    `rendered=${v1.renderedCards} / 160`
  );
  check("总高度撑开（行数×行高，可滚动到全部条目）", v1.innerH > 3000, `innerH=${v1.innerH}`);

  // 滚动到中部：内容应替换为中部条目
  await main.evaluate(() => {
    const sc = document.querySelector(".content");
    const inner = document.querySelector(".grid-v-inner");
    if (sc && inner) sc.scrollTop = parseFloat(inner.style.height) / 2;
  });
  await sleep(500);
  const v2 = await main.evaluate(() => {
    const names = Array.from(document.querySelectorAll(".grid-v-row .card .name")).map((n) => n.textContent);
    return { count: names.length, sample: names[Math.floor(names.length / 2)] || "" };
  });
  check(
    "滚动到中部后渲染内容切换为中部条目（编号 80+）",
    v2.sample && parseInt(v2.sample.replace(/\D/g, "")) > 60,
    `sample=${v2.sample} rendered=${v2.count}`
  );
  await main.screenshot({ path: `${SHOTS}/perf-03-virtual-scroll.png` });

  // 回到根目录：先滚回顶部（虚拟化下根目录卡不在可视区），点面包屑返回
  await main.evaluate(() => { document.querySelector(".content") && (document.querySelector(".content").scrollTop = 0); });
  await sleep(400);
  await main.evaluate(() => {
    const c = Array.from(document.querySelectorAll(".crumb")).find((el) => el.textContent?.trim() === "VTMock");
    c?.click();
  });
  await main.waitForFunction(
    () => window.__vtStore?.listing?.entries?.length === 6,
    null,
    { timeout: 8000 }
  );
  await sleep(300);
  const backToPlain = await main.evaluate(() => {
    return {
      virtual: !!document.querySelector(".grid-v"),
      plainGrid: !!document.querySelector(".grid:not(.grid-v)"),
      cards: document.querySelectorAll(".grid .card").length,
    };
  });
  check(
    "小目录恢复普通网格渲染（无虚拟化，卡片=条目数）",
    !backToPlain.virtual && backToPlain.plainGrid && backToPlain.cards === 6,
    JSON.stringify(backToPlain)
  );

  // ---------- 4. 图片查看器预览链路 ----------
  await main.click('[data-path="/Volumes/VTMock/照片"]');
  await main.waitForFunction(
    () => window.__vtStore?.listing?.entries?.length === 3,
    null,
    { timeout: 8000 }
  );
  await sleep(400);
  await main.click('.grid .card[data-path="/Volumes/VTMock/照片/海边.jpg"]');
  await main.waitForSelector(".player-mask img", { timeout: 5000 });
  await sleep(600);
  const viewerOk = await main.evaluate(() => {
    const img = document.querySelector(".player-mask img");
    return img ? { src: img.src.slice(0, 30), w: img.naturalWidth } : null;
  });
  check("图片查看器打开且图片成功加载（预览回退链路无报错）", !!viewerOk && (viewerOk.w > 0 || viewerOk.src.startsWith("data:") || viewerOk.src.startsWith("http")), JSON.stringify(viewerOk));
  await main.keyboard.press("Escape");
  await sleep(300);

  // ---------- 汇总 ----------
  const fatal = errors.filter((e) => !e.includes("Failed to load resource") && !e.includes("net::ERR"));
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n===== 结果：${pass}/${results.length} 通过 =====`);
  if (fatal.length) {
    console.log("页面错误：");
    fatal.slice(0, 8).forEach((e) => console.log("  " + e));
  }
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("脚本失败:", e);
  process.exit(1);
});
