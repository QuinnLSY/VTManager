<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Entry } from "../api";
import ItemCard from "./ItemCard.vue";
import {
  clearSelection,
  entryMenuFor,
  movePaths,
  openEntry,
  sortedEntries,
  starToggle,
  store,
  toggleSelect,
} from "../store";

const sorted = computed(() =>
  store.listing ? sortedEntries(store.listing.entries) : []
);

// ---------- 虚拟滚动（1.0.1-r13） ----------
// 超大目录（>VIRTUAL_THRESHOLD 项）只渲染可视区域 ± 缓冲的卡片，滚动时动态替换，
// 大幅降低 DOM 节点数与内存占用；小目录保持原样渲染，行为零变化。
const VIRTUAL_THRESHOLD = 120;
const CARD_MIN_W = 158;
const GAP = 14;
const LABEL_H = 56; // 封面下方 label（名称+副信息）估算高度，取保守值防重叠
const BUFFER_ROWS = 2;

const useVirtual = computed(() => sorted.value.length > VIRTUAL_THRESHOLD);
const gridEl = ref<HTMLElement | null>(null);
const scrollEl = ref<HTMLElement | null>(null);
const startRow = ref(0);
const rows = ref(1);
const cols = ref(1);
const colW = ref(CARD_MIN_W);

const totalRows = computed(() => Math.ceil(sorted.value.length / cols.value));
const totalH = computed(() => totalRows.value * (colW.value + LABEL_H + GAP));
const visibleEntries = computed(() => {
  if (!useVirtual.value) return sorted.value;
  const s = startRow.value * cols.value;
  return sorted.value.slice(s, s + rows.value * cols.value);
});

function layout() {
  const sc = scrollEl.value;
  if (!sc) return;
  const W = sc.clientWidth - 44; // .content padding 22×2
  const c = Math.max(1, Math.floor((W + GAP) / (CARD_MIN_W + GAP)));
  cols.value = c;
  colW.value = Math.floor((W - GAP * (c - 1)) / c);
  const rowH = colW.value + LABEL_H + GAP;
  const top = sc.scrollTop;
  const r0 = Math.max(0, Math.floor(top / rowH) - BUFFER_ROWS);
  const rn = Math.ceil(sc.clientHeight / rowH) + BUFFER_ROWS * 2 + 1;
  startRow.value = r0;
  rows.value = Math.max(1, rn);
}

function onScroll() {
  if (useVirtual.value) layout();
}
function onResize() {
  layout();
}

onMounted(() => {
  const sc = gridEl.value?.closest(".content") as HTMLElement | null;
  if (sc) {
    scrollEl.value = sc;
    sc.addEventListener("scroll", onScroll, { passive: true });
  }
  window.addEventListener("resize", onResize);
  layout();
});
onBeforeUnmount(() => {
  scrollEl.value?.removeEventListener("scroll", onScroll);
  window.removeEventListener("resize", onResize);
});
// 目录切换/排序变化后重新布局（scrollTop 可能已在中间）
watch(() => store.listing?.path, () => nextTick(layout));
watch(useVirtual, (v) => {
  if (v) nextTick(layout);
});

// ---------- 点击：永远执行打开/播放（批量选择只能通过左上角圆圈） ----------
// 拖拽结束后吞掉紧随而来的 click，避免"拖回原卡"误触发打开
let suppressClick = false;

function onClick(entry: Entry) {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  openEntry(entry);
}

// ---------- 指针拖拽移动（不修改选中状态） ----------
const pending = ref<{ path: string; x: number; y: number } | null>(null);

function onDown(entry: Entry, ev: MouseEvent) {
  if (ev.button !== 0) return;
  pending.value = { path: entry.path, x: ev.clientX, y: ev.clientY };
}

function onMouseMove(ev: MouseEvent) {
  if (store.dragging) {
    store.dragging.x = ev.clientX;
    store.dragging.y = ev.clientY;
    return;
  }
  if (!pending.value) return;
  const dx = ev.clientX - pending.value.x;
  const dy = ev.clientY - pending.value.y;
  if (dx * dx + dy * dy > 36) {
    // 若被拖拽项本就在批量选区中，则整组一起拖；否则只拖它自己
    const paths = store.selection.includes(pending.value.path)
      ? [...store.selection]
      : [pending.value.path];
    store.dragging = { paths, x: ev.clientX, y: ev.clientY };
  }
}

function onMouseUp(ev: MouseEvent) {
  if (store.dragging) {
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const target = el?.closest("[data-drop-dir]") as HTMLElement | null;
    const dest = target?.dataset.dropDir;
    if (dest) {
      movePaths(store.dragging.paths, dest);
    }
    store.dragging = null;
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 120);
  }
  pending.value = null;
}

function isSelectedPath(p: string): boolean {
  return store.selection.includes(p);
}

onMounted(() => {
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
});
onBeforeUnmount(() => {
  window.removeEventListener("mousemove", onMouseMove);
  window.removeEventListener("mouseup", onMouseUp);
});

function emptyClick(ev: MouseEvent) {
  if (ev.target === ev.currentTarget) clearSelection();
}
</script>

<template>
  <!-- 虚拟滚动模式：外层撑总高，内层按滚动位置平移到可见区 -->
  <div v-if="useVirtual" ref="gridEl" class="grid-v">
    <div class="grid-v-inner" :style="{ height: totalH + 'px' }">
      <div
        class="grid-v-row"
        :style="{ transform: `translateY(${startRow * (colW + LABEL_H + GAP)}px)` }"
      >
        <ItemCard
          v-for="e in visibleEntries"
          :key="e.path"
          :entry="e"
          :selected="isSelectedPath(e.path)"
          :flashing="store.highlight === e.path"
          @click="onClick(e)"
          @context="entryMenuFor(e, $event.clientX, $event.clientY)"
          @down="onDown(e, $event)"
          @dot="toggleSelect(e.path)"
          @star="starToggle(e, $event.clientX, $event.clientY)"
        />
      </div>
    </div>
  </div>
  <div v-else class="grid" ref="gridEl" @click.self="emptyClick">
    <ItemCard
      v-for="e in sorted"
      :key="e.path"
      :entry="e"
      :selected="isSelectedPath(e.path)"
      :flashing="store.highlight === e.path"
      @click="onClick(e)"
      @context="entryMenuFor(e, $event.clientX, $event.clientY)"
      @down="onDown(e, $event)"
      @dot="toggleSelect(e.path)"
      @star="starToggle(e, $event.clientX, $event.clientY)"
    />
  </div>
  <div v-if="!sorted.length" class="empty-state">
    <div class="icon">🗂</div>
    <p>此目录为空 · 可从 Finder / 资源管理器拖入文件，或点击右上角「上传」</p>
  </div>
</template>
