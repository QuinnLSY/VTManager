<script setup lang="ts">
import { computed, ref } from "vue";
import type { FavCategory, FavoriteItem } from "../api";
import {
  loadRecent,
  loadTrash,
  locateEntry,
  navigate,
  parentDirOf,
  removeFavCategory,
  store,
  toggleFavorite,
  toggleTagFilter,
  toggleSidebar,
  toggleTheme,
  TAG_LABELS,
} from "../store";

// 收藏项点击：目录直接进入；单个文件定位到其所在目录（中线滚动 + 黄色闪烁）
function openFav(f: FavoriteItem) {
  if (f.is_dir) {
    navigate(f.path);
    return;
  }
  locateEntry(parentDirOf(f.path), f.path);
}

// ---------- 收藏夹分类 ----------
// 根目录收藏（cat_id=0）直接平铺；分类行左键展开/收起其下收藏，右键重命名/删除
const expanded = ref<number[]>([]);

const rootFavs = computed(() => store.favorites.filter((f) => !f.cat_id));
function catFavs(id: number): FavoriteItem[] {
  return store.favorites.filter((f) => f.cat_id === id);
}

function toggleCat(id: number) {
  const i = expanded.value.indexOf(id);
  if (i >= 0) expanded.value.splice(i, 1);
  else expanded.value.push(id);
}

function createCat() {
  store.favCatModal = { mode: "create" };
}

function catMenu(c: FavCategory, ev: MouseEvent) {
  store.ctx = {
    x: ev.clientX,
    y: ev.clientY,
    items: [
      {
        label: "重命名…",
        action: () => (store.favCatModal = { mode: "rename", id: c.id, name: c.name }),
      },
      { label: "删除分类", danger: true, action: () => removeFavCategory(c.id, c.name) },
    ],
  };
}

const TAGS = [
  { key: "red", label: "红" },
  { key: "orange", label: "橙" },
  { key: "yellow", label: "黄" },
  { key: "green", label: "绿" },
  { key: "blue", label: "蓝" },
  { key: "purple", label: "紫" },
];

function openSettings() {
  store.modals.settings = true;
}
</script>

<template>
  <aside class="sidebar">
    <!-- 收起按钮：与顶栏展开按钮同一位置（左上角对齐），主流 panel 图标、无背景 -->
    <button class="sb-toggle" title="收起侧边栏" @click="toggleSidebar()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
        <path d="M9.5 4.5v15" />
        <rect x="4.8" y="6.3" width="3.9" height="11.4" rx="1.4" fill="currentColor" stroke="none" />
      </svg>
    </button>
    <div class="logo">
      <img src="/app-icon.png" alt="logo" />
      <div>
        <div class="name">VTManager</div>
        <div class="ver">v{{ store.version }}</div>
      </div>
    </div>

    <button
      class="nav-item"
      :class="{ active: store.view === 'browse' }"
      @click="navigate(store.root)"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
      资料库
    </button>
    <button class="nav-item" :class="{ active: store.view === 'recent' }" @click="loadRecent">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 3" />
      </svg>
      最近添加
    </button>
    <button class="nav-item" :class="{ active: store.view === 'trash' }" @click="loadTrash">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13h10l1-13" />
      </svg>
      回收站
      <span class="count" v-if="store.trash.length">{{ store.trash.length }}</span>
    </button>
    <button class="nav-item" :class="{ active: store.modals.settings }" @click="openSettings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 1-1.55 1z" />
      </svg>
      设置
    </button>

    <div class="nav-section">标签筛选</div>
    <div style="display: flex; gap: 8px; padding: 2px 12px 6px; flex-wrap: wrap">
      <button
        v-for="t in TAGS"
        :key="t.key"
        class="side-tag"
        :class="[`tag-${t.key}`, { on: store.tagFilter === t.key }]"
        :title="`查看${t.label}色标签（全库，再点一次返回）`"
        @click="toggleTagFilter(t.key)"
      ></button>
    </div>
    <div v-if="store.tagFilter" style="padding: 0 12px 4px; font-size: 11px; color: var(--primary-deep)">
      正在查看「{{ TAG_LABELS[store.tagFilter] || store.tagFilter }}」色标签 · 再点一次返回
    </div>

    <!-- 收藏夹标题行：右侧「新建分类」图标（线条颜色与标题文字一致） -->
    <div class="nav-section fav-head">
      <span>收藏夹</span>
      <button class="fav-add" title="新建收藏分类" @click="createCat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <path d="M12 10.5v5M9.5 13h5" />
        </svg>
      </button>
    </div>

    <!-- 收藏主体：根目录收藏 + 分类及其展开的收藏，整体滚动（不把底部主题按钮顶走） -->
    <div class="fav-area">
      <div
        v-for="f in rootFavs"
        :key="f.path"
        class="fav-item"
        :title="f.path"
        @click="openFav(f)"
      >
        <img v-if="store.favThumbs[f.path]" class="fav-thumb" :src="store.favThumbs[f.path]" decoding="async" />
        <span v-else class="fav-thumb fav-thumb-ph">
          {{ f.is_dir ? "📁" : f.kind === "video" ? "🎬" : f.kind === "image" ? "🖼" : "📄" }}
        </span>
        <span class="fav-name">{{ f.name }}</span>
        <button class="remove-fav" title="取消收藏" @click.stop="toggleFavorite(f.path)">×</button>
      </div>

      <template v-for="c in store.favCats" :key="c.id">
        <div
          class="fav-cat"
          :class="{ open: expanded.includes(c.id) }"
          :title="expanded.includes(c.id) ? '点击收起该分类' : '点击展开该分类的收藏'"
          @click="toggleCat(c.id)"
          @contextmenu.prevent="catMenu(c, $event)"
        >
          <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 6l6 6-6 6" />
          </svg>
          <span class="fav-name">{{ c.name }}</span>
          <span class="cat-count" v-if="catFavs(c.id).length">{{ catFavs(c.id).length }}</span>
        </div>
        <template v-if="expanded.includes(c.id)">
          <div
            v-for="f in catFavs(c.id)"
            :key="f.path"
            class="fav-item fav-item-sub"
            :title="f.path"
            @click="openFav(f)"
          >
            <img v-if="store.favThumbs[f.path]" class="fav-thumb" :src="store.favThumbs[f.path]" decoding="async" />
            <span v-else class="fav-thumb fav-thumb-ph">
              {{ f.is_dir ? "📁" : f.kind === "video" ? "🎬" : f.kind === "image" ? "🖼" : "📄" }}
            </span>
            <span class="fav-name">{{ f.name }}</span>
            <button class="remove-fav" title="取消收藏" @click.stop="toggleFavorite(f.path)">×</button>
          </div>
          <div v-if="!catFavs(c.id).length" class="fav-cat-empty">该分类暂无收藏</div>
        </template>
      </template>

      <div v-if="!store.favorites.length && !store.favCats.length" class="fav-empty-hint">
        点击封面右上角的 ☆ 收藏
      </div>
    </div>

    <!-- 主题切换（归位到侧边栏底部，位于状态文字上方） -->
    <button
      class="theme-row"
      :title="store.settings.theme === 'dark' ? '切换为日间模式' : '切换为夜间模式'"
      @click="toggleTheme()"
    >
      <span class="ico">{{ store.settings.theme === "dark" ? "☀️" : "🌙" }}</span>
      <span>{{ store.settings.theme === "dark" ? "日间模式" : "夜间模式" }}</span>
    </button>

    <div class="sidebar-footer">
      <template v-if="store.scanRunning">🔍 正在建立索引… {{ store.scanCount }} 项</template>
      <template v-else>资源索引就绪 · 可全局模糊搜索</template>
    </div>
  </aside>
</template>
