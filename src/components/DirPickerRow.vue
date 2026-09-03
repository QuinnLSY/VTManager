<script setup lang="ts">
import { ref } from "vue";
import type { DirNode } from "../api";

defineOptions({ name: "DirPickerRow" });

const props = defineProps<{
  node: DirNode;
  depth: number;
  chosen: string;
  exclude: string[];
}>();

const emit = defineEmits<{ (e: "choose", p: string): void }>();

const open = ref(false);

function isExcluded(p: string): boolean {
  return props.exclude.some(
    (e) => p === e || p.startsWith(e + "/") || p.startsWith(e + "\\")
  );
}
</script>

<template>
  <div v-if="!isExcluded(node.path)">
    <div
      class="dp-row"
      :class="{ chosen: chosen === node.path }"
      :style="{ paddingLeft: depth * 16 + 10 + 'px' }"
      @click="emit('choose', node.path)"
    >
      <button
        v-if="node.children.length"
        class="dp-arrow"
        :class="{ open }"
        title="展开 / 收起子文件夹"
        @click.stop="open = !open"
      ></button>
      <span v-else style="width: 16px; flex-shrink: 0"></span>
      <span class="dp-ico">📁</span>
      <span class="dp-name">{{ node.name }}</span>
      <span class="dp-check" :class="{ on: chosen === node.path }">✓</span>
    </div>
    <template v-if="open">
      <DirPickerRow
        v-for="c in node.children"
        :key="c.path"
        :node="c"
        :depth="depth + 1"
        :chosen="chosen"
        :exclude="exclude"
        @choose="emit('choose', $event)"
      />
    </template>
  </div>
</template>

<style>
/* dp-* 样式供递归子行使用（Modal scoped 不穿透），此处全局定义、类名专用 */
.dp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 12px;
  margin: 2px 0;
  border: 1.5px solid transparent;
  border-radius: 10px;
  cursor: pointer;
  font-size: 13.5px;
  color: var(--text);
  transition: all 0.13s;
}
.dp-row:hover {
  background: var(--primary-soft);
  border-color: var(--primary);
}
.dp-row.chosen {
  background: var(--primary-soft);
  border-color: var(--primary);
  color: var(--primary-deep);
  font-weight: 600;
}
.dp-ico {
  flex-shrink: 0;
}
.dp-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dp-arrow {
  border: none;
  background: transparent;
  width: 16px;
  height: 16px;
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: transform 0.18s;
  transform: rotate(0deg);
}
.dp-arrow.open {
  transform: rotate(90deg);
}
.dp-arrow::after {
  content: "";
  display: block;
  border-style: solid;
  border-width: 5px 0 5px 7px;
  border-color: transparent transparent transparent var(--primary-deep);
}
.dp-check {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid var(--border-strong);
  background: transparent;
  color: transparent;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.15s;
}
.dp-check.on {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
</style>
