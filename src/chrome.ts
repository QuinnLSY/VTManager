// 播放器 / 图片查看器共享的「控件伴随即隐」逻辑：
// 鼠标移动浮现，播放中静止 idleMs 后隐藏；离开界面区域、暂停/结束时保持显示。
// 与原生播放控件的显隐节奏一致，避免自定义按钮/头部长期遮挡内容。
import { ref } from "vue";

export function useChrome(idleMs = 2600) {
  const chromeVisible = ref(true);
  let hideTimer: number | null = null;

  /** 鼠标活动 / 需要强制展示时调用 */
  function wake() {
    chromeVisible.value = true;
    if (hideTimer) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (shouldHide()) chromeVisible.value = false;
    }, idleMs);
  }

  /** 子组件定义隐藏条件（如视频正在播放）；默认始终允许隐藏 */
  let shouldHide: () => boolean = () => true;

  function setHideCondition(fn: () => boolean) {
    shouldHide = fn;
  }

  /** 鼠标离开界面区域：短暂延迟后隐藏（给划出再划回留余地） */
  function onLeave() {
    if (hideTimer) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (shouldHide()) chromeVisible.value = false;
    }, 600);
  }

  /** 立即恢复显示（暂停/结束/切换内容时） */
  function reveal() {
    chromeVisible.value = true;
    if (hideTimer) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (shouldHide()) chromeVisible.value = false;
    }, idleMs);
  }

  function dispose() {
    if (hideTimer) window.clearTimeout(hideTimer);
    hideTimer = null;
  }

  return { chromeVisible, wake, reveal, onLeave, setHideCondition, dispose };
}

/**
 * 缩略图条滚轮横滚（主窗播放器 / 图片查看器 + PiP 双端共用）：
 * 鼠标悬停条带时转动滚轮即「前后浏览」条带内容——纵向滚轮 deltaY 转成条带横向滚动，
 * 触控板横向手势 deltaX 直接沿用（取绝对值更大的一轴，避免斜向手势抖动）。
 * 条带已滚到两端（scrollLeft 无变化）时不拦截事件，交回浏览器/父级处理。
 * 注意：必须在条带自身监听（父级的图片缩放 wheel 会用 .img-strip / .pip-strip 早退让行）。
 * @returns 是否消费了该事件（消费时调用方应 wake，避免滚动过程中控件提前隐去）
 */
export function stripWheelScroll(e: WheelEvent, el: HTMLElement | null): boolean {
  if (!el) return false;
  // deltaMode：0=像素 1=行（Firefox）2=页；统一折算为像素
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? Math.max(1, el.clientWidth) : 1;
  const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  const delta = raw * unit;
  if (!delta) return false;
  const before = el.scrollLeft;
  el.scrollLeft = before + delta;
  if (el.scrollLeft === before) return false; // 到头：不吞事件
  e.preventDefault();
  return true;
}

// ---------- 长按 → 临时 2× 当前倍速（1.0.2-r10，主窗播放器 / PiP 共用） ----------
// 按住右方向键约 HOLD_BOOST_MS 判定为「长按」：进入当前倍速的 2 倍速
// （1×→2×、1.5×→3×…，上限 6×），松开恢复原倍速；判定窗内松开视为「短按」，
// 交回调用方原有语义（切下一个视频）——短按行为不变，仅触发时机从 keydown
// 延后到 keyup（否则长按会先误触发一次短按语义）。
export const HOLD_BOOST_MS = 400;
const MAX_RATE = 6;

export interface HoldBoostCtx {
  video: () => HTMLVideoElement | null;
  hud: (t: string) => void;
  /** 判定窗内松开 = 短按：执行调用方原有的右方向键短按行为 */
  tap: () => void;
}

export function useHoldBoost(ctx: HoldBoostCtx) {
  let timer: number | undefined;
  let active = false;
  let baseRate = 1;

  const fmt = (r: number) => String(Math.round(r * 100) / 100).replace(/\.?0+$/, "");

  /** ArrowRight keydown（组件自行排除 VIDEO 元素聚焦等需让位的场景） */
  function down() {
    if (timer !== undefined || active) return;
    if (!ctx.video()) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      const v = ctx.video();
      if (!v) return;
      baseRate = Math.round(v.playbackRate * 100) / 100;
      const boost = Math.min(MAX_RATE, Math.round(baseRate * 2 * 100) / 100);
      active = true;
      v.playbackRate = boost; // ratechange → VideoControls 同步显示
      ctx.hud(`⏩ ${fmt(boost)}×`);
    }, HOLD_BOOST_MS);
  }

  /** ArrowRight keyup：判定窗内=短按（原语义），否则=长按结束恢复原倍速 */
  function up() {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
      ctx.tap();
      return;
    }
    if (!active) return;
    active = false;
    const v = ctx.video();
    if (v && Math.round(v.playbackRate * 100) !== Math.round(baseRate * 100)) {
      v.playbackRate = baseRate;
    }
    ctx.hud(`⏱ ${fmt(baseRate)}×`);
  }

  /** 切换条目 / 关闭播放器时复位：中止未决判定并撤销加速，防状态悬挂 */
  function reset() {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    if (active) {
      active = false;
      const v = ctx.video();
      if (v) v.playbackRate = baseRate;
    }
  }

  return { down, up, reset };
}
