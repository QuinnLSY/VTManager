<script setup lang="ts">
import { computed, ref } from "vue";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import SortBar from "./SortBar.vue";
import {
  store,
  searchInput,
  selectGlobalSort,
  setViewMode,
  goUp,
  navigate,
  openDirPicker,
  openNewFolder,
  starToggle,
  toggleSidebar,
  toggleTimelineSort,
  TAG_LABELS,
  toast,
  refresh,
} from "../store";

const crumbs = computed(() => {
  if (!store.root || !store.path) return [];
  const rn = store.root.replace(/[\\/]+$/, "");
  const pn = store.path.replace(/[\\/]+$/, "");
  const norm = (s: string) => s.replace(/\\/g, "/");
  const out: { name: string; path: string }[] = [{ name: store.rootName, path: rn }];
  if (norm(pn) !== norm(rn) && norm(pn).startsWith(norm(rn) + "/")) {
    const rel = norm(pn).slice(norm(rn).length + 1);
    let acc = rn;
    for (const p of rel.split("/").filter(Boolean)) {
      acc = acc.replace(/\/$/, "") + "/" + p;
      out.push({ name: p, path: acc });
    }
  }
  return out;
});

const crumbsEl = ref<HTMLElement | null>(null);
const currentPath = computed(() => store.path);

// 滚轮纵向 → 面包屑横向滚动
function onWheel(e: WheelEvent) {
  const el = crumbsEl.value;
  if (!el) return;
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    el.scrollLeft += e.deltaY;
    e.preventDefault();
  }
}

const hasImages = computed(
  () => !!store.listing?.entries.some((e) => e.kind === "image")
);
const hasVideos = computed(
  () => !!store.listing?.entries.some((e) => e.kind === "video")
);
// 非 browse 视图的标题（标签浏览显示颜色名）
const specialTitle = computed(() => {
  if (store.view === "search") return `搜索「${store.query}」`;
  if (store.view === "recent") return "最近添加";
  if (store.view === "tag") return `「${TAG_LABELS[store.tagFilter] || store.tagFilter}」色标签 · 全库`;
  if (store.view === "trash") return "回收站";
  return store.rootName || "资料库";
});
async function upload() {
  // 第一步：选目标文件夹（默认当前目录）
  openDirPicker(
    "选择上传的目标文件夹",
    async (dest: string) => {
      // 第二步：选择要上传的文件
      const files = await dialogOpen({
        multiple: true,
        title: "选择要上传的视频或图片",
      });
      if (!files) return;
      const arr = Array.isArray(files) ? files : [files];
      try {
        const n = await api.copyEntries(arr, dest);
        toast(`已上传 ${n} 项到 ${dest.split(/[\\/]/).pop() || dest}`, "ok");
        await refresh();
      } catch (e: any) {
        toast(String(e), "err");
      }
    },
    { confirmText: "下一步：选择文件" }
  );
}
</script>

<template>
  <header class="topbar">
    <!-- 侧边栏收起时的展开按钮（位于顶栏流内，不遮挡路径） -->
    <button
      v-if="store.sidebarCollapsed"
      class="sb-toggle in-topbar"
      title="展开侧边栏"
      @click="toggleSidebar()"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
        <path d="M9.5 4.5v15" />
        <path d="M5.6 9.6 7.6 12l-2 2.4" fill="none" />
      </svg>
    </button>

    <!-- 返回上一级（固定在最左） -->
    <button
      v-if="store.view === 'browse' && store.listing?.parent"
      class="back-btn"
      title="返回上一级"
      @click="goUp"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 5l-7 7 7 7" />
      </svg>
    </button>

    <!-- 面包屑（可横向滚动） -->
    <div class="crumbs" v-if="store.view === 'browse' && store.listing" ref="crumbsEl" @wheel="onWheel">
      <template v-for="(c, i) in crumbs" :key="c.path">
        <span v-if="i > 0" class="crumb-sep">›</span>
        <span
          class="crumb"
          :class="{ current: i === crumbs.length - 1 }"
          :data-drop-dir="c.path"
          :title="c.path + '（双击收藏）'"
          @click="navigate(c.path)"
          @dblclick="starToggle(c, $event.clientX, $event.clientY)"
          >{{ c.name }}</span
        >
      </template>
    </div>
    <div class="crumbs" v-else>
      <span class="crumb current">{{ specialTitle }}</span>
    </div>

    <!-- 排序（单按钮下拉；置于视图切换左侧，出现/隐藏时由面包屑弹性吸收，视图切换位置不动） -->
    <div
      class="sort-box"
      v-if="store.view === 'browse' && store.viewMode !== 'columns'"
    >
      <!-- 时间轴视图：只保留「时间」一项，点击切换方向（正序=最新在上） -->
      <SortBar
        v-if="store.viewMode === 'timeline'"
        only="time"
        active="time"
        :dirs="{ time: store.timelineNewestFirst }"
        @select="toggleTimelineSort"
      />
      <SortBar
        v-else
        :active="store.sortState.active"
        :dirs="store.sortState.dirs"
        @select="selectGlobalSort"
      />
    </div>

    <!-- 视图切换（所有视图模式下可用） -->
    <div class="view-switch" v-if="store.view === 'browse'">
      <button
        class="vs-btn"
        :class="{ on: store.viewMode === 'grid' }"
        title="网格视图"
        @click="setViewMode('grid')"
      >
        ▦
      </button>
      <button
        class="vs-btn"
        :class="{ on: store.viewMode === 'timeline' }"
        title="时间轴视图（按拍摄/创建日期分组）"
        @click="setViewMode('timeline')"
      >
        ⏱
      </button>
      <button
        class="vs-btn"
        :class="{ on: store.viewMode === 'columns' }"
        title="分栏视图（文件夹｜视频｜图片聚合）"
        @click="setViewMode('columns')"
      >
        ▥
      </button>
    </div>

    <!-- 操作 -->
    <div style="display: flex; gap: 8px; flex-shrink: 0" v-if="store.view === 'browse'">
      <button class="btn" @click="openNewFolder">＋ 新建文件夹</button>
      <button class="btn primary" @click="upload">⇪ 上传</button>
      <button
        v-if="hasImages || hasVideos"
        class="btn"
        title="按拍摄日期把照片/视频归类到 年/年-月 子文件夹（可预览、可撤销）"
        @click="store.organizeModal = true"
      >
        智能归类
      </button>
    </div>

    <!-- 搜索 -->
    <div class="search-box">
      <span class="s-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </span>
      <input
        type="text"
        placeholder="模糊搜索全盘"
        :value="store.query"
        @input="searchInput(($event.target as HTMLInputElement).value)"
      />
      <button v-if="store.query" class="s-clear" @click="searchInput('')">✕</button>
    </div>
  </header>
</template>
