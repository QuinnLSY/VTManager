<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api, type PipMedia, type PipPayload } from "../api";
// 必须显式 import：模板里用到的组件只有在 <script setup> 作用域里才能被解析。
// 缺失时 Vue 会把 <PiPVideo>/<PiPImage> 降级渲染成空标签（且 Rollup 会整体
// tree-shake 掉这两个文件）→ 独立全屏窗口里只剩黑底 = 黑屏。
import PiPVideo from "./PiPVideo.vue";
import PiPImage from "./PiPImage.vue";

// 独立画中画（PiP）窗口根组件：根据启动数据决定渲染视频播放器还是图片查看器。
// 与主窗口的 VideoPlayer/ImageViewer 共享交互模型，但去掉了文件信息/删除/关闭等头部
// 内容（仅保留与画面相关的全屏切换/上下一个按钮；图片含旋转、缩略图条、缩放）。
//
// 关闭窗口前把「当前索引 / 播放进度 / 旋转 / 缩放」回写给 Rust（set_pip_state），
// 主窗口在 pip-closed 时取回，据此从精确节点继续播放/查看。

const phase = ref<"loading" | "ready" | "error">("loading");
const errorMsg = ref("");
const payload = ref<PipPayload | null>(null);
const index = ref(0);

// 鼠标静止计时：视频/图片画面静止后控件淡出（与主窗口的 chrome 节奏一致）
const chromeVisible = ref(true);
let hideTimer: number | null = null;
let wake: () => void;
// 隐藏条件（视频播放中才隐藏；暂停/结束时常驻，与主窗口 useChrome 一致）
let hideCondition: () => boolean = () => true;

function setupChrome(condition: () => boolean, idleMs = 2600) {
  hideCondition = condition;
  wake = () => {
    chromeVisible.value = true;
    if (hideTimer) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (hideCondition()) chromeVisible.value = false;
    }, idleMs);
  };
}

function onLeave() {
  if (hideTimer) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (hideCondition()) chromeVisible.value = false;
  }, 600);
}

// 启动：从 URL 读取 label → 拉取启动数据
const url = new URL(window.location.href);
const label = url.searchParams.get("label") || "";

async function bootstrap() {
  // 应用全局日夜主题（存应用数据目录，与资料库无关）：
  // 独立窗口与主窗口共用同一份主题，切换资料库不受影响
  try {
    const t = await api.getPref("theme");
    document.documentElement.dataset.theme = t === "dark" ? "dark" : "light";
  } catch {
    /* 后端不可达时保持默认日间模式 */
  }
  if (!label) {
    phase.value = "error";
    errorMsg.value = "缺少窗口标签";
    return;
  }
  try {
    payload.value = await api.getPipPayload(label);
    index.value = Math.max(0, Math.min(payload.value.index, payload.value.list.length - 1));
    phase.value = "ready";
  } catch (e: any) {
    phase.value = "error";
    errorMsg.value = String(e?.message || e);
  }
}

const entry = computed<PipMedia | null>(() =>
  payload.value ? payload.value.list[index.value] || null : null
);

const isVideo = computed(() => payload.value?.kind === "video");

// ---------- 状态回写（主窗口退出全屏后据此续播/续看） ----------
const media = ref({ time: 0, rot: 0, scale: 1, tx: 0, ty: 0 });
let lastPush = 0;

function currentState() {
  return {
    index: index.value,
    time: Number.isFinite(media.value.time) ? media.value.time : 0,
    rot: Math.round(media.value.rot) || 0,
    scale: Number.isFinite(media.value.scale) && media.value.scale > 0 ? media.value.scale : 1,
    tx: Number.isFinite(media.value.tx) ? media.value.tx : 0,
    ty: Number.isFinite(media.value.ty) ? media.value.ty : 0,
  };
}

/** 立即回写一次（关闭窗口前必须调用，否则主窗口拿不到最新节点） */
async function pushState() {
  if (!label) return;
  lastPush = Date.now();
  try {
    await api.setPipState(label, currentState());
  } catch {
    /* 后端不可达时忽略：主窗口会退回自身记忆的节点 */
  }
}

/** 子组件上报画面状态（播放进度 / 旋转 / 缩放 / 平移）；节流回写防止高频 invoke */
function onMediaState(s: Partial<{ time: number; rot: number; scale: number; tx: number; ty: number }>) {
  Object.assign(media.value, s);
  const now = Date.now();
  if (now - lastPush > 500) void pushState();
}

/** 子组件请求退出 PiP：先落盘状态，再关闭窗口 */
async function onExit() {
  await pushState();
  try {
    await api.closePipWindow(label);
  } catch {
    /* ignore */
  }
}

/**
 * 子组件切换条目：子组件会直接改 payload.index（上一/下一、点击缩略图都是这条路），
 * 这里只需把本地 index 同步过来，并把新节点回写给 Rust。
 */
function onChildNav() {
  if (payload.value) index.value = payload.value.index;
  media.value.time = 0;
  void pushState();
  wake?.();
}

// 监听独立窗口的销毁事件：通知主窗口同步状态
onMounted(async () => {
  await bootstrap();
  // 隐藏条件与主窗口播放器保持一致（也和原生控件同一节奏）：
  //  - 视频：播放中才允许隐藏 —— 原生进度条/音量条此时同样会自动隐藏；
  //    暂停或播放结束时两者都常驻显示，避免"原生控件在、自定义按钮没了"
  //    （旧逻辑写成 `!__pipPlaying`，播放中反而不隐藏，正好相反）
  //  - 图片：没有原生控件，鼠标静止即隐藏
  setupChrome(() => {
    const v = document.querySelector("video") as HTMLVideoElement | null;
    return v ? !v.paused && !v.ended : true;
  });
  wake?.();
  // 用户主动关闭窗口（点系统 X）：尽力回写状态并清理 Rust 端 payload
  window.addEventListener("beforeunload", () => {
    if (label) {
      void pushState();
      api.closePipWindow(label).catch(() => {});
    }
  });
});
onBeforeUnmount(() => {
  if (hideTimer) window.clearTimeout(hideTimer);
});
</script>

<template>
  <div class="pip-root" @mousemove="wake?.()" @mouseleave="onLeave">
    <template v-if="phase === 'loading'">
      <div class="pip-fallback" style="margin: auto">
        <div class="big">⏳</div>
        <p>正在加载…</p>
      </div>
    </template>
    <template v-else-if="phase === 'error'">
      <div class="pip-fallback" style="margin: auto">
        <div class="big">⚠️</div>
        <p>{{ errorMsg }}</p>
      </div>
    </template>
    <template v-else-if="entry">
      <!-- 视频播放：原生 controls + 自定义 PiP 内交互（双击切换 / 全屏按钮 / 上下一个 / 缩略图条） -->
      <template v-if="isVideo">
        <PiPVideo
          :entry="entry"
          :payload="payload!"
          :index="index"
          :chrome-visible="chromeVisible"
          @nav="onChildNav"
          @state="onMediaState"
          @exit="onExit"
          @wake="wake?.()"
        />
      </template>
      <!-- 图片查看：缩放/旋转/平移 + 缩略图条 + 全屏切换。
           init-state 携带主窗口进入全屏时的旋转/缩放/平移快照（payload 随窗口打开传入），
           使全屏/非全屏始终共用同一画面变换状态 -->
      <template v-else>
        <PiPImage
          :entry="entry"
          :payload="payload!"
          :index="index"
          :chrome-visible="chromeVisible"
          :init-state="{
            rot: payload!.init_rot ?? 0,
            scale: payload!.init_scale ?? 1,
            tx: payload!.init_tx ?? 0,
            ty: payload!.init_ty ?? 0,
          }"
          @nav="onChildNav"
          @state="onMediaState"
          @exit="onExit"
          @wake="wake?.()"
        />
      </template>
    </template>
  </div>
</template>
