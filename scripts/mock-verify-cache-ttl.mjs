/**
 * 1.0.2-r4 专项验证：缓存按时间自动过期（设置项）+ 转封装清理开关：
 *  1. 设置面板「缓存保留时长」4 个选项渲染、默认 1 小时
 *  2. 点击 6 小时 / 永不清理 → store.settings.cache_ttl_hours 实时变更
 *  3. 刷新页面 → 设置持久化生效（mock get_settings）
 *  4. 「关闭播放器时清理视频转封装缓存」开关可切换且持久化
 *
 * 前置：VITE_MOCK=1 npm run dev（端口 5173）
 * 运行：node scripts/mock-verify-cache-ttl.mjs
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

async function openSettings(main) {
  await main.evaluate(() => {
    window.__vtStore.modals.settings = true;
  });
  await main.waitForSelector(".modal-mask", { timeout: 5000 });
  await sleep(300);
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
  main.on("response", (r) => {
    // favicon 在 dev server 下必然 404（与功能无关），忽略
    if (r.status() === 404 && !r.url().includes("favicon")) errors.push(`404: ${r.url()}`);
  });

  await main.goto(BASE, { waitUntil: "domcontentloaded" });
  await main.waitForFunction(() => !!document.querySelector(".app"), null, { timeout: 15000 });
  await sleep(600);

  // ---------- 1. 缓存保留时长选项 ----------
  await openSettings(main);
  const ttl = await main.evaluate(() => {
    const labels = [...document.querySelectorAll(".modal-mask label")];
    const lb = labels.find((el) => el.textContent.includes("缓存保留时长"));
    if (!lb) return null;
    const field = lb.closest(".field");
    const pills = [...(field?.querySelectorAll(".radio-pill") || [])];
    return {
      pillCount: pills.length,
      texts: pills.map((p) => p.textContent.trim()),
      activeIdx: pills.findIndex((p) => p.classList.contains("on")),
    };
  });
  check(
    "「缓存保留时长」渲染 4 个选项",
    ttl && ttl.pillCount === 4 && /1 小时|6 小时|24 小时|永不清理/.test(ttl.texts.join("|")),
    JSON.stringify(ttl)
  );
  check("默认选中「1 小时」", ttl && ttl.activeIdx === 0, `activeIdx=${ttl?.activeIdx}`);

  // ---------- 2. 切换为 6 小时 ----------
  await main.evaluate(() => {
    const labels = [...document.querySelectorAll(".modal-mask label")];
    const field = labels.find((el) => el.textContent.includes("缓存保留时长")).closest(".field");
    field.querySelectorAll(".radio-pill")[1].click();
  });
  await sleep(400);
  const v6 = await main.evaluate(() => window.__vtStore.settings.cache_ttl_hours);
  check("点击「6 小时」→ cache_ttl_hours=6", v6 === "6", `value=${v6}`);

  // ---------- 3. 永不清理 → 0，再回 1 小时 ----------
  await main.evaluate(() => {
    const labels = [...document.querySelectorAll(".modal-mask label")];
    const field = labels.find((el) => el.textContent.includes("缓存保留时长")).closest(".field");
    field.querySelectorAll(".radio-pill")[3].click();
  });
  await sleep(400);
  const v0 = await main.evaluate(() => window.__vtStore.settings.cache_ttl_hours);
  check("点击「永不清理」→ cache_ttl_hours=0", v0 === "0", `value=${v0}`);
  await main.screenshot({ path: `${SHOTS}/ttl-01-options.png` });

  await main.evaluate(() => {
    const labels = [...document.querySelectorAll(".modal-mask label")];
    const field = labels.find((el) => el.textContent.includes("缓存保留时长")).closest(".field");
    field.querySelectorAll(".radio-pill")[0].click();
  });
  await sleep(400);

  // ---------- 4. 转封装清理开关 ----------
  const clean = await main.evaluate(() => {
    const labels = [...document.querySelectorAll(".modal-mask label")];
    const lb = labels.find((el) => el.textContent.includes("清理视频转封装缓存"));
    if (!lb) return null;
    const field = lb.closest(".field");
    const pills = [...(field?.querySelectorAll(".radio-pill") || [])];
    return { count: pills.length, activeIdx: pills.findIndex((p) => p.classList.contains("on")) };
  });
  check("「关闭播放器时清理转封装缓存」开关存在且默认开启", clean && clean.count === 2 && clean.activeIdx === 0, JSON.stringify(clean));

  await main.evaluate(() => {
    const labels = [...document.querySelectorAll(".modal-mask label")];
    const field = labels.find((el) => el.textContent.includes("清理视频转封装缓存")).closest(".field");
    field.querySelectorAll(".radio-pill")[1].click(); // 切到「保留副本」
  });
  await sleep(400);
  const c0 = await main.evaluate(() => window.__vtStore.settings.cleanup_remux_on_close);
  check("切换为「保留副本」→ cleanup_remux_on_close=0", c0 === "0", `value=${c0}`);

  // ---------- 5. 刷新页面持久化 ----------
  await main.reload({ waitUntil: "domcontentloaded" });
  await main.waitForFunction(() => !!document.querySelector(".app"), null, { timeout: 15000 });
  await sleep(800);
  const persisted = await main.evaluate(() => ({
    ttl: window.__vtStore.settings.cache_ttl_hours,
    clean: window.__vtStore.settings.cleanup_remux_on_close,
  }));
  check(
    "刷新后设置持久化（ttl=1 保留, remux=0）",
    persisted.ttl === "1" && persisted.clean === "0",
    JSON.stringify(persisted)
  );

  // 还原默认值，避免影响其他脚本
  await openSettings(main);
  await main.evaluate(() => {
    const labels = [...document.querySelectorAll(".modal-mask label")];
    const f1 = labels.find((el) => el.textContent.includes("清理视频转封装缓存")).closest(".field");
    f1.querySelectorAll(".radio-pill")[0].click();
  });
  await sleep(300);
  await main.keyboard.press("Escape");
  await sleep(300);

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
