<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

// 单按钮下拉式排序：按钮显示当前排序方式与方向，点击展开三项选择；
// 点击已选中项 = 切换正/倒序，点击其他项 = 按其记忆方向激活（方向由父级维护）。
// compact=true 时为分栏栏头的小尺寸形态（无外框）；默认形态与顶部栏 .btn 同高同边框。
// only="xxx" 时进入单选项模式（如时间轴只保留「时间」一项，点按钮即切方向）。
const props = defineProps<{
  active: string;
  dirs: Record<string, boolean>;
  compact?: boolean;
  only?: string;
}>();

const emit = defineEmits<{ (e: "select", key: string): void }>();

const ITEMS = [
  { k: "name", l: "名称" },
  { k: "created", l: "创建时间" },
  { k: "modified", l: "修改时间" },
  { k: "time", l: "时间" },
];

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});

const visibleItems = computed(() => (props.only ? ITEMS.filter((i) => i.k === props.only) : ITEMS));

function labelOf(k: string): string {
  const it = ITEMS.find((i) => i.k === k);
  return it ? it.l : "名称";
}
function arrowOf(k: string): string {
  return props.dirs[k] === false ? "↓" : "↑";
}
// 用 fixed 定位展开面板（左对齐按钮、正下方展开，越界时收进视口）：
// 栏头 overflow:hidden 会裁剪 absolute 面板，所以不用 absolute
function placeMenu() {
  const btn = rootEl.value ? (rootEl.value.querySelector(".sb-btn") as HTMLElement | null) : null;
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  const w = 150;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
  menuStyle.value = { left: `${left}px`, top: `${r.bottom + 6}px`, width: `${w}px` };
}
function toggleOpen() {
  // 单选项模式（如时间轴的「时间」）：点按钮直接切换方向，无需展开菜单
  if (props.only) {
    emit("select", props.only);
    return;
  }
  if (!open.value) placeMenu();
  open.value = !open.value;
}
function pick(k: string) {
  emit("select", k);
  open.value = false;
}
function onDocDown(e: Event) {
  if (!open.value || !rootEl.value) return;
  if (!(e.target instanceof Node)) return;
  // 菜单经 Teleport 挂在 body 下，点击菜单内部同样不算“外部”
  if (rootEl.value.contains(e.target)) return;
  if (menuEl.value && menuEl.value.contains(e.target)) return;
  open.value = false;
}
function onDismiss() {
  open.value = false;
}
onMounted(() => {
  document.addEventListener("pointerdown", onDocDown);
  window.addEventListener("scroll", onDismiss, true);
  window.addEventListener("resize", onDismiss);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocDown);
  window.removeEventListener("scroll", onDismiss, true);
  window.removeEventListener("resize", onDismiss);
});
</script>

<template>
  <div class="sort-bar" :class="{ compact }" ref="rootEl">
    <button
      class="sb-btn"
      :title="`当前按「${labelOf(active)} ${arrowOf(active)}」排序，点击更换`"
      @click="toggleOpen"
    >
      <span class="sb-cur">{{ labelOf(active) }}</span>
      <span class="sb-arr">{{ arrowOf(active) }}</span>
      <svg class="sb-caret" :class="{ up: open }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>

    <!-- Teleport 到 body：顶栏的 backdrop-filter 会让 fixed 定位相对它计算，必须逃出该包含块 -->
    <Teleport to="body">
      <div v-if="open" ref="menuEl" class="sb-menu" :style="menuStyle">
        <button
          v-for="it in visibleItems"
          :key="it.k"
          class="sb-opt"
          :class="{ on: active === it.k }"
          :title="active === it.k ? '再次点击切换正/倒序' : `按${it.l}${arrowOf(it.k)}排序`"
          @click="pick(it.k)"
        >
          <span class="sb-check">{{ active === it.k ? "✓" : "" }}</span>
          <span class="sb-opt-l">{{ it.l }}</span>
          <span class="sb-opt-dir" :class="{ dim: active !== it.k }">{{ arrowOf(it.k) }}</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.sort-bar {
  position: relative;
  display: inline-flex;
}
.sb-btn {
  border: 1px solid var(--border-strong);
  background: var(--panel);
  border-radius: 8px;
  height: 32px;
  padding: 0 9px;
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text);
  font-family: var(--font);
  transition: all 0.14s;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 5px;
}
.sb-btn:hover {
  background: var(--primary-soft);
  border-color: var(--primary);
  color: var(--primary-deep);
}
/* 分栏栏头紧凑形态：小高度、无外框（保持栏头原有的轻盈样式） */
.sort-bar.compact .sb-btn {
  height: 24px;
  padding: 0 7px 0 9px;
  border: none;
  background: rgba(255, 255, 255, 0.55);
  font-size: 11.5px;
  color: #4a3a3a;
  gap: 4px;
  border-radius: 7px;
}
.sort-bar.compact .sb-btn:hover {
  background: #fff;
  border-color: transparent;
  color: var(--primary-deep);
  box-shadow: 0 1px 5px rgba(46, 111, 176, 0.16);
}
.sb-cur {
  font-weight: 700;
  color: var(--primary-deep);
}
.sb-arr {
  font-size: 11px;
  color: var(--primary-deep);
}
.sb-caret {
  width: 11px;
  height: 11px;
  color: var(--text-faint);
  transition: transform 0.15s;
}
.sb-caret.up {
  transform: rotate(180deg);
}
.sb-menu {
  position: fixed;
  z-index: 210;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow-lg);
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  animation: sbIn 0.13s ease;
}
@keyframes sbIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.sb-opt {
  border: none;
  background: transparent;
  border-radius: 7px;
  height: 30px;
  padding: 0 9px;
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text-sub);
  font-family: var(--font);
  display: flex;
  align-items: center;
  gap: 6px;
  text-align: left;
}
.sb-opt:hover {
  background: var(--primary-soft);
  color: var(--primary-deep);
}
.sb-opt.on {
  color: var(--primary-deep);
  font-weight: 700;
}
.sb-check {
  width: 14px;
  flex-shrink: 0;
  font-size: 11.5px;
}
.sb-opt-l {
  flex: 1;
}
.sb-opt-dir {
  font-size: 11.5px;
  color: var(--primary-deep);
}
.sb-opt-dir.dim {
  opacity: 0.4;
}
[data-theme="dark"] .sort-bar.compact .sb-btn {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text);
}
[data-theme="dark"] .sort-bar.compact .sb-btn:hover {
  background: rgba(255, 255, 255, 0.18);
}
</style>
