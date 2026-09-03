<script setup lang="ts">
import { computed, watch } from "vue";
import type { Entry, SearchResult } from "../api";
import ItemCard from "./ItemCard.vue";
import {
  entryMenuFor,
  loadThumbs,
  navigate,
  openEntry,
  resultToEntry,
  starToggle,
  store,
  TAG_LABELS,
  toggleSelect,
} from "../store";

// 全库颜色标签浏览：仅显示「最高层」被标记对象——被标记文件夹内的子项由继承覆盖，不重复展开
const items = computed<Entry[]>(() =>
  store.tagResults.map((r: SearchResult) => ({
    ...resultToEntry(r),
    tag: store.tagFilter || null,
    modified_ms: r.created_ms,
  }))
);

const label = computed(() => TAG_LABELS[store.tagFilter] || store.tagFilter);

function onClick(e: Entry) {
  // 点文件夹进入该目录（退出标签浏览）；点文件直接打开
  if (e.is_dir) navigate(e.path);
  else openEntry(e);
}

function exitTag() {
  store.tagFilter = "";
  store.selection = [];
  store.view = "browse";
}

// 结果集变化（刷新/切换颜色）后补拉缩略图
watch(
  items,
  (list) => {
    loadThumbs(list);
  },
  { immediate: true }
);
</script>

<template>
  <div>
    <div class="section-title">
      「{{ label }}」色标签 · 全库
      <span class="n">{{ items.length }} 项（被标记文件夹内的内容按继承计入，不再单独展开）</span>
      <span style="flex: 1"></span>
      <button class="btn" @click="exitTag">返回原目录</button>
    </div>
    <div class="grid" @click.self="store.selection = []">
      <ItemCard
        v-for="e in items"
        :key="e.path"
        :entry="e"
        :selected="store.selection.includes(e.path)"
        :flashing="store.highlight === e.path"
        @click="onClick(e)"
        @context="entryMenuFor(e, $event.clientX, $event.clientY)"
        @dot="toggleSelect(e.path)"
        @star="starToggle(e, $event.clientX, $event.clientY)"
      />
    </div>
    <div v-if="!items.length" class="empty-state">
      <div class="icon">🏷</div>
      <p>还没有对象标记这个颜色 · 右键文件或文件夹可「标记颜色…」</p>
    </div>
  </div>
</template>
