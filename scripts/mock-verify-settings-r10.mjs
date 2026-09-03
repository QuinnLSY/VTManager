/**
 * 1.0.2-r10 专项验证：设置面板缓存目录 + 自定义输入框布局优化：
 *  1. 缓存保留时长组件下方显示当前资料库缓存目录（<库根>/.VTManager/cache）
 *  2. 「进入缓存目录」按钮存在、点击走 mock open_directory 静默成功（无错误 toast/JS 报错）
 *  3. 缓存/回收站两个自定义输入框宽度一致且已收窄（≤56px，此前 64px）
 *  4. 两自定义行整行居中（justify-content: center）
 *  5. 两侧文字单行完整显示（行内首尾元素同 top、文本无溢出）
 *
 * 前置：VITE_MOCK=1 npm run dev（端口 5173）
 * 运行：node scripts/mock-verify-settings-r10.mjs
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
const CACHE_DIR = `${ROOT}/.VTManager/cache`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openSettings(main) {
  await main.evaluate(() => {
    window.__vtStore.modals.settings = true;
  });
  await main.waitForSelector(".modal-mask", { timeout: 5000 });
  await sleep(400);
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
  main.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  main.on("console", (m) => {
    if (m.type() === "error" && !m.location().url.includes("favicon"))
      errors.push(`console: ${m.text()}`);
  });

  await main.goto(BASE, { waitUntil: "domcontentloaded" });
  await main.waitForFunction(() => !!document.querySelector(".app"), null, { timeout: 15000 });
  await sleep(600);

  await openSettings(main);

  // ========== 1&2：缓存目录展示 + 进入按钮 ==========
  const r = await main.evaluate(() => {
    const labels = [...document.querySelectorAll(".modal-mask label")];
    const cacheField = labels.find((el) => el.textContent.includes("缓存保留时长"))?.closest(".field");
    const trashField = labels.find((el) => el.textContent.includes("回收站自动清除"))?.closest(".field");
    const dirRow = cacheField?.querySelector(".cache-dir-row");
    const btn = dirRow?.querySelector("button");
    const inputs = [cacheField?.querySelector(".ttl-input"), trashField?.querySelector(".ttl-input")];
    const rows = [cacheField?.querySelector(".ttl-input-row"), trashField?.querySelector(".ttl-input-row")];
    const rectW = (el) => (el ? el.getBoundingClientRect().width : 0);
    const rectTop = (el) => (el ? el.getBoundingClientRect().top : 0);
    const rowDetail = (row) => {
      if (!row) return null;
      const kids = [...row.children];
      const tops = kids.map((k) => Math.round(rectTop(k)));
      const heights = kids.map((k) => Math.round(k.getBoundingClientRect().height));
      // 单行完整：每个子元素垂直中线对齐（同一行），且文字 span 没有被截断
      const centers = tops.map((t, i) => t + heights[i] / 2);
      const sameLine = centers.every((c) => Math.abs(c - centers[0]) <= 1);
      const overflow = kids.some(
        (k) => k.tagName.toLowerCase() === "span" && k.scrollWidth > k.clientWidth + 1
      );
      return {
        sameLine,
        overflow,
        justify: getComputedStyle(row).justifyContent,
        nowrap: getComputedStyle(row).whiteSpace,
      };
    };
    return {
      dirPath: dirRow?.querySelector(".cache-dir-path")?.textContent || "",
      btnText: btn?.textContent.trim() || "",
      btnExists: !!btn,
      inputW: inputs.map(rectW),
      cacheRow: rowDetail(rows[0]),
      trashRow: rowDetail(rows[1]),
    };
  });
  check("缓存目录路径显示为 <库根>/.VTManager/cache", r.dirPath === CACHE_DIR, r.dirPath);
  check("「进入缓存目录」按钮存在", r.btnExists && r.btnText === "进入缓存目录", r.btnText);
  await main.screenshot({ path: `${SHOTS}/sr10-01-cache-dir-row.png` });

  // ========== 3&4&5：输入框收窄一致 + 行居中 + 文字单行 ==========
  const w0 = Math.round(r.inputW[0]);
  const w1 = Math.round(r.inputW[1]);
  check(
    "两自定义输入框宽度一致",
    w0 > 0 && w0 === w1,
    `cache=${w0}px trash=${w1}px`
  );
  check("输入框已收窄（≤56px，此前 64px）", w0 > 0 && w0 <= 56, `${w0}px`);
  check(
    "两自定义行整行居中",
    r.cacheRow?.justify === "center" && r.trashRow?.justify === "center",
    `cache=${r.cacheRow?.justify} trash=${r.trashRow?.justify}`
  );
  check(
    "自定义行 nowrap（防换行）",
    r.cacheRow?.nowrap === "nowrap" && r.trashRow?.nowrap === "nowrap",
    `cache=${r.cacheRow?.nowrap} trash=${r.trashRow?.nowrap}`
  );
  check(
    "两侧文字单行完整（行内元素同 top、无文本溢出）",
    !!r.cacheRow && !!r.trashRow && r.cacheRow.sameLine && !r.cacheRow.overflow && r.trashRow.sameLine && !r.trashRow.overflow,
    `cache{same=${r.cacheRow?.sameLine} over=${r.cacheRow?.overflow}} trash{same=${r.trashRow?.sameLine} over=${r.trashRow?.overflow}}`
  );
  await main.screenshot({ path: `${SHOTS}/sr10-02-ttl-rows.png` });

  // ========== 点击「进入缓存目录」：mock 静默成功，无错误 toast ==========
  await main.evaluate(() => {
    (document.querySelector(".cache-dir-row button"))?.click();
  });
  await sleep(500);
  const errToast = await main.evaluate(
    () => !!document.querySelector(".toast.err, .toast.error")
  );
  check("点击「进入缓存目录」无错误提示（mock open_directory 静默成功）", !errToast);

  // 关闭设置
  await main.keyboard.press("Escape");
  await main.waitForFunction(() => !document.querySelector(".modal-mask"), null, { timeout: 5000 });
  check("设置面板正常关闭", true);

  check("全程无 JS 报错", errors.length === 0, errors.slice(0, 3).join(" | "));

  const pass = results.filter((x) => x.ok).length;
  console.log(`\n结果: ${pass}/${results.length} 通过`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("脚本异常:", e);
  process.exit(1);
});
