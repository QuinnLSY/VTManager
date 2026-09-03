<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import { store } from "../store";

const menu = computed(() => store.ctx);

const posStyle = computed(() => {
  const c = store.ctx;
  if (!c) return { left: "0px", top: "0px" };
  const x = Math.max(4, Math.min(c.x, window.innerWidth - 200));
  const y = Math.max(4, Math.min(c.y, window.innerHeight - (c.items.length * 36 + 24)));
  return { left: x + "px", top: y + "px" };
});

function isSep(i: number): boolean {
  const it = menu.value?.items[i] as { sep?: boolean } | undefined;
  return !!(it && it.sep);
}
function label(i: number): string {
  const it = menu.value?.items[i] as { label?: string } | undefined;
  return it?.label || "";
}
function isDanger(i: number): boolean {
  const it = menu.value?.items[i] as { danger?: boolean } | undefined;
  return !!it?.danger;
}
function run(i: number) {
  const it = menu.value?.items[i] as { action?: () => void } | undefined;
  close();
  if (it?.action) it.action();
}

function close() {
  store.ctx = null;
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    // 捕获阶段消费掉，避免 App 层的全局 Esc 再清空批量选择
    e.stopPropagation();
    close();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", close);
  window.addEventListener("resize", close);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("blur", close);
  window.removeEventListener("resize", close);
});
</script>

<template>
  <div v-if="menu" class="ctx-mask" @click="close" @contextmenu.prevent="close">
    <div class="ctx-menu" :style="posStyle" @click.stop>
      <template v-for="(it, i) in menu.items" :key="i">
        <div v-if="isSep(i)" class="ctx-sep"></div>
        <div v-else class="ctx-item" :class="{ danger: isDanger(i) }" @click="run(i)">
          {{ label(i) }}
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ctx-mask {
  position: fixed;
  inset: 0;
  z-index: 199;
}
</style>
