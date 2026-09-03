/**
 * 1.0.2-r5 专项验证：进度条悬停实时帧预览（自定义控制栏 VideoControls）：
 *  1. 主窗口播放器不再使用原生 controls，出现自定义控制栏
 *  2. 悬停进度条 → 帧预览卡片出现（含时间标签），随鼠标移动时间实时变化
 *  3. 精灵图（scrub_sheet mock）就绪 → 预览卡片出现帧画面（backgroundImage 非空）
 *  4. 点击/拖动进度条 seek 生效（video.currentTime 跳转）
 *  5. 播放/暂停、静音按钮可用
 *  6. 全屏独立窗口（PiP）同样：无原生 controls、自定义控制栏 + 悬停预览
 *
 * 前置：VITE_MOCK=1 npm run dev（端口 5173）
 * 运行：node scripts/mock-verify-scrub.mjs
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

  // ---------- 1. 打开视频播放器：无原生 controls，有自定义控制栏 ----------
  await main.click('[data-path="/Volumes/VTMock/电影"]');
  await main.waitForFunction(
    () => location.pathname === "/" && !!window.__vtStore?.listing?.entries?.length,
    null,
    { timeout: 8000 }
  );
  await sleep(400);
  await main.click('[data-path="/Volumes/VTMock/电影/千与千寻.mp4"]');
  await main.waitForSelector(".player-mask video", { timeout: 10000 });
  await main.waitForFunction(
    () => {
      const v = document.querySelector(".player-mask video");
      return v && v.readyState >= 2 && v.duration > 0;
    },
    null,
    { timeout: 15000 }
  );
  await sleep(800);

  const ctrlState = await main.evaluate(() => {
    const v = document.querySelector(".player-mask video");
    const bar = document.querySelector(".player-mask .vc-bar");
    return {
      hasNativeControls: v?.hasAttribute("controls") ?? null,
      hasBar: !!bar,
      dur: v?.duration ?? 0,
      track: !!document.querySelector(".player-mask .vc-track"),
      playBtn: !!document.querySelector(".player-mask .vc-btn"),
      vol: !!document.querySelector(".player-mask .vc-vol"),
    };
  });
  check("原生 controls 已移除", ctrlState.hasNativeControls === false, `controls=${ctrlState.hasNativeControls}`);
  check(
    "自定义控制栏渲染（时间轴/播放/音量）",
    ctrlState.hasBar && ctrlState.track && ctrlState.playBtn && ctrlState.vol,
    JSON.stringify(ctrlState)
  );

  // ---------- 2. 未悬停：预览卡片不显示（等精灵图轮询完成） ----------
  await sleep(1200);
  const previewBefore = await main.evaluate(() => {
    const p = document.querySelector(".player-mask .vc-preview");
    return p ? getComputedStyle(p).opacity : "no-node";
  });
  check("未悬停时不显示预览卡片", previewBefore === "0" || previewBefore === "no-node", previewBefore);

  // ---------- 3. 悬停进度条：帧画面 + 时间标签 + 跟随鼠标实时变化 ----------
  const trackBox = await main.locator(".player-mask .vc-track").boundingBox();
  await main.mouse.move(trackBox.x + trackBox.width * 0.25, trackBox.y + trackBox.height / 2);
  await sleep(400);
  const hoverState = await main.evaluate(() => {
    const t = document.querySelector(".player-mask .vc-time");
    const f = document.querySelector(".player-mask .vc-frame");
    return {
      time: t?.textContent || "",
      frame: !!f,
      bg: (f && getComputedStyle(f).backgroundImage) || "",
      left: document.querySelector(".player-mask .vc-preview")
        ? getComputedStyle(document.querySelector(".player-mask .vc-preview")).left
        : "",
    };
  });
  check(
    "悬停进度条 → 帧画面出现（精灵图就绪）",
    hoverState.frame && hoverState.bg && !hoverState.bg.includes("none"),
    hoverState.bg.slice(0, 60)
  );
  check(
    "预览卡片含时间标签",
    hoverState.frame && /\d+:\d+/.test(hoverState.time),
    hoverState.time
  );

  await main.mouse.move(trackBox.x + trackBox.width * 0.75, trackBox.y + trackBox.height / 2);
  await sleep(300);
  const t2 = await main.evaluate(() => document.querySelector(".player-mask .vc-time")?.textContent || "");
  check("鼠标移动 → 预览时间实时变化", hoverState.time !== t2, `${hoverState.time} → ${t2}`);

  await main.screenshot({ path: `${SHOTS}/scrub-01-main-hover.png` });

  // ---------- 4. 点击 seek：currentTime 跳转（容差放宽，视频点击后仍继续播放会漂移） ----------
  const dur = ctrlState.dur;
  await main.mouse.click(trackBox.x + trackBox.width * 0.75, trackBox.y + trackBox.height / 2);
  await sleep(300);
  const tAfter = await main.evaluate(() => document.querySelector(".player-mask video")?.currentTime || 0);
  check(
    "点击进度条 75% → currentTime 跳到 75% 附近",
    tAfter > dur * 0.6 && tAfter < dur * 0.95,
    `t=${tAfter.toFixed(2)} dur=${dur.toFixed(2)}`
  );

  // ---------- 5. 播放/暂停 + 静音按钮 ----------
  const wasPaused = await main.evaluate(() => document.querySelector(".player-mask video")?.paused);
  await main.click(".player-mask .vc-btn"); // 播放或暂停
  await sleep(300);
  const pausedNow = await main.evaluate(() => document.querySelector(".player-mask video")?.paused);
  check("播放/暂停按钮切换生效", wasPaused !== pausedNow, `paused ${wasPaused} → ${pausedNow}`);

  // 恢复播放（若已暂停）
  if (pausedNow) {
    await main.click(".player-mask .vc-btn");
    await sleep(200);
  }
  const muteBtn = main.locator(".player-mask .vc-btn.small");
  await muteBtn.click();
  await sleep(200);
  const muted = await main.evaluate(() => document.querySelector(".player-mask video")?.muted);
  await muteBtn.click(); // 还原
  await sleep(200);
  check("静音按钮切换生效", muted === true, `muted=${muted}`);

  // ---------- 5b. r8 布局：进度条与主控件同一水平线、整体居中，不遮挡缩略条 ----------
  const layout = await main.evaluate(() => {
    const bar = document.querySelector(".player-mask .vc-bar");
    const track = document.querySelector(".player-mask .vc-track");
    const strip = document.querySelector(".player-mask .img-strip");
    const playBtn = document.querySelector(".player-mask .vc-btn");
    if (!bar || !track || !playBtn) return null;
    const b = bar.getBoundingClientRect();
    const t = track.getBoundingClientRect();
    const p = playBtn.getBoundingClientRect();
    const s = strip ? strip.getBoundingClientRect() : null;
    return {
      sameRow: Math.abs(t.top + t.height / 2 - (p.top + p.height / 2)) < 6,
      ratio: t.width / b.width,
      barBottom: getComputedStyle(bar).bottom,
      barBottomPx: Math.round(parseFloat(getComputedStyle(bar).bottom)),
      stripVisible: !!strip,
      overlap: s ? b.bottom > s.top + 2 : false,
      barBottomPos: b.bottom,
      stripTop: s ? s.top : null,
    };
  });
  check("布局采样成功（控制栏/进度条/缩略条齐全）", !!layout, JSON.stringify(layout));
  check(
    "进度条与主控件（播放键）同一水平线居中",
    !!layout && layout.sameRow && layout.ratio > 0.3 && layout.ratio < 0.9,
    `sameRow=${layout?.sameRow} ratio=${layout?.ratio.toFixed(3)}`
  );
  check(
    "队列 >1 时控制栏下移（bottom=76px，让位缩略条）",
    !!layout && layout.stripVisible && layout.barBottomPx === 76,
    `bottom=${layout?.barBottom} strip=${layout?.stripVisible}`
  );
  check(
    "控制栏不遮挡缩略图条",
    !!layout && !layout.overlap,
    `barBottom=${layout?.barBottomPos} stripTop=${layout?.stripTop}`
  );
  await main.screenshot({ path: `${SHOTS}/scrub-03-layout.png` });

  // ---------- 5c. 快退 / 快进 10 秒（暂停态测量，避免播放漂移） ----------
  await main.evaluate(() => { const v = document.querySelector(".player-mask video"); if (v && !v.paused) v.pause(); });
  await sleep(250);
  const btns = main.locator(".player-mask .vc-btn");
  const beforeRew = await main.evaluate(() => document.querySelector(".player-mask video")?.currentTime || 0);
  await btns.nth(1).click(); // 快退 10s
  await sleep(300);
  const afterRew = await main.evaluate(() => document.querySelector(".player-mask video")?.currentTime || 0);
  // mock 视频仅 5s：10s 快退会被夹到 0（真实长视频则恰好减 10s）
  check(
    "快退 10 秒生效",
    (beforeRew - afterRew > 3 && beforeRew - afterRew < 13.5) || afterRew === 0,
    `${beforeRew.toFixed(2)} → ${afterRew.toFixed(2)}`
  );
  const beforeFwd = afterRew;
  await btns.nth(2).click(); // 快进 10s
  await sleep(300);
  const afterFwd = await main.evaluate(() => document.querySelector(".player-mask video")?.currentTime || 0);
  const durNow = await main.evaluate(() => document.querySelector(".player-mask video")?.duration || 0);
  check(
    "快进 10 秒生效",
    (afterFwd - beforeFwd > 3 && afterFwd - beforeFwd < 13.5) || afterFwd >= durNow - 0.5,
    `${beforeFwd.toFixed(2)} → ${afterFwd.toFixed(2)} (dur=${durNow.toFixed(2)})`
  );

  // ---------- 5d. 倍速：预设 + 自定义（r8 滑动条 2.0–6.0 步长 0.25） ----------
  await main.evaluate(() => {
    document.querySelectorAll(".player-mask .vc-menu").forEach((m) => m.remove());
  });
  const rateBtn = main.locator(".player-mask .vc-btn.wide");
  await rateBtn.click();
  await sleep(250);
  const menuVisible = await main.evaluate(() => !!document.querySelector(".player-mask .vc-menu"));
  check("点击倍速按钮 → 菜单弹出", menuVisible);
  await main.evaluate(() => {
    const items = document.querySelectorAll(".player-mask .vc-menu-item");
    for (const it of items) if (it.textContent?.includes("1.5")) it.click();
  });
  await sleep(250);
  const rate15 = await main.evaluate(() => document.querySelector(".player-mask video")?.playbackRate || 0);
  check("倍速 1.5× 生效", Math.abs(rate15 - 1.5) < 0.01, `rate=${rate15}`);
  await rateBtn.click();
  await sleep(250);
  await main.evaluate(() => {
    const slider = document.querySelector(".player-mask .vc-rate-slider");
    if (slider) {
      slider.value = "3";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await sleep(250);
  const rate3 = await main.evaluate(() => document.querySelector(".player-mask video")?.playbackRate || 0);
  check("自定义倍速 3.0×（滑动条区间 2.0–6.0）生效", Math.abs(rate3 - 3) < 0.01, `rate=${rate3}`);
  // 还原倍速，点空白关闭菜单（Escape 会关播放器，不能用于关菜单）
  await main.evaluate(() => { document.querySelector(".player-mask video").playbackRate = 1; });
  await main.mouse.click(30, 300);
  await sleep(250);

  // ---------- 5e. 点击视频画面：暂停 / 继续（单击与双击全屏通过 230ms 延迟区分） ----------
  await main.evaluate(() => { const v = document.querySelector(".player-mask video"); if (v && v.paused) v.play().catch(() => {}); });
  await sleep(300);
  const videoBox = await main.locator(".player-mask video").boundingBox();
  const wasPlaying = await main.evaluate(() => !document.querySelector(".player-mask video")?.paused);
  await main.mouse.click(videoBox.x + videoBox.width * 0.5, videoBox.y + videoBox.height * 0.4);
  await sleep(500);
  const pausedAfterClick = await main.evaluate(() => document.querySelector(".player-mask video")?.paused);
  check("点击画面 → 暂停", wasPlaying && pausedAfterClick === true, `wasPlaying=${wasPlaying} paused=${pausedAfterClick}`);
  await main.mouse.click(videoBox.x + videoBox.width * 0.5, videoBox.y + videoBox.height * 0.4);
  await sleep(500);
  const playingAfterClick = await main.evaluate(() => !document.querySelector(".player-mask video")?.paused);
  check("再次点击画面 → 继续播放", playingAfterClick, `playing=${playingAfterClick}`);
  await main.evaluate(() => { const v = document.querySelector(".player-mask video"); if (!v.paused) v.pause(); });

  // ---------- 6. 全屏独立窗口（PiP）：同样自定义控制栏 + 悬停预览 ----------
  await main.click(".player-mask .fs-btn");
  await main.waitForFunction(() => !!window.__vtStore?.pipActive, null, { timeout: 8000 });
  const label = await main.evaluate(() => localStorage.getItem("__vt_pip_label"));
  const pip = await ctx.newPage();
  pip.on("pageerror", (e) => errors.push(`pip pageerror: ${e.message}`));
  await pip.goto(`${BASE}/pip.html?label=${encodeURIComponent(label)}`, { waitUntil: "domcontentloaded" });
  await pip.waitForSelector(".pip-body video", { timeout: 12000 });
  await pip.waitForFunction(
    () => {
      const v = document.querySelector(".pip-body video");
      return v && v.readyState >= 2 && v.duration > 0;
    },
    null,
    { timeout: 15000 }
  );
  await sleep(800);

  const pipCtrl = await pip.evaluate(() => {
    const v = document.querySelector(".pip-body video");
    return {
      native: v?.hasAttribute("controls") ?? null,
      bar: !!document.querySelector(".pip-body .vc-bar"),
      track: !!document.querySelector(".pip-body .vc-track"),
      // r6：全屏窗口内画中画按钮退化为「退出全屏」
      exitBtn: !!document.querySelector('.pip-body .vc-btn[title^="退出全屏"]'),
      rateBtn: !!document.querySelector(".pip-body .vc-btn.wide"),
    };
  });
  check(
    "PiP 无原生 controls + 有自定义控制栏",
    pipCtrl.native === false && pipCtrl.bar && pipCtrl.track,
    JSON.stringify(pipCtrl)
  );
  check(
    "PiP 有倍速按钮 + 画中画按钮为「退出全屏」",
    pipCtrl.rateBtn && pipCtrl.exitBtn,
    JSON.stringify(pipCtrl)
  );

  await sleep(1200); // 等精灵图轮询完成（帧卡片只在悬停后渲染）

  const ptBox = await pip.locator(".pip-body .vc-track").boundingBox();
  await pip.mouse.move(ptBox.x + ptBox.width * 0.5, ptBox.y + ptBox.height / 2);
  await sleep(400);
  const pipPrev = await pip.evaluate(() => {
    const t = document.querySelector(".pip-body .vc-time");
    const f = document.querySelector(".pip-body .vc-frame");
    return { time: t?.textContent || "", frame: !!f };
  });
  check(
    "PiP 悬停进度条 → 帧预览 + 时间标签",
    pipPrev.frame && /\d+:\d+/.test(pipPrev.time),
    pipPrev.time
  );
  await pip.screenshot({ path: `${SHOTS}/scrub-02-pip-hover.png` });

  // 悬停结束后预览消失（移出后）
  await pip.mouse.move(ptBox.x - 60, ptBox.y + ptBox.height / 2);
  await sleep(250);
  const pipGone = await pip.evaluate(() => !document.querySelector(".pip-body .vc-preview"));
  check("PiP 移出进度条 → 预览卡片消失", pipGone);

  await pip.evaluate(() => window.close?.());

  // ---------- 7. 关闭播放器，无控制台错误 ----------
  await main.evaluate(() => { window.__vtStore.modals.player = null; });
  await sleep(300);
  const realErrors = errors.filter((e) => !e.includes("favicon"));
  check("全程无页面错误/404", realErrors.length === 0, realErrors.join("; ").slice(0, 200));

  await browser.close();

  const pass = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok);
  console.log(`\n===== scrub 专项: ${pass}/${results.length} 通过 =====`);
  if (fail.length) {
    fail.forEach((f) => console.log(`  ✗ ${f.name}: ${f.detail}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("运行失败:", e);
  process.exit(2);
});
