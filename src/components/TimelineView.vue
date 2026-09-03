<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { api, fmtDay, type PhotoDate } from "../api";
import { entryMenuFor, openEntry, starToggle, store, toggleSelect } from "../store";
import ItemCard from "./ItemCard.vue";

const dates = ref<Record<string, number>>({});
const loading = ref(true);

async function loadDates() {
  loading.value = true;
  try {
    if (store.path) {
      const res: PhotoDate[] = await api.mediaDates(store.path);
      const map: Record<string, number> = {};
      for (const r of res) {
        if (r.taken_ms) map[r.path] = r.taken_ms;
      }
      dates.value = map;
    }
  } catch {
    /* ignore */
  } finally {
    loading.value = false;
  }
}

// 时间轴专用排序：正序 = 最新在上（与网格视图的「创建时间↑」直觉相反，按需求约定）；
// 时间值 = 子文件夹创建时间 / 照片视频拍摄时间（回退修改时间），组间与组内同向排列
const groups = computed(() => {
  const list =
    store.listing?.entries.filter(
      (e) => e.is_dir || e.kind === "image" || e.kind === "video"
    ) || [];
  const newestFirst = store.timelineNewestFirst;
  const items = list.map((e) => ({
    e,
    ms: e.is_dir ? e.created_ms : dates.value[e.path] ?? e.modified_ms,
  }));
  items.sort((a, b) => (newestFirst ? b.ms - a.ms : a.ms - b.ms));
  const byDay = new Map<string, typeof items>();
  for (const it of items) {
    const key = fmtDay(it.ms);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(it);
  }
  return [...byDay.entries()].map(([day, its]) => [day, its.map((it) => it.e)] as const);
});

onMounted(loadDates);
// 切换目录后重新拉取拍摄日期（否则新目录静默退化为修改时间分组）
watch(() => store.path, () => {
  loadDates();
});
</script>

<template>
  <div v-if="loading" style="text-align: center; color: var(--text-faint); padding: 50px">
    正在读取媒体拍摄日期…
  </div>
  <template v-else>
    <div v-for="[day, items] in groups" :key="day" class="timeline-group">
      <div class="tl-date">
        {{ day }} <span class="n">{{ items.length }} 项</span>
      </div>
      <div class="grid">
        <ItemCard
          v-for="e in items"
          :key="e.path"
          :entry="e"
          :selected="store.selection.includes(e.path)"
          :flashing="store.highlight === e.path"
          @click="openEntry(e)"
          @context="entryMenuFor(e, $event.clientX, $event.clientY)"
          @dot="toggleSelect(e.path)"
          @star="starToggle(e, $event.clientX, $event.clientY)"
        />
      </div>
    </div>
    <div v-if="!groups.length" class="empty-state">
      <div class="icon">🖼</div>
      <p>此目录没有可展示的照片、视频或子文件夹</p>
    </div>
  </template>
</template>
