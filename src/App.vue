<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import Sidebar from "./components/Sidebar.vue";
import TopBar from "./components/TopBar.vue";
import FileGrid from "./components/FileGrid.vue";
import TimelineView from "./components/TimelineView.vue";
import SearchView from "./components/SearchView.vue";
import RecentView from "./components/RecentView.vue";
import TrashView from "./components/TrashView.vue";
import TagView from "./components/TagView.vue";
import Toasts from "./components/Toasts.vue";
import ContextMenu from "./components/ContextMenu.vue";
import VideoPlayer from "./components/VideoPlayer.vue";
import ImageViewer from "./components/ImageViewer.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import ColumnView from "./components/ColumnView.vue";
import Welcome from "./components/Welcome.vue";
// 1.0.2 弹窗组件代码分割：设置/刮削/归类等弹窗与高频核心组件分离，
// 首屏只加载核心包，弹窗首次打开时才按需加载对应 chunk（本地加载毫秒级）。
const CoverPicker = defineAsyncComponent(() => import("./components/CoverPicker.vue"));
const RenameDialog = defineAsyncComponent(() => import("./components/RenameDialog.vue"));
const TmdbDialog = defineAsyncComponent(() => import("./components/TmdbDialog.vue"));
const SettingsModal = defineAsyncComponent(() => import("./components/SettingsModal.vue"));
const DirPickerModal = defineAsyncComponent(() => import("./components/DirPickerModal.vue"));
const NewFolderDialog = defineAsyncComponent(() => import("./components/NewFolderDialog.vue"));
const FavCatDialog = defineAsyncComponent(() => import("./components/FavCatDialog.vue"));
const TagPicker = defineAsyncComponent(() => import("./components/TagPicker.vue"));
const MediaInfoModal = defineAsyncComponent(() => import("./components/MediaInfoModal.vue"));
const OrganizeModal = defineAsyncComponent(() => import("./components/OrganizeModal.vue"));
import { api, assetUrl } from "./api";
import {
  addFavoriteBatch,
  clearSelection,
  doSearch,
  hasModal,
  importPaths,
  init,
  initTheme,
  isFavorite,
  movePaths,
  openDirPicker,
  refresh,
  refreshScanStatus,
  setTagDialog,
  store,
  toast,
  trashConfirm,
  trashPaths,
  watchFullscreen,
} from "./store";

init();
initTheme(); // 全局主题（与资料库无关），启动时即应用
watchFullscreen();

// TMDB 海报地址直接是网络图片；目录封面来自本地 coversDir
function posterUrl(posterFile: string | null): string | null {
  return posterFile ? assetUrl(`${store.coversDir}/${posterFile}`) : null;
}

const meta = computed(() => store.listing?.meta || null);

// ---------- OS 拖入文件 ----------
let unlistenDrop: (() => void) | null = null;
let unlistenScan: (() => void) | null = null;
let unlistenFs: (() => void) | null = null;
let lastFsRefresh = 0;

onMounted(async () => {
  unlistenDrop = await getCurrentWebview().onDragDropEvent((ev: any) => {
    const p = ev.payload;
    if (p.type === "enter" || p.type === "over") {
      if (store.view === "browse") store.dropActive = true;
    } else if (p.type === "drop") {
      store.dropActive = false;
      if (store.view === "browse" && p.paths?.length) importPaths(p.paths);
    } else {
      store.dropActive = false;
    }
  });
  // 扫描完成后：若正在搜索视图则自动刷新结果
  unlistenScan = await listen("scan-done", () => {
    refreshScanStatus();
    if (store.view === "search" && store.query.trim()) doSearch(store.query);
  });
  // 外部（访达等）增删改 → 自动刷新当前目录（保留滚动位置）+ 索引节流重扫
  unlistenFs = await listen("fs-changed", async (ev: any) => {
    const now = Date.now();
    if (store.view === "browse" && store.ready && now - lastFsRefresh > 800) {
      lastFsRefresh = now;
      await silentRefresh();
    }
    // 索引节流重扫：空闲且距上次扫描超过 60 秒
    try {
      const s = await api.scanStatus();
      const last = s.last_scan || 0;
      if (!s.running && (!last || Date.now() - last > 60_000)) {
        await api.scanStart();
        refreshScanStatus();
      }
    } catch {
      refreshScanStatus();
      /* ignore */
    }
  });
  window.addEventListener("keydown", onKey);
  scanTimer = window.setInterval(refreshScanStatus, 2500);
  // 轮询兜底：外部变更事件万一丢失，每 8 秒静默刷新当前目录
  fsPollTimer = window.setInterval(() => {
    if (store.view === "browse" && store.ready && !document.hidden && now8ok()) {
      lastFsRefresh = Date.now();
      silentRefresh();
    }
  }, 8000);
});
onBeforeUnmount(() => {
  unlistenDrop?.();
  unlistenScan?.();
  unlistenFs?.();
  window.removeEventListener("keydown", onKey);
  if (scanTimer) clearInterval(scanTimer);
  if (fsPollTimer) clearInterval(fsPollTimer);
});

let scanTimer: any = null;
let fsPollTimer: any = null;
const contentEl = ref<HTMLElement | null>(null);

async function silentRefresh() {
  const el = contentEl.value;
  const st = el?.scrollTop || 0;
  await refresh();
  await nextTick();
  if (el) el.scrollTop = st;
}

function now8ok(): boolean {
  return Date.now() - lastFsRefresh > 7500;
}

// ---------- 全局键盘 ----------
function onKey(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName;
  const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  if (e.key === "Escape") {
    if (store.ctx) store.ctx = null;
    else if (hasModal()) {
      /* 各模态自行处理 */
    } else if (!inInput) clearSelection();
    return;
  }
  if (inInput || hasModal()) return;
  if ((e.key === "Backspace" || e.key === "Delete") && (store.view === "browse" || store.view === "tag") && store.selection.length) {
    e.preventDefault();
    trashConfirm(
      "批量删除",
      `确定将选中的 ${store.selection.length} 项移入回收站吗？删除后可在回收站中恢复。`,
      () => trashPaths([...store.selection])
    );
  } else if (e.key === "a" && (e.metaKey || e.ctrlKey) && (store.view === "browse" || store.view === "tag")) {
    e.preventDefault();
    if (store.view === "tag") {
      store.selection = store.tagResults.map((r) => r.path);
    } else if (store.listing) {
      store.selection = store.listing.entries.map((x) => x.path);
    }
  } else if (e.key === "Enter" && store.selection.length === 1 && store.listing) {
    const entry = store.listing.entries.find((x) => x.path === store.selection[0]);
    if (entry) {
      import("./store").then((s) => s.openEntry(entry));
    }
  }
}

// 批量操作条（浏览或标签视图中存在选中项即显示）
const batchBar = computed(
  () => (store.view === "browse" || store.view === "tag") && store.selection.length > 0
);

function batchDelete() {
  trashConfirm(
    "批量删除",
    `确定将选中的 ${store.selection.length} 项移入回收站吗？删除后可在回收站中恢复。`,
    () => trashPaths([...store.selection])
  );
}
function batchMove() {
  const paths = [...store.selection];
  openDirPicker(`移动 ${paths.length} 项到…`, (dest: string) => movePaths(paths, dest), {
    exclude: paths,
    confirmText: "移动到这里",
  });
}
function batchRename() {
  store.modals.rename = { paths: [...store.selection] };
}
function batchTag() {
  setTagDialog([...store.selection]);
}
/** 批量收藏：有分类时在按钮旁弹出分类选择（根目录置顶），无分类直接收藏到根目录 */
function batchFavorite(e: MouseEvent) {
  const paths = [...store.selection];
  const fresh = paths.filter((p) => !isFavorite(p));
  if (!fresh.length) {
    toast("所选项目均已收藏", "info");
    return;
  }
  if (!store.favCats.length) {
    addFavoriteBatch(fresh, 0);
    return;
  }
  store.ctx = {
    x: e.clientX,
    y: e.clientY,
    items: [
      { label: "收藏夹（根目录）", action: () => addFavoriteBatch(fresh, 0) },
      ...store.favCats.map((c) => ({ label: c.name, action: () => addFavoriteBatch(fresh, c.id) })),
    ],
  };
}
</script>

<template>
  <div class="app" v-if="store.ready">
    <Sidebar v-show="!store.sidebarCollapsed" />
    <div class="main">
      <TopBar />
      <div class="content" ref="contentEl" @click="store.ctx = null">
        <!-- 电影信息条 -->
        <div v-if="store.view === 'browse' && meta" class="meta-banner">
          <img v-if="posterUrl(meta.poster_file)" class="poster" :src="posterUrl(meta.poster_file)!" />
          <div style="flex: 1; min-width: 0">
            <div class="m-title">
              {{ meta.title || store.listing?.name }}
              <span v-if="meta.year" style="font-weight: 400; color: var(--text-faint)">
                （{{ meta.year }}）
              </span>
            </div>
            <div class="m-sub">
              <span class="stars" v-if="meta.rating">★ {{ meta.rating.toFixed(1) }}</span>
              <span v-if="meta.tmdb_id" style="margin-left: 8px">TMDB #{{ meta.tmdb_id }}</span>
            </div>
            <div class="m-overview">{{ meta.overview || "暂无剧情简介 · 可点击「重新刮削」补充" }}</div>
          </div>
          <div class="m-actions">
            <button class="btn" @click="store.modals.tmdb = store.path">重新刮削</button>
          </div>
        </div>

        <!-- 批量操作条（已移到底部：位于滚动容器之外，天然固定窗口底部） -->
        <template v-if="store.view === 'browse'">
          <ColumnView v-if="store.viewMode === 'columns'" />
          <TimelineView v-else-if="store.viewMode === 'timeline'" />
          <FileGrid v-else />
        </template>
        <SearchView v-else-if="store.view === 'search'" />
        <RecentView v-else-if="store.view === 'recent'" />
        <TagView v-else-if="store.view === 'tag'" />
        <TrashView v-else-if="store.view === 'trash'" />
      </div>
      <!-- 批量操作条：固定在文件列表底部（不随内容滚动），选中项>0 时出现 -->
      <div v-if="batchBar" class="batch-bar">
        <div class="bb-info">
          已选中 <b>{{ store.selection.length }}</b> 项 · 点击封面左上角圆圈可增减
        </div>
        <div class="bb-actions">
          <button class="btn" @click="batchRename">批量重命名</button>
          <button class="btn" @click="batchTag">标记颜色</button>
          <button class="btn" @click="batchFavorite($event)">批量收藏</button>
          <button class="btn" @click="batchMove">批量移动到…</button>
          <button class="btn danger" @click="batchDelete">批量删除</button>
          <button class="btn" @click="clearSelection">取消选择</button>
        </div>
      </div>
    </div>

    <!-- 悬浮层 -->
    <Toasts />
    <ContextMenu v-if="store.ctx" />
    <!-- 播放器/查看器：进入独立窗口全屏时**保持挂载**只隐藏（v-show），
         退出全屏时立即显示并从精确节点续播/续看，不重跑建流/转封装链路 -->
    <VideoPlayer v-if="store.modals.player" v-show="!store.pipActive" />
    <ImageViewer v-if="store.modals.viewer" v-show="!store.pipActive" />
    <CoverPicker v-if="store.modals.cover" />
    <RenameDialog v-if="store.modals.rename" />
    <TmdbDialog v-if="store.modals.tmdb" />
    <SettingsModal v-if="store.modals.settings" />
    <ConfirmDialog v-if="store.confirm" />
    <DirPickerModal v-if="store.dirPicker" />
    <NewFolderDialog v-if="store.newFolder" />
    <FavCatDialog v-if="store.favCatModal" />
    <TagPicker v-if="store.tagModal" />
    <MediaInfoModal v-if="store.infoModal" />
    <OrganizeModal v-if="store.organizeModal" />
    <div class="drop-overlay" v-if="store.dropActive">
      <div class="msg">⇩ 松开导入到当前目录</div>
    </div>
    <div
      class="drag-ghost"
      v-if="store.dragging"
      :style="{ left: store.dragging.x + 14 + 'px', top: store.dragging.y + 12 + 'px' }"
    >
      移动 {{ store.dragging.paths.length }} 项（拖到文件夹或面包屑上）
    </div>
  </div>
  <Welcome v-else />
</template>
