<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import { store } from "../store";

function cancel() {
  store.confirm = null;
}
function ok() {
  const c = store.confirm;
  store.confirm = null;
  c?.onOk();
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") cancel();
  if (e.key === "Enter") ok();
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <!-- 确认弹窗层级高于播放器/图片查看器：在播放中点击删除时直接置顶显示 -->
  <div class="modal-mask confirm-mask" @click.self="cancel">
    <div class="modal" style="width: 420px">
      <div class="modal-head">
        <div class="t">{{ store.confirm?.title }}</div>
        <button class="x" @click="cancel">✕</button>
      </div>
      <div class="modal-body">
        <div style="font-size: 13.5px; color: var(--text-sub); line-height: 1.9">
          {{ store.confirm?.message }}
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="cancel">取消</button>
        <button :class="store.confirm?.danger ? 'btn danger' : 'btn primary'" @click="ok">
          {{ store.confirm?.okText || (store.confirm?.danger ? "确认删除" : "确认") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.confirm-mask {
  z-index: 400;
}
</style>
