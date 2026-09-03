<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { api, type TmdbMovie } from "../api";
import { refresh, store, toast } from "../store";

// 刮削目标目录：由打开方传入（视频右键=其所在目录；目录信息条=当前目录）
const dir =
  typeof store.modals.tmdb === "string" && store.modals.tmdb ? store.modals.tmdb : store.path;
const dirName = dir.split(/[\\/]/).filter(Boolean).pop() || dir;
const query = ref(dirName.replace(/[._]/g, " "));
const results = ref<TmdbMovie[]>([]);
const searching = ref(false);
const applying = ref(0);

async function search() {
  if (!query.value.trim()) return;
  searching.value = true;
  results.value = [];
  try {
    results.value = await api.tmdbSearch(query.value.trim());
  } catch (e: any) {
    toast(String(e), "err");
  } finally {
    searching.value = false;
  }
}

async function apply(m: TmdbMovie) {
  applying.value = m.id;
  try {
    await api.tmdbApply(dir, m.id);
    toast(`已应用：《${m.title}》`, "ok");
    store.modals.tmdb = false;
    await refresh();
  } catch (e: any) {
    toast(String(e), "err");
  } finally {
    applying.value = 0;
  }
}

function onKey(e: KeyboardEvent) {
  // 确认弹窗打开时 Esc 只关确认层（与其他弹层守卫一致）
  if (store.confirm) return;
  if (e.key === "Escape") store.modals.tmdb = false;
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="modal-mask" @click.self="store.modals.tmdb = false">
    <div class="modal wide">
      <div class="modal-head">
        <div class="t">TMDB 电影信息匹配 — {{ dirName }}</div>
        <button class="x" @click="store.modals.tmdb = false">✕</button>
      </div>
      <div class="modal-body">
        <div style="display: flex; gap: 10px; margin-bottom: 16px">
          <input
            type="text"
            v-model="query"
            placeholder="输入电影名（支持中英文）"
            style="
              flex: 1;
              height: 36px;
              border: 1px solid var(--border);
              border-radius: 9px;
              padding: 0 12px;
              font-size: 13px;
              font-family: var(--font);
              outline: none;
            "
            @keyup.enter="search"
          />
          <button class="btn primary" :disabled="searching" @click="search">搜索</button>
        </div>

        <div v-if="searching" style="text-align: center; color: var(--text-faint); padding: 30px">
          正在搜索 TMDB…
        </div>

        <div v-if="!searching && !results.length" style="text-align: center; color: var(--text-faint); padding: 26px; font-size: 12.5px">
          匹配后会自动填充：中文片名、年份、评分、剧情简介，并将高清海报设为目录封面
        </div>

        <div
          v-for="m in results"
          :key="m.id"
          class="row-item"
          style="margin-bottom: 8px"
          @click="apply(m)"
        >
          <img
            v-if="m.poster_url"
            :src="m.poster_url"
            style="width: 44px; height: 64px; object-fit: cover; border-radius: 7px"
          />
          <div v-else class="r-icon">🎬</div>
          <div class="r-main">
            <div class="r-name">
              {{ m.title }}
              <span v-if="m.year" style="color: var(--text-faint); font-weight: 400">
                （{{ m.year }}）
              </span>
              <span class="stars" v-if="m.rating">★ {{ m.rating.toFixed(1) }}</span>
            </div>
            <div class="r-path">
              {{ m.original_title }}
              <template v-if="m.overview"> — {{ m.overview.slice(0, 80) }}…</template>
            </div>
          </div>
          <div class="r-actions">
            <button class="btn primary" :disabled="applying === m.id" @click.stop="apply(m)">
              {{ applying === m.id ? "应用中…" : "应用" }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
