/**
 * 1.0.2-r8 专项验证：全局设置 + 回收站即时刷新 + 缓存自定义小时 + 播放器布局/倍速：
 *  1. 回收站条目显示到期时间（默认 3 天）→ 设置改 7 天 → **不重进回收站**，
 *     条目剩余天数/到期时间立即刷新为「剩 7 天」（此前 store.trash 不刷新）
 *  2. 切换资料库（openLibrary）→ 设置保持 7 天（此前换库 settings 表丢失、跳回 3 天）；
 *     回收站顶部提示/删除确认文案同步为 7 天
 *  3. 缓存保留时长自定义小时：输入 12 → 保存 → 重开设置仍显示 12（此前非预设值被重置为 1）
 *  4. 播放器：进度条与播放/快进/快退/倍速/音量同一水平线居中；
 *     倍速新增 0.25/0.75；自定义改水平滑动条（max=6）；] 键 6 封顶
 *
 * 前置：VITE_MOCK=1 npm run dev（端口 5173）
 * 运行：node scripts/mock-verify-settings-global.mjs
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
async function closeSettings(main) {
  await main.keyboard.press("Escape");
  await main.waitForFunction(() => !document.querySelector(".modal-mask"), null, { timeout: 5000 });
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
      activeIdx: pills.findIndex((p) => p.classList.contains("on")),
      texts: pills.map((p) => p.textContent.trim()),
      input: field?.querySelector(".ttl-input")?.value || "",
    };
  });
}
async function cacheFieldState(main) {
  return main.evaluate(() => {
    const labels = [...document.querySelectorAll(".modal-mask label")];
    const lb = labels.find((el) => el.textContent.includes("缓存保留时长"));
    if (!lb) return null;
    const field = lb.closest(".field");
    const pills = [...(field?.querySelectorAll(".radio-pill") || [])];
    return {
      activeIdx: pills.findIndex((p) => p.classList.contains("on")),
      texts: pills.map((p) => p.textContent.trim()),
      input: field?.querySelector(".ttl-input")?.value || "",
    };
  });
}
async function trashRows(main) {
  return main.evaluate(() =>
    [...document.querySelectorAll(".row-item")].map((it) => ({
      name: it.querySelector(".r-name")?.textContent || "",
      expire: it.querySelector(".r-expire")?.textContent || "",
    }))
  );
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

  // ========== 需求 1：回收站设置变更后条目立即刷新 ==========
  await openTrash(main);
  const rows0 = await trashRows(main);
  check("回收站列表渲染（mock 2 项）", rows0.length === 2, `count=${rows0.length}`);
  check(
    "默认 3 天：条目显示「剩 3 天自动清除」",
    rows0.length === 2 && rows0.every((r) => /剩 3 天自动清除/.test(r.expire)),
    JSON.stringify(rows0.map((r) => r.expire))
  );

  await openSettings(main);
  const f0 = await trashFieldState(main);
  check("设置面板渲染回收站自动清除（4 快捷 + 自定义输入）", !!f0 && f0.activeIdx === 0 && f0.input === "3", JSON.stringify(f0));
  // 点击「7 天」
  await main.evaluate(() => {
    const labels = [...document.querySelectorAll(".modal-mask label")];
    const field = labels.find((el) => el.textContent.includes("回收站自动清除")).closest(".field");
    const pills = [...field.querySelectorAll(".radio-pill")];
    pills.find((p) => p.textContent.includes("7 天"))?.click();
  });
  await sleep(600);
  const v7 = await main.evaluate(() => window.__vtStore.settings.trash_ttl_days);
  check("点击「7 天」→ 设置保存为 7", v7 === "7", `value=${v7}`);
  // 关键断言：不关闭设置、不重进回收站，store.trash 的 expire_at 已被后端重置刷新
  const after = await main.evaluate(() => {
    const t = window.__vtStore.trash;
    const now = Date.now();
    return {
      n: t.length,
      expireAt: t[0]?.expire_at || 0,
      deltaDays: t[0] ? (t[0].expire_at - now) / 86_400_000 : 0,
    };
  });
  check(
    "改设置后 store.trash 立即刷新（expire_at ≈ 此刻 + 7 天，未重进回收站）",
    after.n === 2 && after.deltaDays > 6 && after.deltaDays <= 7,
    `delta=${after.deltaDays.toFixed(2)}d`
  );
  const rows7 = await trashRows(main); // 设置面板仍打开，下层 TrashView 响应式更新
  check(
    "条目剩余天数文本立即变为「剩 7 天」",
    rows7.length === 2 && rows7.every((r) => /剩 7 天自动清除/.test(r.expire)),
    JSON.stringify(rows7.map((r) => r.expire))
  );
  await main.screenshot({ path: `${SHOTS}/sg-01-trash-refresh-7d.png` });
  await closeSettings(main);
  const hint7 = await main.evaluate(
    () => document.querySelector(".trash-ttl-hint")?.textContent || ""
  );
  check("回收站顶部提示同步「7 天后自动清除」", /7 天后自动/.test(hint7), hint7);

  // ========== 需求 2：切换资料库 → 设置保持（不重置为默认） ==========
  await main.evaluate((root) => window.__vtActions.openLibrary(root), ROOT);
  await main.waitForFunction(() => window.__vtStore.ready === true, null, { timeout: 8000 });
  await sleep(600);
  const afterSwitch = await main.evaluate(() => window.__vtStore.settings.trash_ttl_days);
  check(
    "切换资料库后 trash_ttl_days 保持 7（此前换库回退 3）",
    afterSwitch === "7",
    `value=${afterSwitch}`
  );
  await openSettings(main);
  const f1 = await trashFieldState(main);
  check(
    "切库后设置面板仍选中「7 天」",
    !!f1 && f1.activeIdx === 1 && f1.input === "7",
    JSON.stringify(f1)
  );
  await closeSettings(main);
  await openTrash(main);
  const hintAfterSwitch = await main.evaluate(
    () => document.querySelector(".trash-ttl-hint")?.textContent || ""
  );
  check("切库后回收站顶部提示仍「7 天后自动清除」", /7 天后自动/.test(hintAfterSwitch), hintAfterSwitch);
  // 删除确认弹窗文案跟随全局设置
  await main.evaluate(() => { window.__vtStore.view = "browse"; });
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
    "删除确认弹窗含「文件将于 7 天后自动清除」",
    /文件将于 7 天后自动清除，请及时查验/.test(confirmMsg),
    confirmMsg.replace(/\s+/g, " ").slice(0, 80)
  );
  await main.click(".confirm-mask .modal-foot .btn.danger");
  await sleep(500);

  // ========== 需求 3：缓存保留时长自定义小时 ==========
  await openSettings(main);
  const c0 = await cacheFieldState(main);
  check("缓存字段渲染（1/6/24/永不 + 自定义输入）", !!c0 && c0.activeIdx === 0 && c0.input === "1", JSON.stringify(c0));
  await main.evaluate(() => {
    const labels = [...document.querySelectorAll(".modal-mask label")];
    const field = labels.find((el) => el.textContent.includes("缓存保留时长")).closest(".field");
    const input = field.querySelector(".ttl-input");
    if (input) {
      input.value = "12";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await sleep(500);
  const cacheVal = await main.evaluate(() => window.__vtStore.settings.cache_ttl_hours);
  check("自定义输入 12 → cache_ttl_hours=12", cacheVal === "12", `value=${cacheVal}`);
  const c1 = await cacheFieldState(main);
  check("自定义值不高亮任何预设档", !!c1 && c1.activeIdx === -1 && c1.input === "12", JSON.stringify(c1));
  await closeSettings(main);
  // 重开设置：自定义值保留（此前非预设值被重置为 "1"）
  await openSettings(main);
  const c2 = await cacheFieldState(main);
  check("重开设置自定义 12 仍保留", !!c2 && c2.input === "12" && c2.activeIdx === -1, JSON.stringify(c2));
  await main.screenshot({ path: `${SHOTS}/sg-02-cache-custom-12h.png` });
  // 还原默认 1 小时
  await main.evaluate(() => {
    const labels = [...document.querySelectorAll(".modal-mask label")];
    const field = labels.find((el) => el.textContent.includes("缓存保留时长")).closest(".field");
    const pills = [...field.querySelectorAll(".radio-pill")];
    pills.find((p) => p.textContent.includes("1 小时"))?.click();
  });
  await sleep(400);
  // 还原回收站 3 天（避免影响其他脚本）
  await main.evaluate(() => {
    const labels = [...document.querySelectorAll(".modal-mask label")];
    const field = labels.find((el) => el.textContent.includes("回收站自动清除")).closest(".field");
    const pills = [...field.querySelectorAll(".radio-pill")];
    pills.find((p) => p.textContent.includes("3 天"))?.click();
  });
  await sleep(400);
  await closeSettings(main);

  // ========== 需求 4：播放器单行居中 + 倍速扩展 ==========
  await main.click('[data-path="/Volumes/VTMock/电影"]');
  await main.waitForFunction(
    () => location.pathname === "/" && !!window.__vtStore?.listing?.entries?.length,
    null,
    { timeout: 8000 }
  );
  await sleep(400);
  await main.click(`[data-path="${VIDEO}"]`);
  await main.waitForSelector(".player-mask video", { timeout: 8000 });
  await main.waitForSelector(".vc-bar", { timeout: 8000 });
  await sleep(500);
  // 4a. 进度条与播放键同一水平线（垂直中心对齐）
  const rowAlign = await main.evaluate(() => {
    const bar = document.querySelector(".vc-bar");
    const track = document.querySelector(".vc-track");
    const btn = document.querySelector(".vc-row .vc-btn"); // 第一个主控键（播放）
    if (!bar || !track || !btn) return null;
    const tr = track.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const inSameRow = bar.contains(track) && bar.contains(btn);
    return { inSameRow, dy: Math.abs(tr.top + tr.height / 2 - (br.top + br.height / 2)) };
  });
  check(
    "进度条与播放键同一控制栏、垂直中心对齐（单行居中）",
    !!rowAlign && rowAlign.inSameRow && rowAlign.dy < 6,
    JSON.stringify(rowAlign)
  );
  // 4b. 倍速菜单：0.25 / 0.75 预设 + 滑动条
  await main.click(".vc-btn.wide");
  await main.waitForSelector(".vc-menu", { timeout: 4000 });
  const menuState = await main.evaluate(() => {
    const items = [...document.querySelectorAll(".vc-menu .vc-menu-item")].map((it) => it.textContent.trim());
    const slider = document.querySelector(".vc-rate-slider");
    return {
      items,
      has025: items.some((t) => t.startsWith("0.25×")),
      has075: items.some((t) => t.startsWith("0.75×")),
      sliderMax: slider ? slider.max : null,
      sliderStep: slider ? slider.step : null,
    };
  });
  check(
    "倍速预设含 0.25× 与 0.75×",
    menuState.has025 && menuState.has075,
    JSON.stringify(menuState.items)
  );
  check(
    "自定义为水平滑动条（max=6、step=0.25）",
    menuState.sliderMax === "6" && menuState.sliderStep === "0.25",
    `max=${menuState.sliderMax} step=${menuState.sliderStep}`
  );
  await main.screenshot({ path: `${SHOTS}/sg-03-rate-menu.png` });
  // 4c. 点击 0.25× → playbackRate 生效
  await main.evaluate(() => {
    const item = [...document.querySelectorAll(".vc-menu .vc-menu-item")]
      .find((it) => it.textContent.trim().startsWith("0.25×"));
    item?.click();
  });
  await sleep(400);
  const rate025 = await main.evaluate(() => {
    const v = document.querySelector(".player-mask video");
    return { rate: v ? v.playbackRate : 0, label: document.querySelector(".vc-rate-text")?.textContent || "" };
  });
  check(
    "点击 0.25× → playbackRate=0.25、按钮显示 0.25×",
    rate025.rate === 0.25 && rate025.label === "0.25×",
    JSON.stringify(rate025)
  );
  // 4d. 拖动滑动条到 6 → playbackRate=6
  await main.click(".vc-btn.wide");
  await main.waitForSelector(".vc-rate-slider", { timeout: 4000 });
  await main.evaluate(() => {
    const s = document.querySelector(".vc-rate-slider");
    if (s) {
      s.value = "6";
      s.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await sleep(400);
  const rate6 = await main.evaluate(() => {
    const v = document.querySelector(".player-mask video");
    return { rate: v ? v.playbackRate : 0, label: document.querySelector(".vc-rate-text")?.textContent || "" };
  });
  check(
    "滑动条拖到 6 → playbackRate=6、按钮显示 6×",
    rate6.rate === 6 && rate6.label === "6×",
    JSON.stringify(rate6)
  );
  // 4e. ] 键封顶 6
  await main.keyboard.press("]");
  await sleep(300);
  const rateAfterBracket = await main.evaluate(() => {
    const v = document.querySelector(".player-mask video");
    return v ? v.playbackRate : 0;
  });
  check("按 ] 键在 6 封顶", rateAfterBracket === 6, `rate=${rateAfterBracket}`);
  await main.screenshot({ path: `${SHOTS}/sg-04-player-rate6.png` });
  // 关闭播放器
  await main.keyboard.press("Escape");
  await sleep(400);

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
