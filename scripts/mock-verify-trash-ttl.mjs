/**
 * 1.0.2-r6 专项验证：回收站自动清除（N 天后）+ 到期时间展示 + 删除提醒：
 *  1. 回收站列表条目显示「剩 N 天自动清除 · 具体日期」（默认 3 天）
 *  2. 回收站顶部提示「3 天后自动清除」
 *  3. 删除文件 → 确认弹窗含「文件将于 3 天后自动清除，请及时查验」→ 确认后回收站 +1
 *  4. 设置 → 回收站自动清除改为 7 天 → 在站条目到期文本变为「剩 7 天」
 *  5. 恢复功能可用（回收站 -1）
 *  6. 全程无 JS 错误
 *
 * 前置：VITE_MOCK=1 npm run dev（端口 5173）
 * 运行：node scripts/mock-verify-trash-ttl.mjs
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

async function openTrash(main) {
  await main.evaluate(() => {
    const navs = [...document.querySelectorAll(".nav-item")];
    const t = navs.find((n) => n.textContent.includes("回收站"));
    t?.click();
  });
  await main.waitForFunction(() => !!document.querySelector(".row-list .row-item"), null, { timeout: 8000 });
  await sleep(400);
}
async function openSettings(main) {
  await main.evaluate(() => {
    window.__vtStore.modals.settings = true;
  });
  await main.waitForSelector(".modal-mask", { timeout: 5000 });
  await sleep(300);
}
async function trashFieldState(main) {
  return main.evaluate(() => {
    const labels = [...document.querySelectorAll(".modal-mask label")];
    const lb = labels.find((el) => el.textContent.includes("回收站自动清除"));
    if (!lb) return null;
    const field = lb.closest(".field");
    const pills = [...(field?.querySelectorAll(".radio-pill") || [])];
    return {
      pillCount: pills.length,
      texts: pills.map((p) => p.textContent.trim()),
      activeIdx: pills.findIndex((p) => p.classList.contains("on")),
      input: field?.querySelector(".ttl-input")?.value || "",
    };
  });
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
    if (r.status() === 404 && !r.url().includes("favicon")) errors.push(`404: ${r.url()}`);
  });

  await main.goto(BASE, { waitUntil: "domcontentloaded" });
  await main.waitForFunction(() => !!document.querySelector(".app"), null, { timeout: 15000 });
  await sleep(600);

  // ---------- 1. 回收站列表：条目显示到期时间（默认 3 天） ----------
  await openTrash(main);
  const rows = await main.evaluate(() => {
    const items = [...document.querySelectorAll(".row-item")];
    return items.map((it) => ({
      name: it.querySelector(".r-name")?.textContent || "",
      expire: it.querySelector(".r-expire")?.textContent || "",
    }));
  });
  check("回收站列表渲染（mock 2 项）", rows.length === 2, `count=${rows.length}`);
  check(
    "条目显示「剩 N 天自动清除」到期时间",
    rows.length === 2 && rows.every((r) => /剩 \d+ 天自动清除/.test(r.expire)),
    JSON.stringify(rows.map((r) => r.expire))
  );
  const hint = await main.evaluate(
    () => document.querySelector(".trash-ttl-hint")?.textContent || ""
  );
  check("顶部提示含「3 天后自动清除」", /3 天后自动/.test(hint), hint);
  await main.screenshot({ path: `${SHOTS}/trash-01-ttl-default.png` });

  // ---------- 2. 删除文件 → 确认弹窗含自动清除提醒 ----------
  await main.evaluate(() => { window.__vtStore.view = "browse"; window.__vtStore.modals.trash = false; });
  await main.waitForFunction(() => !document.querySelector(".row-list"), null, { timeout: 5000 });
  await sleep(300);
  await main.click('[data-path="/Volumes/VTMock/海贼王.jpg"]', { button: "right" });
  await main.waitForSelector(".ctx-menu", { timeout: 5000 });
  await sleep(200);
  await main.evaluate(() => {
    const items = [...document.querySelectorAll(".ctx-menu .ctx-item")];
    const del = items.find((it) => it.textContent.includes("删除"));
    del?.click();
  });
  await sleep(400);
  const confirmMsg = await main.evaluate(
    () => document.querySelector(".confirm-mask .modal-body")?.textContent || ""
  );
  check(
    "删除确认弹窗含「文件将于 3 天后自动清除，请及时查验」",
    /文件将于 3 天后自动清除，请及时查验/.test(confirmMsg),
    confirmMsg.replace(/\s+/g, " ").slice(0, 80)
  );
  await main.screenshot({ path: `${SHOTS}/trash-02-confirm-tip.png` });
  await main.click(".confirm-mask .modal-foot .btn.danger");
  await sleep(600);

  // ---------- 3. 回收站 +1（3 项） ----------
  await openTrash(main);
  const countAfter = await main.evaluate(() => document.querySelectorAll(".row-item").length);
  check("确认删除后回收站条目 +1（3 项）", countAfter === 3, `count=${countAfter}`);
  const restoredRows = await main.evaluate(() =>
    [...document.querySelectorAll(".row-item")].map((it) => it.querySelector(".r-expire")?.textContent || "")
  );
  check(
    "新增条目同样显示到期时间",
    restoredRows.length === 3 && restoredRows.every((r) => /剩 \d+ 天自动清除/.test(r)),
    JSON.stringify(restoredRows)
  );

  // ---------- 4. 设置 → 回收站自动清除改为 7 天 → 到期时间重置 ----------
  await openSettings(main);
  const field0 = await trashFieldState(main);
  check(
    "设置面板渲染回收站自动清除（4 快捷 + 自定义输入）",
    !!field0 && field0.pillCount === 4 && field0.texts.includes("3 天") && field0.input !== "",
    JSON.stringify(field0)
  );
  check("默认选中「3 天」", !!field0 && field0.activeIdx === 0 && field0.input === "3", `input=${field0?.input}`);
  await main.evaluate(() => {
    const labels = [...document.querySelectorAll(".modal-mask label")];
    const field = labels.find((el) => el.textContent.includes("回收站自动清除")).closest(".field");
    const pills = [...field.querySelectorAll(".radio-pill")];
    pills.find((p) => p.textContent.includes("7 天"))?.click();
  });
  await sleep(500);
  const v7 = await main.evaluate(() => window.__vtStore.settings.trash_ttl_days);
  check("点击「7 天」→ trash_ttl_days=7", v7 === "7", `value=${v7}`);
  await main.screenshot({ path: `${SHOTS}/trash-03-settings-7d.png` });
  await main.keyboard.press("Escape");
  await sleep(400);

  await openTrash(main);
  const expire7 = await main.evaluate(() => {
    const items = [...document.querySelectorAll(".row-item")];
    return items.map((it) => it.querySelector(".r-expire")?.textContent || "");
  });
  check(
    "改为 7 天后条目到期时间变为「剩 7 天」（当前时刻重置）",
    expire7.length === 3 && expire7.every((r) => /剩 7 天自动清除/.test(r)),
    JSON.stringify(expire7)
  );
  const hint7 = await main.evaluate(
    () => document.querySelector(".trash-ttl-hint")?.textContent || ""
  );
  check("顶部提示同步为「7 天后自动清除」", /7 天后自动/.test(hint7), hint7);
  await main.screenshot({ path: `${SHOTS}/trash-04-expire-7d.png` });

  // ---------- 5. 恢复功能仍可用 ----------
  await main.evaluate(() => {
    const items = [...document.querySelectorAll(".row-item")];
    const last = items[items.length - 1];
    last.querySelector(".r-actions .btn:not(.danger)")?.click();
  });
  await sleep(600);
  const countAfterRestore = await main.evaluate(() => document.querySelectorAll(".row-item").length);
  check("恢复一条 → 回收站回到 2 项", countAfterRestore === 2, `count=${countAfterRestore}`);

  // 还原默认 3 天，避免影响其他脚本
  await openSettings(main);
  await main.evaluate(() => {
    const labels = [...document.querySelectorAll(".modal-mask label")];
    const field = labels.find((el) => el.textContent.includes("回收站自动清除")).closest(".field");
    const pills = [...field.querySelectorAll(".radio-pill")];
    pills.find((p) => p.textContent.includes("3 天"))?.click();
  });
  await sleep(400);
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
