<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { api, type DirNode } from "../api";
import { store, toast } from "../store";
import DirPickerRow from "./DirPickerRow.vue";

const tree = ref<DirNode[]>([]);
const loading = ref(true);
const chosen = ref(store.root); // 默认选定根目录
const rootLabel = ref(store.rootName);

async function load() {
  try {
    tree.value = await api.dirTree();
  } catch (e: any) {
    toast(String(e), "err");
  } finally {
    loading.value = false;
  }
}
load();

function cancel() {
  store.dirPicker = null;
}
function ok() {
  if (!chosen.value) {
    toast("请先选择一个目标文件夹", "err");
    return;
  }
  const dp = store.dirPicker;
  store.dirPicker = null;
  dp?.onOk(chosen.value);
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") cancel();
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="modal-mask" @click.self="cancel">
    <div class="modal" style="width: 500px; height: 62vh">
      <div class="modal-head">
        <div class="t">{{ store.dirPicker?.title }}</div>
        <button class="x" @click="cancel">✕</button>
      </div>
      <div class="modal-body" style="height: calc(100% - 110px); overflow-y: auto">
        <div v-if="loading" style="text-align: center; color: var(--text-faint); padding: 24px">
          正在读取目录…
        </div>
        <template v-else>
          <!-- 资料库根目录 -->
          <div
            class="dp-row"
            :class="{ chosen: chosen === store.root }"
            style="padding-left: 10px"
            @click="chosen = store.root"
          >
            <span class="dp-ico">🏠</span>
            <span class="dp-name">{{ rootLabel }}（根目录）</span>
            <span class="dp-check" :class="{ on: chosen === store.root }">✓</span>
          </div>
          <DirPickerRow
            v-for="n in tree"
            :key="n.path"
            :node="n"
            :depth="1"
            :chosen="chosen"
            :exclude="store.dirPicker?.exclude || []"
            @choose="chosen = $event"
          />
        </template>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="cancel">取消</button>
        <button class="btn primary" @click="ok">{{ store.dirPicker?.confirmText || "确认移动到这里" }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
/* 深蓝实心三角，无外框 */
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
