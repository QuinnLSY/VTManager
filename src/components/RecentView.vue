<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, assetUrl, fmtDate, fmtSize, type SearchResult } from "../api";
import { entryMenuFor, loadRecent, openResultDefault, openSearchResult, store } from "../store";

onMounted(async () => {
  await loadRecent();
  loadThumbs();
});

const thumbs = ref<Record<string, string>>({});

async function loadThumbs() {
  const items = store.recent;
  for (let i = 0; i < items.length; i += 8) {
    const chunk = items.slice(i, i + 8);
    try {
      const res = await api.getThumbs(
        chunk.map((r) => ({ path: r.path, is_dir: false, is_video: r.kind === "video" }))
      );
      for (const r of res) {
        if (r.thumb) thumbs.value[r.path] = assetUrl(r.thumb);
      }
    } catch {
      /* ignore */
    }
  }
}

function icon(r: { kind: string }): string {
  return r.kind === "video" ? "🎬" : "🖼";
}

function thumbOf(r: { path: string }): string | null {
  return thumbs.value[r.path] || null;
}

function openDefault(r: SearchResult) {
  // 与单击条目一致：跟随设置中的播放/查看方式（应用内预览 或 设置的默认应用）
  openResultDefault(r);
}
</script>

<template>
  <div>
    <div class="section-title">
      最近添加 <span class="n">{{ store.recent.length }} 项 · 按创建时间倒序</span>
    </div>
    <div class="row-list">
      <div
        v-for="r in store.recent"
        :key="r.path"
        class="row-item"
        :title="r.path"
        @click="openSearchResult(r)"
        @contextmenu.prevent="entryMenuFor(r, $event.clientX, $event.clientY)"
      >
        <img v-if="thumbOf(r)" class="r-thumb" :src="thumbOf(r)!" decoding="async" />
        <div v-else class="r-icon">{{ icon(r) }}</div>
        <div class="r-main">
          <div class="r-name">{{ r.name }}</div>
          <div class="r-path">{{ r.parent }}</div>
        </div>
        <div class="r-meta">{{ fmtSize(r.size) }} · {{ fmtDate(r.created_ms) }}</div>
        <div class="r-actions">
          <button class="btn" @click.stop="openDefault(r)">打开</button>
        </div>
      </div>
    </div>
    <div v-if="!store.recent.length" class="empty-state">
      <div class="icon">⏱</div>
      <p>暂无记录 · 「最近添加」依赖全盘索引，正在后台自动建立</p>
    </div>
  </div>
</template>

<style scoped>
.r-thumb {
  width: 44px;
  height: 36px;
  object-fit: cover;
  border-radius: 8px;
  flex-shrink: 0;
  background: var(--panel-2);
}
</style>
