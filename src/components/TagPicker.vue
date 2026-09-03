<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import { api } from "../api";
import { refresh, store, toast } from "../store";

const paths = computed(() => store.tagModal?.paths || []);

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") store.tagModal = null;
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));

const COLORS: { key: string; label: string }[] = [
  { key: "red", label: "红色" },
  { key: "orange", label: "橙色" },
  { key: "yellow", label: "黄色" },
  { key: "green", label: "绿色" },
  { key: "blue", label: "蓝色" },
  { key: "purple", label: "紫色" },
];

const current = computed(() => {
  const first = store.listing?.entries.find((e) => e.path === paths.value[0]);
  return first?.tag || null;
});

async function apply(color: string | null) {
  try {
    for (const p of paths.value) {
      await api.setTag(p, color);
    }
    toast(color ? "已标记颜色" : "已清除标签", "ok");
    store.tagModal = null;
    await refresh();
  } catch (e: any) {
    toast(String(e), "err");
  }
}
</script>

<template>
  <div class="modal-mask" @click.self="store.tagModal = null">
    <div class="modal" style="width: 380px">
      <div class="modal-head">
        <div class="t">
          标记颜色{{ paths.length > 1 ? `（${paths.length} 项）` : "" }}
        </div>
        <button class="x" @click="store.tagModal = null">✕</button>
      </div>
      <div class="modal-body">
        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px">
          <button
            v-for="c in COLORS"
            :key="c.key"
            class="tag-pick"
            :class="{ on: current === c.key && paths.length === 1 }"
            @click="apply(c.key)"
          >
            <span class="tag-dot-big" :class="`tag-${c.key}`"></span>
            <span>{{ c.label }}</span>
          </button>
        </div>
        <div style="text-align: center; margin-top: 16px">
          <button class="btn" @click="apply(null)">清除标签</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tag-pick {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 14px 8px;
  border: 1.5px solid var(--border);
  border-radius: 12px;
  background: var(--panel-2);
  color: var(--text);
  font-size: 12.5px;
  font-family: var(--font);
  cursor: pointer;
  transition: all 0.15s;
}
.tag-pick:hover {
  border-color: var(--primary);
  transform: translateY(-2px);
}
.tag-pick.on {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px rgba(62, 143, 214, 0.25);
}
.tag-dot-big {
  width: 26px;
  height: 26px;
  border-radius: 50%;
}
</style>
