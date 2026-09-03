<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api, fmtSize, type OrganizePlanItem } from "../api";
import { refresh, store, toast } from "../store";

const plan = ref<OrganizePlanItem[]>([]);
const loading = ref(true);
const applying = ref(false);
const done = ref(0);
const undoItems = ref<OrganizePlanItem[]>([]);

const dirName = computed(() => store.path.split(/[\\/]/).pop() || store.path);

const moveCount = computed(() => plan.value.filter((p) => !p.conflict).length);
const conflictCount = computed(() => plan.value.filter((p) => p.conflict).length);

async function load() {
  try {
    plan.value = await api.smartOrganizePlan(store.path);
  } catch (e: any) {
    toast(String(e), "err");
  } finally {
    loading.value = false;
  }
}
load();

async function apply(items: OrganizePlanItem[]) {
  applying.value = true;
  try {
    const n = await api.smartOrganizeApply(items);
    return n;
  } catch (e: any) {
    toast(String(e), "err");
    return 0;
  } finally {
    applying.value = false;
  }
}

async function run() {
  const items = plan.value.filter((p) => !p.conflict);
  if (!items.length) return;
  // 反向计划（撤销用）
  undoItems.value = items.map((p) => ({
    from: p.to,
    to: p.from,
    name: p.name,
    conflict: false,
  }));
  const n = await apply(items);
  if (n > 0) {
    done.value = n;
    toast(`已归类 ${n} 项`, "ok");
    await refresh();
  }
}

async function undo() {
  const n = await apply(undoItems.value);
  if (n > 0) {
    toast(`已撤销 ${n} 项`, "ok");
    undoItems.value = [];
    done.value = 0;
    await refresh();
    await load();
  }
}

function parentOf(p: string): string {
  return p.split("/").slice(0, -1).pop() || "";
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") store.organizeModal = false;
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="modal-mask" @click.self="store.organizeModal = false">
    <div class="modal wide">
      <div class="modal-head">
        <div class="t">照片/视频按日期智能归类 — {{ dirName }}</div>
        <button class="x" @click="store.organizeModal = false">✕</button>
      </div>
      <div class="modal-body">
        <div v-if="loading" style="text-align: center; color: var(--text-faint); padding: 30px">
          正在读取拍摄日期…
        </div>
        <template v-else>
          <div v-if="!done && !plan.length" style="text-align: center; color: var(--text-faint); padding: 26px; font-size: 13px">
            此目录没有可归类的照片/视频
          </div>

          <template v-if="!done">
            <div style="font-size: 13px; color: var(--text-sub); margin-bottom: 12px">
              将把 <b>{{ moveCount }}</b> 项按拍摄日期移动到
              <code>年份/年-月</code> 子文件夹{{ conflictCount ? `；另有 ${conflictCount} 项因目标重名将跳过` : "" }}。
              执行后可一键撤销。
            </div>
            <div class="plan-list">
              <div v-for="(p, i) in plan" :key="p.from" class="plan-row" :class="{ conflict: p.conflict }">
                <span class="plan-idx">{{ i + 1 }}</span>
                <div style="flex: 1; min-width: 0">
                  <div class="plan-name">{{ p.name }}</div>
                  <div class="plan-to">→ {{ parentOf(p.to) }}</div>
                </div>
                <span v-if="p.conflict" class="plan-conflict">重名跳过</span>
              </div>
            </div>
          </template>

          <div v-else style="text-align: center; padding: 30px">
            <div style="font-size: 34px; margin-bottom: 10px">🗂</div>
            <p style="font-size: 14px; margin-bottom: 18px">
              已归类 <b style="color: var(--primary-deep)">{{ done }}</b> 项
            </p>
            <button class="btn" :disabled="applying" @click="undo">↩ 撤销本次归类</button>
          </div>
        </template>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="store.organizeModal = false">
          {{ done ? "完成" : "取消" }}
        </button>
        <button
          v-if="!done"
          class="btn primary"
          :disabled="applying || !moveCount"
          @click="run"
        >
          {{ applying ? "归类中…" : `执行归类（${moveCount} 项）` }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plan-list {
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.plan-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  background: var(--panel-2);
  border-radius: 9px;
  font-size: 12.5px;
}
.plan-row.conflict {
  opacity: 0.55;
}
.plan-idx {
  color: var(--text-faint);
  width: 24px;
  text-align: right;
  flex-shrink: 0;
}
.plan-name {
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.plan-to {
  color: var(--primary-deep);
  font-size: 11.5px;
}
.plan-conflict {
  color: var(--warn);
  font-size: 11.5px;
  flex-shrink: 0;
}
</style>
