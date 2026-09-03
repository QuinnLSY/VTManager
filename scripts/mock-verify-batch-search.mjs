/**
 * 批量操作工具条（底部）+ 搜索缩略图 专项验证：
 *  1. 批量工具条移到窗口底部（.main 内、滚动容器 .content 之外）
 *  2. 批量条新增「标记颜色」按钮：弹 TagPicker 且显示（2 项），选色后条目 tag 生效
 *  3. 批量条新增「批量收藏」按钮：无分类直接收藏到根目录，favorites 增加
 *  4. 全局模糊搜索结果中视频/图片条目左侧由 emoji 换成真实缩略图（<img class="r-thumb">）
 *  5. 目录/文档条目仍显示原 emoji 图标（回退逻辑）
 *
 * 前置：VITE_MOCK=1 npm run dev（端口 5173）
 * 运行：node scripts/mock-verify-batch-search.mjs
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

  const sel = (paths) =>
    main.evaluate((ps) => { window.__vtStore.selection = ps; }, paths);
  const listingTags = () =>
    main.evaluate(() =>
      Object.fromEntries(
        (window.__vtStore.listing?.entries || []).map((e) => [e.path, e.tag])
      )
    );

  // ---------- 1. 进入「电影」，选中 2 项，批量条出现且位于底部 ----------
  await main.goto(BASE, { waitUntil: "domcontentloaded" });
  await main.waitForFunction(() => !!document.querySelector(".app"), null, { timeout: 15000 });
  await main.click('[data-path="/Volumes/VTMock/电影"]');
  await main.waitForFunction(
    () => location.pathname === "/" && !!window.__vtStore?.listing?.entries?.length,
    null,
    { timeout: 8000 }
  );
  await sleep(400);

  const P1 = "/Volumes/VTMock/电影/天空之城.mp4";
  const P2 = "/Volumes/VTMock/电影/龙猫.mkv";
  await sel([P1, P2]);
  await main.waitForSelector(".batch-bar", { timeout: 4000 });

  // 位置：批量条应是 .content 的兄弟节点且位于其之后（滚动容器外 → 窗口底部固定）
  const pos = await main.evaluate(() => {
    const bar = document.querySelector(".batch-bar");
    const content = document.querySelector(".content");
    const r = bar.getBoundingClientRect();
    return {
      inMain: bar.parentElement?.classList.contains("main"),
      afterContent: !!content && content.nextElementSibling === bar,
      inContent: !!content?.contains(bar),
      bottomGap: window.innerHeight - r.bottom,
    };
  });
  check(
    "批量工具条位于窗口底部（.main 内、.content 外）",
    pos.inMain && !pos.inContent && pos.afterContent,
    JSON.stringify(pos)
  );
  check("批量工具条贴底（距视口底 < 4px）", pos.bottomGap >= -1 && pos.bottomGap <= 4, `gap=${pos.bottomGap}px`);

  const btnTexts = await main.evaluate(() =>
    Array.from(document.querySelectorAll(".batch-bar button")).map((b) => b.textContent.trim())
  );
  check(
    "批量条按钮齐全（重命名/标记颜色/收藏/移动到/删除/取消）",
    ["批量重命名", "标记颜色", "批量收藏", "批量移动到…", "批量删除", "取消选择"].every((t) =>
      btnTexts.includes(t)
    ),
    btnTexts.join(" | ")
  );
  await main.screenshot({ path: `${SHOTS}/batch-01-bottom-bar.png` });

  // ---------- 2. 批量标记颜色 ----------
  await main.click(".batch-bar button:has-text('标记颜色')");
  await main.waitForSelector(".modal-mask", { timeout: 4000 });
  const tagTitle = await main.evaluate(() => document.querySelector(".modal-head .t")?.textContent.trim());
  check("标记颜色弹窗标题显示批量数量", tagTitle === "标记颜色（2 项）", tagTitle);
  await main.click(".tag-pick:has-text('红色')");
  await main.waitForFunction(() => !document.querySelector(".tag-pick"), null, { timeout: 4000 });
  await sleep(500);
  const tags = await listingTags();
  check(
    "批量标记颜色生效（2 项均为 red）",
    tags[P1] === "red" && tags[P2] === "red",
    JSON.stringify(tags)
  );
  await main.screenshot({ path: `${SHOTS}/batch-02-tagged.png` });

  // ---------- 3. 批量收藏（无分类 → 收藏到根目录） ----------
  const favsBefore = await main.evaluate(() => window.__vtStore.favorites.length);
  await main.click(".batch-bar button:has-text('批量收藏')");
  await main.waitForFunction(
    (n) => window.__vtStore.favorites.length === n + 2,
    favsBefore,
    { timeout: 6000 }
  );
  const favPaths = await main.evaluate(() =>
    window.__vtStore.favorites.map((f) => f.path).sort()
  );
  check(
    "批量收藏生效（2 项加入收藏夹）",
    favPaths.includes(P1) && favPaths.includes(P2),
    favPaths.join(" | ")
  );
  // 已收藏项再点批量收藏 → 提示均已收藏，数量不变
  await main.click(".batch-bar button:has-text('批量收藏')");
  await sleep(600);
  const favsAfter = await main.evaluate(() => window.__vtStore.favorites.length);
  check("重复收藏幂等（数量不变）", favsAfter === favsBefore + 2, `before=${favsBefore} after=${favsAfter}`);

  // ---------- 4. 搜索缩略图：视频 → 图片 → 文档回退 ----------
  const searchThumbStats = async () =>
    main.evaluate(() =>
      Array.from(document.querySelectorAll(".row-item")).map((it) => {
        const name = it.querySelector(".r-name")?.textContent || "";
        const img = it.querySelector(".r-icon img.r-thumb");
        return {
          name,
          hasThumb: !!img,
          srcIsData: img ? img.getAttribute("src")?.startsWith("data:") : false,
        };
      })
    );
  const searchAnd = async (q, expectThumbCount) => {
    await main.fill(".search-box input", q);
    await main.waitForFunction(
      (n) =>
        window.__vtStore.view === "search" &&
        document.querySelectorAll(".row-item .r-icon img.r-thumb").length >= n,
      expectThumbCount,
      { timeout: 8000 }
    );
    await sleep(300);
    return searchThumbStats();
  };

  // 4a. 视频「千」→ 千与千寻.mp4（根目录 + 电影目录）均为缩略图
  let stats = await searchAnd("千", 2);
  check(
    "搜索结果：视频条目左侧为真实缩略图",
    stats.filter((s) => s.name.endsWith(".mp4")).every((s) => s.hasThumb && s.srcIsData),
    JSON.stringify(stats)
  );
  await main.screenshot({ path: `${SHOTS}/batch-03-search-thumbs.png` });

  // 4b. 图片「海」→ 海贼王.jpg / 海边.jpg 均为缩略图
  stats = await searchAnd("海", 2);
  check(
    "搜索结果：图片条目左侧为真实缩略图",
    stats.filter((s) => s.name.endsWith(".jpg")).every((s) => s.hasThumb && s.srcIsData),
    JSON.stringify(stats)
  );

  // 4c. 文档「备注」→ 无缩略图回退 emoji 图标
  await main.fill(".search-box input", "备注");
  await main.waitForFunction(
    () => window.__vtStore.view === "search" && window.__vtStore.searchResults.length > 0,
    null,
    { timeout: 8000 }
  );
  await sleep(300);
  stats = await searchThumbStats();
  check(
    "搜索结果：文档条目回退 emoji 图标（无 img）",
    stats.every((s) => s.name.endsWith(".txt") && !s.hasThumb),
    JSON.stringify(stats)
  );

  // ---------- 5. 汇总 ----------
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
