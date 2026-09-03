<script setup lang="ts">
import { computed, ref } from "vue";
import { api } from "../api";
import { refresh, store, toast } from "../store";

const paths = computed(() => store.modals.rename!.paths);
const batch = computed(() => paths.value.length > 1);

// 单个重命名
const origName = computed(() => paths.value[0]?.split("/").pop() || "");
const dot = computed(() => {
  const n = origName.value;
  const i = n.lastIndexOf(".");
  return i > 0 ? i : -1;
});
const stem = ref(origName.value.substring(0, dot.value >= 0 ? dot.value : undefined));
const ext = ref(dot.value >= 0 ? origName.value.substring(dot.value + 1) : "");

// 批量
const prefix = ref("");
const start = ref(1);
const pad = ref(2);

const batchPreview = computed(() =>
  paths.value.map((p, i) => {
    const name = p.split("/").pop() || "";
    const di = name.lastIndexOf(".");
    const e = di > 0 ? name.substring(di) : "";
    return `${prefix.value || "item"}${String(start.value + i).padStart(pad.value, "0")}${e}`;
  })
);

async function submitSingle() {
  const name = ext.value ? `${stem.value}.${ext.value}` : stem.value;
  try {
    await api.renameEntry(paths.value[0], name);
    toast("已重命名", "ok");
    store.modals.rename = null;
    await refresh();
  } catch (e: any) {
    toast(String(e), "err");
  }
}

async function submitBatch() {
  try {
    for (let i = 0; i < paths.value.length; i++) {
      const name = batchPreview.value[i];
      const p = paths.value[i];
      const parent = p.substring(0, p.lastIndexOf("/"));
      await api.renameEntry(p, name);
      void parent;
    }
    toast(`已批量重命名 ${paths.value.length} 项`, "ok");
    store.selection = [];
    store.modals.rename = null;
    await refresh();
  } catch (e: any) {
    toast(String(e), "err");
  }
}
</script>

<template>
  <div class="modal-mask" @click.self="store.modals.rename = null">
    <div class="modal" style="width: 460px">
      <div class="modal-head">
        <div class="t">{{ batch ? `批量重命名（${paths.length} 项）` : "重命名 / 修改格式" }}</div>
        <button class="x" @click="store.modals.rename = null">✕</button>
      </div>
      <div class="modal-body">
        <template v-if="!batch">
          <div class="field-row">
            <div class="field" style="flex: 2">
              <label>名称</label>
              <input type="text" v-model="stem" @keyup.enter="submitSingle" />
            </div>
            <div class="field" style="flex: 1">
              <label>扩展名（改格式）</label>
              <input type="text" v-model="ext" @keyup.enter="submitSingle" />
            </div>
          </div>
          <div class="hint" style="font-size: 11.5px; color: var(--text-faint)">
            原名：{{ origName }} · 修改扩展名即改变文件格式（如 jpg → png、txt → srt）
          </div>
        </template>
        <template v-else>
          <div class="field-row">
            <div class="field" style="flex: 2">
              <label>名称前缀</label>
              <input type="text" v-model="prefix" placeholder="例如：日本之旅" />
            </div>
            <div class="field">
              <label>起始序号</label>
              <input type="number" v-model.number="start" min="0" />
            </div>
            <div class="field">
              <label>序号位数</label>
              <input type="number" v-model.number="pad" min="1" max="6" />
            </div>
          </div>
          <div class="hint" style="font-size: 12px; margin-bottom: 6px">预览：</div>
          <div
            style="
              background: var(--panel-2);
              border-radius: 9px;
              padding: 10px 14px;
              font-size: 12px;
              color: var(--text-sub);
              max-height: 160px;
              overflow-y: auto;
              line-height: 1.9;
            "
          >
            <div v-for="(n, i) in batchPreview.slice(0, 30)" :key="i">
              {{ (paths[i].split("/").pop() || "") }} → <b style="color: var(--primary-deep)">{{ n }}</b>
            </div>
            <div v-if="paths.length > 30">…共 {{ paths.length }} 项</div>
          </div>
        </template>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="store.modals.rename = null">取消</button>
        <button v-if="!batch" class="btn primary" @click="submitSingle">确定</button>
        <button v-else class="btn primary" @click="submitBatch">执行批量重命名</button>
      </div>
    </div>
  </div>
</template>
