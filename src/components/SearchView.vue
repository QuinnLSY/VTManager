<script setup lang="ts">
import { computed } from "vue";
import { fmtDate, fmtSize, type SearchResult } from "../api";
import { entryMenuFor, openResultDefault, openSearchResult, store } from "../store";

const groups = computed(() => {
  const g: Record<string, SearchResult[]> = { dir: [], video: [], image: [], other: [] };
  for (const r of store.searchResults) {
    if (r.is_dir) g.dir.push(r);
    else if (r.kind === "video") g.video.push(r);
    else if (r.kind === "image") g.image.push(r);
    else g.other.push(r);
  }
  return g;
});

const titles: Record<string, string> = {
  dir: "文件夹",
  video: "视频",
  image: "图片",
  other: "其他文件",
};

function icon(r: SearchResult): string {
  if (r.is_dir) return "📁";
  if (r.kind === "video") return "🎬";
  if (r.kind === "image") return "🖼";
  return "📄";
}

/** 视频/图片结果的真实缩略图（store.thumbs 由 doSearch 异步填充），无缩略图时回退 emoji */
function thumbOf(r: SearchResult): string | null {
  if (r.is_dir) return null;
  if (r.kind !== "video" && r.kind !== "image") return null;
  return store.thumbs[r.path] || null;
}

function openDefault(r: SearchResult) {
  // 与单击条目一致：跟随设置中的播放/查看方式（应用内预览 或 设置的默认应用）
  openResultDefault(r);
}
</script>

<template>
  <div>
    <template v-for="(items, key) in groups" :key="key">
      <div v-if="items.length" class="section-title">
        {{ titles[key as string] }} <span class="n">{{ items.length }}</span>
      </div>
      <div class="row-list">
        <div
          v-for="r in items"
          :key="r.path"
          class="row-item"
          @click="openSearchResult(r)"
          @contextmenu.prevent="entryMenuFor(r, $event.clientX, $event.clientY)"
          :title="r.path"
        >
          <div class="r-icon">
            <img v-if="thumbOf(r)" class="r-thumb" :src="thumbOf(r)" alt="" loading="lazy" decoding="async" />
            <span v-else>{{ icon(r) }}</span>
          </div>
          <div class="r-main">
            <div class="r-name">{{ r.name }}</div>
            <div class="r-path">{{ r.parent }}</div>
          </div>
          <div class="r-meta">
            {{ r.is_dir ? "" : fmtSize(r.size) }}{{ r.is_dir ? "" : " · " }}{{ fmtDate(r.created_ms) }}
          </div>
          <div class="r-actions" v-if="!r.is_dir">
            <button class="btn" @click.stop="openDefault(r)">打开</button>
          </div>
        </div>
      </div>
    </template>
    <div v-if="!store.searchResults.length" class="empty-state">
      <div class="icon">🔍</div>
      <p>没有匹配的结果 · 支持文件名任意片段、拼音及拼音首字母</p>
    </div>
  </div>
</template>
