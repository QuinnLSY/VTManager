<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type { Entry } from "../api";
import ItemCard from "./ItemCard.vue";
import SortBar from "./SortBar.vue";
import { assetUrl, fmtDate, fmtSize } from "../api";
import {
  entryMenuFor,
  filterByTag,
  isFavorite,
  movePaths,
  openEntry,
  starToggle,
  store,
  toggleSelect,
} from "../store";

interface ColDef {
  key: string;
  title: string;
  head: string; // 日间栏头底色
  headDark: string; // 夜间栏头底色
}

const COLS: ColDef[] = [
  { key: "dir", title: "文件夹", head: "#f8d7e3", headDark: "#3a2531" },
  { key: "video", title: "视频", head: "#d9ecd7", headDark: "#20392a" },
  { key: "image", title: "图片", head: "#faf0cf", headDark: "#3b3524" },
  { key: "other", title: "其他", head: "#e2e8ee", headDark: "#2a3441" },
];

const MIN_W = 168;

// 栏内排序（每栏独立：激活方式 + 三方式各自方向记忆）与栏内视图模式
const colSorts = reactive<Record<string, { active: string; dirs: Record<string, boolean> }>>(
  loadJson("vt_cols_sort2", {})
);
const colModes = reactive<Record<string, "grid" | "list">>(loadJson("vt_cols_mode", {}));

function sortOf(key: string): { active: string; dirs: Record<string, boolean> } {
  return (
    colSorts[key] || { active: "name", dirs: { name: true, created: true, modified: true } }
  );
}
function selectColSort(colKey: string, k: string) {
  const cur = sortOf(colKey);
  if (cur.active === k) cur.dirs[k] = !cur.dirs[k];
  else cur.active = k;
  colSorts[colKey] = { active: cur.active, dirs: { ...cur.dirs } };
  saveJson("vt_cols_sort2", { ...colSorts });
}
function sortEntriesWith(entries: Entry[], colKey: string): Entry[] {
  const s = sortOf(colKey);
  const dir = s.dirs[s.active] === false ? -1 : 1;
  const arr = [...entries];
  arr.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    let r = 0;
    if (s.active === "name") r = a.name.localeCompare(b.name, "zh-CN");
    else if (s.active === "created") r = a.created_ms - b.created_ms;
    else r = a.modified_ms - b.modified_ms;
    return r * dir;
  });
  return arr;
}

function loadJson(key: string, fallback: any): any {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key: string, val: any) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    /* ignore */
  }
}

function groups(key: string): Entry[] {
  const list =
    store.listing?.entries.filter((e) =>
      key === "dir"
        ? e.is_dir
        : key === "other"
          ? !e.is_dir && e.kind !== "video" && e.kind !== "image"
          : !e.is_dir && e.kind === key
    ) || [];
  return filterByTag(sortEntriesWith(list, key));
}

const visible = computed(() => COLS.filter((c) => groups(c.key).length > 0));

// 栏宽 = flex-grow 比例（flex-basis 0）。未记录的栏目默认 1 → 天然等分；
// 拖动只改变相邻两栏的 grow（此消彼长，总和守恒），因此：
//  - 进入/重进目录、栏目增减 → 清空记录回到等分
//  - 侧边栏收起/展开 → 容器宽度变化时比例自动等比缩放（flex 相对单位特性）
//  - 目录内容普通刷新（栏目集合不变）→ 保持用户已调好的比例
const widths = reactive<Record<string, number>>({});
function growOf(key: string): number {
  return widths[key] || 1;
}
function growStyle(key: string): string {
  return `flex: ${growOf(key)} 1 0%`;
}
function modeOf(key: string): "grid" | "list" {
  return colModes[key] || "grid";
}
function setMode(key: string, m: "grid" | "list") {
  colModes[key] = m;
  saveJson("vt_cols_mode", { ...colModes });
}

const keySig = computed(() => visible.value.map((c) => c.key).join("|"));
watch([() => store.path, keySig], () => {
  for (const k of Object.keys(widths)) delete widths[k];
  // 拖拽中列表被刷新（外部变更/轮询）导致栏目集合变化时，立即终止拖拽，避免越界
  if (dragState.value) {
    dragState.value = null;
    document.body.classList.remove("col-resizing");
  }
});

// 相邻栏边界拖动（pointer capture：指针划出分隔条也不丢事件）。
// 宽度重配规则：拖条直接相连的左栏独占增/减量；分界条右侧的所有分栏
// 按拖动前的宽度比例共同分摊反向变化量（≥3 栏时不再只挤压相邻一栏）。
const wrapEl = ref<HTMLElement | null>(null);
const dragState = ref<{
  li: number;
  l0: number;
  startX: number;
  pxPerGrow: number;
  minGrow: number;
  rightStart: { key: string; grow: number }[];
  rightSum0: number;
} | null>(null);

function onDividerDown(i: number, ev: PointerEvent) {
  if (i < 0 || i + 1 >= visible.value.length) return;
  const totalPx = wrapEl.value?.clientWidth || 0;
  const sumGrow = visible.value.reduce((s, c) => s + growOf(c.key), 0);
  if (totalPx <= 0 || sumGrow <= 0) return;
  // 扣除分隔条自身占宽（14px + 左右 margin 1px），保证拖拽 1:1 跟手
  const divTotal = (visible.value.length - 1) * 16;
  const pxPerGrow = (totalPx - divTotal) / sumGrow;
  const rightStart = visible.value
    .slice(i + 1)
    .map((c) => ({ key: c.key, grow: growOf(c.key) }));
  dragState.value = {
    li: i,
    l0: growOf(visible.value[i].key),
    startX: ev.clientX,
    pxPerGrow,
    minGrow: MIN_W / pxPerGrow,
    rightStart,
    rightSum0: rightStart.reduce((s, r) => s + r.grow, 0),
  };
  try {
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  } catch {
    /* ignore */
  }
  document.body.classList.add("col-resizing");
  ev.preventDefault();
}
function onDividerMove(ev: PointerEvent) {
  const d = dragState.value;
  if (!d) return;
  const lc = visible.value[d.li];
  if (!lc || d.rightStart.some((r, idx) => !visible.value[d.li + 1 + idx])) return;
  const raw = (ev.clientX - d.startX) / d.pxPerGrow;
  // 右侧各栏按比例共同伸缩，任何一栏都不得低于最小宽度；
  // 窄容器下左右下限可能冲突，此时收敛到两下限构成的区间（就近停住，不跳变）
  const scaleMin = Math.max(...d.rightStart.map((r) => d.minGrow / r.grow));
  const dMin = d.minGrow - d.l0; // 左栏最小宽度
  const dMax = d.rightSum0 * (1 - scaleMin); // 右侧整体最小宽度
  const lo = Math.min(dMin, dMax);
  const hi = Math.max(dMin, dMax);
  const dg = Math.max(lo, Math.min(hi, raw));
  widths[lc.key] = d.l0 + dg;
  const scale = (d.rightSum0 - dg) / d.rightSum0;
  for (const r of d.rightStart) widths[r.key] = r.grow * scale;
}
function onDividerUp(ev: PointerEvent) {
  if (!dragState.value) return;
  dragState.value = null;
  document.body.classList.remove("col-resizing");
  try {
    (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
  } catch {
    /* ignore */
  }
}
// ---------- 卡片/行交互（与网格视图一致） ----------
function isSelectedPath(p: string): boolean {
  return store.selection.includes(p);
}
let suppressClick = false;
function onClick(entry: Entry) {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  openEntry(entry);
}
const pending = ref<{ path: string; x: number; y: number } | null>(null);
function onDown(entry: Entry, ev: MouseEvent) {
  if (ev.button !== 0) return;
  pending.value = { path: entry.path, x: ev.clientX, y: ev.clientY };
}
function onMouseMoveDrag(ev: MouseEvent) {
  if (store.dragging) {
    store.dragging.x = ev.clientX;
    store.dragging.y = ev.clientY;
    return;
  }
  if (!pending.value) return;
  const dx = ev.clientX - pending.value.x;
  const dy = ev.clientY - pending.value.y;
  if (dx * dx + dy * dy > 36) {
    const paths = store.selection.includes(pending.value.path)
      ? [...store.selection]
      : [pending.value.path];
    store.dragging = { paths, x: ev.clientX, y: ev.clientY };
  }
}
function onMouseUpDrag(ev: MouseEvent) {
  if (store.dragging) {
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const target = el?.closest("[data-drop-dir]") as HTMLElement | null;
    const dest = target?.dataset.dropDir;
    if (dest) movePaths(store.dragging.paths, dest);
    store.dragging = null;
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 120);
  }
  pending.value = null;
}
onMounted(() => {
  window.addEventListener("mousemove", onMouseMoveDrag);
  window.addEventListener("mouseup", onMouseUpDrag);
});
onBeforeUnmount(() => {
  window.removeEventListener("mousemove", onMouseMoveDrag);
  window.removeEventListener("mouseup", onMouseUpDrag);
  // 卸载时可能正处于拖拽态（视图切换），恢复全局光标与文本选择
  document.body.classList.remove("col-resizing");
});

function thumbUrl(e: Entry): string | null {
  if (e.cover) return assetUrl(`${store.coversDir}/${e.cover}`);
  return store.thumbs[e.path] || null;
}
function subText(e: Entry): string {
  return `${e.is_dir ? fmtSize(e.dir_size || 0) : fmtSize(e.size)} · ${fmtDate(e.modified_ms)}`;
}
</script>

<template>
  <div class="columns-wrap" ref="wrapEl">
    <template v-for="(col, i) in visible" :key="col.key">
      <div
        v-if="i > 0"
        class="col-divider"
        :class="{ active: dragState && dragState.li === i - 1 }"
        title="左右拖动调整栏目宽度"
        @pointerdown="onDividerDown(i - 1, $event)"
        @pointermove="onDividerMove"
        @pointerup="onDividerUp"
        @pointercancel="onDividerUp"
      ><i class="col-grip"></i></div>

      <section
        class="col-panel"
        :style="growStyle(col.key)"
        :data-drop-dir="col.key === 'dir' ? store.path : undefined"
      >
        <header
          class="col-head"
          :style="{ background: store.settings.theme === 'dark' ? col.headDark : col.head }"
        >
          <span class="col-title">{{ col.title }}</span>
          <span class="col-count">{{ groups(col.key).length }}</span>
          <span style="flex: 1"></span>
          <SortBar
            compact
            :active="sortOf(col.key).active"
            :dirs="sortOf(col.key).dirs"
            @select="selectColSort(col.key, $event)"
          />
          <button
            class="col-mode-btn"
            :title="modeOf(col.key) === 'grid' ? '切换为列表' : '切换为封面'"
            @click="setMode(col.key, modeOf(col.key) === 'grid' ? 'list' : 'grid')"
          >
            {{ modeOf(col.key) === "grid" ? "☰" : "▦" }}
          </button>
        </header>

        <div class="col-body">
          <!-- 封面网格 -->
          <div v-if="modeOf(col.key) === 'grid'" class="col-grid">
            <ItemCard
              v-for="e in groups(col.key)"
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
          <!-- 列表（右侧缩略图） -->
          <div v-else class="col-list">
            <div
              v-for="e in groups(col.key)"
              :key="e.path"
              class="cl-row"
              :class="{ sel: isSelectedPath(e.path), flashing: store.highlight === e.path }"
              :data-drop-dir="e.is_dir ? e.path : undefined"
              :data-path="e.path"
              @click="onClick(e)"
              @contextmenu.prevent="entryMenuFor(e, $event.clientX, $event.clientY)"
              @mousedown="onDown(e, $event)"
              :title="e.path"
            >
              <button
                class="cl-dot"
                :class="{ on: isSelectedPath(e.path) }"
                @click.stop="toggleSelect(e.path)"
                @mousedown.stop
              ></button>
              <div class="cl-main">
                <div class="cl-name">{{ e.name }}</div>
                <div class="cl-sub">{{ subText(e) }}</div>
              </div>
              <img v-if="thumbUrl(e)" class="cl-thumb" :src="thumbUrl(e)!" loading="lazy" decoding="async" />
              <span v-else class="cl-thumb cl-thumb-ph">
                {{ e.is_dir ? "📁" : e.kind === "video" ? "🎬" : e.kind === "image" ? "🖼" : "📄" }}
              </span>
              <button
                class="cl-star"
                :class="{ on: isFavorite(e.path) }"
                :title="isFavorite(e.path) ? '取消收藏' : '收藏'"
                @click.stop="starToggle(e, $event.clientX, $event.clientY)"
                @mousedown.stop
              >
                {{ isFavorite(e.path) ? "★" : "☆" }}
              </button>
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.columns-wrap {
  display: flex;
  align-items: stretch;
  gap: 0;
  height: calc(100vh - var(--topbar-h) - 46px);
  min-height: 420px;
}
.col-divider {
  width: 14px;
  flex-shrink: 0;
  cursor: col-resize;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  margin: 0 1px;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
/* 链接式 grip：两枚竖向圆钮，平时几乎隐形，悬停/拖动浮现 */
.col-grip {
  display: block;
  width: 6px;
  height: 26px;
  border-radius: 4px;
  opacity: 0;
  transition: opacity 0.18s;
  background:
    radial-gradient(circle 2px, var(--primary) 2px, transparent 2.5px) 0 4px / 6px 6px no-repeat,
    radial-gradient(circle 2px, var(--primary) 2px, transparent 2.5px) 0 10px / 6px 6px no-repeat,
    radial-gradient(circle 2px, var(--primary) 2px, transparent 2.5px) 0 16px / 6px 6px no-repeat;
  pointer-events: none;
}
.col-divider:hover {
  background: var(--primary-soft);
}
.col-divider:hover .col-grip,
.col-divider.active .col-grip {
  opacity: 1;
}
.col-divider.active {
  background: var(--primary-soft);
}
.col-divider.active .col-grip {
  background:
    radial-gradient(circle 2.5px, var(--primary-deep) 2.5px, transparent 3px) 0 4px / 6px 6px no-repeat,
    radial-gradient(circle 2.5px, var(--primary-deep) 2.5px, transparent 3px) 0 10px / 6px 6px no-repeat,
    radial-gradient(circle 2.5px, var(--primary-deep) 2.5px, transparent 3px) 0 16px / 6px 6px no-repeat;
}
.col-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}
.col-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-weight: 700;
  font-size: 13px;
  color: #4a3a3a;
  flex-shrink: 0;
}
.col-title {
  letter-spacing: 1px;
}
.col-count {
  font-size: 11px;
  font-weight: 400;
  opacity: 0.7;
}
.col-mode-btn {
  border: none;
  background: rgba(255, 255, 255, 0.6);
  border-radius: 7px;
  width: 26px;
  height: 24px;
  cursor: pointer;
  font-size: 13px;
  color: #4a3a3a;
  transition: all 0.15s;
  padding: 0;
}
.col-mode-btn:hover {
  background: #fff;
  transform: scale(1.06);
}
.col-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  min-height: 0;
}
.col-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(138px, 1fr));
  gap: 10px;
}
.col-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cl-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 9px;
  cursor: pointer;
  transition: background 0.13s;
}
.cl-row:hover {
  background: var(--primary-soft);
}
.cl-row.sel {
  background: var(--primary-soft);
  outline: 1.5px solid var(--primary);
}
.cl-row.flashing {
  animation: cl-flash 1.6s ease 2;
}
@keyframes cl-flash {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(255, 193, 7, 0);
    outline: 1.5px solid rgba(255, 193, 7, 0);
  }
  40% {
    box-shadow: 0 0 0 4px rgba(255, 193, 7, 0.55);
    outline: 2px solid #ffc107;
  }
}
.cl-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--border-strong);
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
}
.cl-dot.on {
  background: var(--primary);
  border-color: var(--primary);
}
.cl-main {
  flex: 1;
  min-width: 0;
}
.cl-name {
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
}
.cl-sub {
  font-size: 10.5px;
  color: var(--text-faint);
  margin-top: 1px;
}
.cl-thumb {
  width: 44px;
  height: 32px;
  object-fit: cover;
  border-radius: 6px;
  flex-shrink: 0;
  background: var(--panel-2);
}
.cl-thumb-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
}
.cl-star {
  border: none;
  background: none;
  color: var(--text-faint);
  cursor: pointer;
  font-size: 14px;
  flex-shrink: 0;
  padding: 2px;
}
.cl-star.on {
  color: var(--warn);
}
.cl-star:hover {
  transform: scale(1.15);
}

/* 夜间模式适配 */
[data-theme="dark"] .col-head {
  color: var(--text);
}
[data-theme="dark"] .col-mode-btn {
  background: rgba(255, 255, 255, 0.12);
  color: var(--text);
}
[data-theme="dark"] .col-mode-btn:hover {
  background: rgba(255, 255, 255, 0.22);
}
</style>
