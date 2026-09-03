<script setup lang="ts">
import { onMounted, ref } from "vue";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { candidate, openLibrary, store, toast } from "../store";

const busy = ref(false);

onMounted(async () => {
  try {
    const info = await api.appInfo();
    store.version = info.version;
  } catch { /* ignore */ }
});

async function choose() {
  const dir = await dialogOpen({
    directory: true,
    multiple: false,
    title: "选择影视/图片所在的硬盘目录",
  });
  if (typeof dir === "string" && dir) {
    busy.value = true;
    try {
      await openLibrary(dir);
    } catch (e: any) {
      toast(String(e), "err");
    } finally {
      busy.value = false;
    }
  }
}

async function useCandidate() {
  const c = candidate();
  if (!c) return;
  busy.value = true;
  try {
    await openLibrary(c);
  } catch (e: any) {
    toast(String(e), "err");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="welcome">
    <div class="welcome-card">
      <img src="/app-icon.png" alt="VTManager" />
      <h1>VTManager</h1>
      <p class="desc">
        影视与图片的本地可视化管理工具<br />
        直接管理硬盘中的视频、海报与照片资源
      </p>
      <button class="btn primary" :disabled="busy" @click="choose">选择资料库目录</button>
      <button v-if="candidate()" class="btn" :disabled="busy" @click="useCandidate">
        打开检测到的硬盘库
      </button>
      <div v-if="store.initError" style="margin-top: 16px; color: var(--danger); font-size: 12.5px">
        {{ store.initError }}
      </div>
      <div class="welcome-tip">
        首次使用：选择存放影视与图片的硬盘目录（推荐直接选择移动硬盘根目录）。<br />
        应用会在该目录下创建 <b>.VTManager</b> 隐藏目录，用于存放封面缓存与配置，
        不会改动你的任何原始资源；把应用连同硬盘拷到其他电脑也能继续使用。
      </div>
    </div>
  </div>
</template>
