<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { api, assetUrl } from "../api";
import { refresh, store, toast } from "../store";

const entry = computed(() => store.modals.cover!);
const isVideo = computed(() => entry.value.kind === "video");
const tab = ref<"frame" | "upload">(isVideo.value ? "frame" : "upload");

// 截帧
const duration = ref(0);
const time = ref(0);
const previewPath = ref("");
const busy = ref(false);
const videoError = ref(false); // 浏览器无法解码时回退按钮截取流程

// 上传
const uploadPath = ref("");

const videoSrc = isVideo.value ? assetUrl(entry.value.path) : "";
const videoEl = ref<HTMLVideoElement | null>(null);

onMounted(async () => {
  if (isVideo.value) {
    try {
      const info = await api.videoInfo(entry.value.path);
      duration.value = info.duration || 0;
    } catch {
      /* ignore */
    }
  }
});

function fmtT(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// 滑块拖动 → 视频画面实时同步（拖到哪显示哪帧）
function onSliderInput() {
  const v = videoEl.value;
  if (v && isFinite(v.duration)) {
    try {
      v.currentTime = Math.min(time.value, Math.max(0, v.duration - 0.05));
    } catch {
      /* ignore */
    }
  }
}

async function capturePreview() {
  busy.value = true;
  try {
    previewPath.value = assetUrl(await api.captureFrame(entry.value.path, time.value));
  } catch (e: any) {
    toast(String(e), "err");
  } finally {
    busy.value = false;
  }
}

async function pickImage() {
  const f = await dialogOpen({
    multiple: false,
    title: "选择封面图片",
    filters: [
      { name: "图片", extensions: ["jpg", "jpeg", "png", "webp", "bmp", "gif", "tiff"] },
    ],
  });
  if (typeof f === "string" && f) uploadPath.value = f;
}

async function confirmFrame() {
  busy.value = true;
  try {
    await api.setCover(entry.value.path, {
      videoPath: entry.value.path,
      frameTime: time.value,
      source: "frame",
    });
    toast("封面已设置", "ok");
    store.modals.cover = null;
    await refresh();
  } catch (e: any) {
    toast(String(e), "err");
  } finally {
    busy.value = false;
  }
}

async function confirmUpload() {
  busy.value = true;
  try {
    await api.setCover(entry.value.path, { imagePath: uploadPath.value, source: "upload" });
    toast("封面已设置", "ok");
    store.modals.cover = null;
    await refresh();
  } catch (e: any) {
    toast(String(e), "err");
  } finally {
    busy.value = false;
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") store.modals.cover = null;
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="modal-mask" @click.self="store.modals.cover = null">
    <div class="modal">
      <div class="modal-head">
        <div class="t">设置封面 — {{ entry.name }}</div>
        <button class="x" @click="store.modals.cover = null">✕</button>
      </div>
      <div class="modal-body">
        <div class="tabs" v-if="isVideo">
          <button class="tab" :class="{ on: tab === 'frame' }" @click="tab = 'frame'">
            从视频截取画面
          </button>
          <button class="tab" :class="{ on: tab === 'upload' }" @click="tab = 'upload'">
            上传封面图片
          </button>
        </div>

        <!-- 截帧：视频画面实时同步滑块 -->
        <div v-if="tab === 'frame' && isVideo">
          <!-- 浏览器可解码：直接用 video 实时预览 -->
          <video
            v-if="!previewPath && !videoError"
            ref="videoEl"
            :src="videoSrc"
            style="width: 100%; border-radius: 10px; background: #000; max-height: 300px"
            muted
            @error="videoError = true"
          ></video>
          <!-- 无法解码（MKV 等）或已截取预览：显示 ffmpeg 截取帧或提示 -->
          <div
            v-if="previewPath || videoError"
            style="width: 100%; border-radius: 10px; background: #0a1930; max-height: 300px; min-height: 160px; display: flex; align-items: center; justify-content: center; overflow: hidden"
          >
            <img
              v-if="previewPath"
              :src="previewPath"
              style="max-width: 100%; max-height: 300px; object-fit: contain"
            />
            <div v-else style="text-align: center; color: #9db8d0; font-size: 12.5px; padding: 20px">
              该格式无法在应用内实时预览<br />请拖动滑块选择时间点后点击「截取预览」查看画面
            </div>
          </div>

          <div style="display: flex; align-items: center; gap: 12px; margin-top: 14px">
            <input
              type="range"
              min="0"
              :max="duration || 60"
              step="0.05"
              v-model.number="time"
              style="flex: 1; accent-color: var(--primary)"
              @input="onSliderInput"
            />
            <span style="font-size: 12.5px; color: var(--text-sub); width: 48px; text-align: center">
              {{ fmtT(time) }}
            </span>
            <button
              v-if="videoError"
              class="btn"
              :disabled="busy"
              @click="capturePreview"
            >
              截取预览
            </button>
          </div>
          <div class="hint" style="font-size: 11.5px; color: var(--text-faint); margin-top: 8px">
            拖动滑块时画面实时同步，选好位置后点击下方「使用此帧」（实际封面由 ffmpeg 按该时间点精确截取）。
          </div>
        </div>

        <!-- 上传 -->
        <div v-if="tab === 'upload'">
          <div
            style="
              border: 2px dashed var(--border-strong);
              border-radius: 12px;
              padding: 26px;
              text-align: center;
              color: var(--text-sub);
            "
          >
            <div v-if="!uploadPath">
              <div style="font-size: 30px; margin-bottom: 8px">🖼</div>
              <button class="btn primary" @click="pickImage">选择本地图片</button>
            </div>
            <template v-else>
              <img
                :src="assetUrl(uploadPath)"
                style="max-width: 100%; max-height: 260px; border-radius: 10px"
              />
              <div style="margin-top: 10px; font-size: 12px; color: var(--text-faint)">
                {{ uploadPath.split("/").pop() }}
                <button class="btn" style="margin-left: 8px" @click="pickImage">重新选择</button>
              </div>
            </template>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="store.modals.cover = null">取消</button>
        <button
          v-if="tab === 'frame' && isVideo"
          class="btn primary"
          :disabled="busy"
          @click="confirmFrame"
        >
          使用此帧作为封面
        </button>
        <button
          v-if="tab === 'upload'"
          class="btn primary"
          :disabled="busy || !uploadPath"
          @click="confirmUpload"
        >
          使用此图片作为封面
        </button>
      </div>
    </div>
  </div>
</template>
