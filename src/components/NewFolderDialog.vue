<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../api";
import { refresh, store, toast } from "../store";

const name = ref("新建文件夹");

async function ok() {
  const n = name.value.trim();
  if (!n) return;
  try {
    await api.createDir(store.path, n);
    store.newFolder = false;
    await refresh();
    toast("文件夹已创建", "ok");
  } catch (e: any) {
    toast(String(e), "err");
  }
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") store.newFolder = false;
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="modal-mask" @click.self="store.newFolder = false">
    <div class="modal" style="width: 400px">
      <div class="modal-head">
        <div class="t">新建文件夹</div>
        <button class="x" @click="store.newFolder = false">✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>文件夹名称（创建在当前目录）</label>
          <input
            type="text"
            v-model="name"
            autofocus
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
        <button class="btn" @click="store.newFolder = false">取消</button>
        <button class="btn primary" @click="ok">创建</button>
      </div>
    </div>
  </div>
</template>
