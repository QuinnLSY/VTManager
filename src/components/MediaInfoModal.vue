<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api, fmtDate, fmtSize, type MediaInfo } from "../api";
import { openExternalWith, store } from "../store";

const info = ref<MediaInfo | null>(null);
const loading = ref(true);
const error = ref("");

const entry = computed(() => store.infoModal!);

onMounted(async () => {
  try {
    info.value = await api.mediaInfo(entry.value.path, entry.value.kind);
  } catch (e: any) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
});

function bitrate(n: number | null): string {
  if (!n) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} Mbps`;
  return `${Math.round(n / 1000)} kbps`;
}

function dur(s: number | null): string {
  if (!s) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s - h * 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") store.infoModal = null;
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="modal-mask" @click.self="store.infoModal = null">
    <div class="modal" style="width: 520px">
      <div class="modal-head">
        <div class="t">详细信息 — {{ entry.name }}</div>
        <button class="x" @click="store.infoModal = null">✕</button>
      </div>
      <div class="modal-body">
        <div v-if="loading" style="text-align: center; color: var(--text-faint); padding: 30px">
          正在读取媒体信息…
        </div>
        <div v-else-if="error" style="text-align: center; color: var(--danger); padding: 20px; font-size: 13px">
          {{ error }}
        </div>
        <template v-else-if="info">
          <table class="info-table">
            <tbody>
              <tr><td class="k">文件大小</td><td>{{ info.dir_size ? fmtSize(info.dir_size) : fmtSize(info.size) }}</td></tr>
              <tr><td class="k">创建时间</td><td>{{ fmtDate(info.created_ms) }}</td></tr>
              <tr><td class="k">修改时间</td><td>{{ fmtDate(info.modified_ms) }}</td></tr>
              <tr v-if="info.entry_count !== null && info.entry_count !== undefined">
                <td class="k">包含条目</td><td>{{ info.entry_count }} 项</td></tr>
              <tr v-if="info.width && info.height">
                <td class="k">尺寸</td><td>{{ info.width }} × {{ info.height }}</td>
              </tr>
              <tr v-if="info.duration">
                <td class="k">时长</td><td>{{ dur(info.duration) }}</td></tr>
              <tr v-if="info.container">
                <td class="k">容器 / 格式</td><td>{{ info.container }}</td></tr>
              <tr v-if="info.bitrate">
                <td class="k">总码率</td><td>{{ bitrate(info.bitrate) }}</td></tr>
            </tbody>
          </table>

          <!-- 视频轨道 -->
          <template v-if="info.tracks.length">
            <div class="sec">流信息</div>
            <table class="info-table">
              <tbody>
                <tr v-for="(t, i) in info.tracks" :key="i">
                  <td class="k">
                    {{ t.kind === "video" ? "视频轨" : t.kind === "audio" ? "音轨" : "字幕轨" }} {{ info.tracks.filter((x) => x.kind === t.kind).length > 1 ? info.tracks.filter((x) => x.kind === t.kind).indexOf(t) + 1 : "" }}
                  </td>
                  <td>{{ t.codec || "—" }} <span style="color: var(--text-faint)">{{ t.detail }}</span></td>
                </tr>
              </tbody>
            </table>
          </template>

          <!-- 图片 EXIF -->
          <template v-if="entry.kind === 'image'">
            <div class="sec">拍摄信息</div>
            <table class="info-table">
              <tbody>
                <tr v-if="info.camera"><td class="k">相机</td><td>{{ info.camera }}</td></tr>
                <tr v-if="info.lens"><td class="k">镜头</td><td>{{ info.lens }}</td></tr>
                <tr v-if="info.iso"><td class="k">感光度</td><td>{{ info.iso }}</td></tr>
                <tr v-if="info.aperture"><td class="k">光圈</td><td>{{ info.aperture }}</td></tr>
                <tr v-if="info.shutter"><td class="k">快门</td><td>{{ info.shutter }}</td></tr>
                <tr v-if="info.focal"><td class="k">焦距</td><td>{{ info.focal }}</td></tr>
                <tr v-if="info.taken_ms"><td class="k">拍摄时间</td><td>{{ fmtDate(info.taken_ms) }}</td></tr>
                <tr v-if="info.gps"><td class="k">GPS</td><td>{{ info.gps }}</td></tr>
              </tbody>
            </table>
          </template>
        </template>
      </div>
      <div class="modal-foot">
        <button
          v-if="entry.kind === 'video'"
          class="btn"
          @click="openExternalWith(entry.path, 'video')"
        >
          用默认播放器打开
        </button>
        <button class="btn primary" @click="store.infoModal = null">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.info-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.info-table td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
}
.info-table td.k {
  width: 110px;
  color: var(--text-faint);
}
.sec {
  font-size: 13px;
  font-weight: 700;
  color: var(--primary-deep);
  margin: 16px 0 8px;
}
</style>
