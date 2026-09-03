<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { favCatSubmit, store } from "../store";

// 新建 / 重命名收藏夹分类（确认后才生效）
const m = store.favCatModal!;
const name = ref(m.mode === "rename" ? m.name : "");
const pending = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);

async function ok() {
  const n = name.value.trim();
  if (!n || pending.value) return;
  pending.value = true;
  try {
    await favCatSubmit(n);
  } finally {
    pending.value = false;
  }
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") store.favCatModal = null;
}
onMounted(() => {
  window.addEventListener("keydown", onKey);
  // WKWebView 下原生 autofocus 常不生效，显式聚焦保证 Enter 可直接提交
  inputEl.value?.focus();
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="modal-mask" @click.self="store.favCatModal = null">
    <div class="modal" style="width: 400px">
      <div class="modal-head">
        <div class="t">{{ m.mode === "create" ? "新建收藏分类" : "重命名分类" }}</div>
        <button class="x" @click="store.favCatModal = null">✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>分类名称</label>
          <input
            ref="inputEl"
            type="text"
            v-model="name"
            @keyup.enter="ok"
            style="
              width: 100%;
              height: 38px;
              border: 1px solid var(--border);
              border-radius: 9px;
              padding: 0 12px;
              font-size: 14px;
              font-family: var(--font);
              outline: none;
              background: var(--panel-2);
              color: var(--text);
            "
          />
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="store.favCatModal = null">取消</button>
        <button class="btn primary" :disabled="pending" @click="ok">
          {{ m.mode === "create" ? "创建" : "确认" }}
        </button>
      </div>
    </div>
  </div>
</template>
