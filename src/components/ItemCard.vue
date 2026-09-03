<script setup lang="ts">
import { computed } from "vue";
import { fmtSize, type Entry } from "../api";
import { coverUrl, isFavorite, store } from "../store";

const props = defineProps<{
  entry: Entry;
  selected: boolean;
  flashing: boolean;
}>();

const emit = defineEmits<{
  (e: "click", ev: MouseEvent): void;
  (e: "context", ev: MouseEvent): void;
  (e: "down", ev: MouseEvent): void;
  (e: "dot", ev: MouseEvent): void;
  (e: "star", ev: MouseEvent): void;
}>();

const url = computed(() => coverUrl(props.entry));

const iconFor = computed(() => {
  const k = props.entry.kind;
  if (k === "audio") return "audio";
  if (k === "doc") return "doc";
  return "file";
});

const subText = computed(() => {
  const e = props.entry;
  if (e.is_dir) {
    return e.dir_size && e.dir_size > 0 ? `文件夹 · ${fmtSize(e.dir_size)}` : "文件夹";
  }
  const d = new Date(e.modified_ms);
  const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${fmtSize(e.size)} · ${ds}`;
});
</script>

<template>
  <div
    class="card"
    :class="[entry.kind === 'image' ? 'img-card' : '', selected ? 'selected' : '', flashing ? 'highlight-flash' : '']"
    :data-drop-dir="entry.is_dir ? entry.path : undefined"
    :data-path="entry.path"
    @click="emit('click', $event)"
    @contextmenu.prevent="emit('context', $event)"
    @mousedown="emit('down', $event)"
    :title="entry.path"
  >
    <div class="cover">
      <img v-if="url" class="cover-img" :src="url" loading="lazy" decoding="async" alt="" />
      <span v-else class="ph-icon">
        <svg v-if="entry.is_dir" viewBox="0 0 24 24" fill="currentColor">
          <path d="M3 6a2 2 0 0 1 2-2h4.6a2 2 0 0 1 1.4.6L12.4 6H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        <svg v-else-if="entry.kind === 'video'" viewBox="0 0 24 24" fill="currentColor">
          <path d="M4 5h16a1.5 1.5 0 0 1 1.5 1.5v11A1.5 1.5 0 0 1 20 19H4a1.5 1.5 0 0 1-1.5-1.5v-11A1.5 1.5 0 0 1 4 5zm5.5 3.2v7.6l6.3-3.8z" />
        </svg>
        <svg v-else-if="entry.kind === 'image'" viewBox="0 0 24 24" fill="currentColor">
          <path d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm3.5 4a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6zM5 17h14l-4.5-6-3.5 4.5-2.5-3z" />
        </svg>
        <svg v-else-if="iconFor === 'audio'" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3z" />
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 1.5V8h4.5z" />
        </svg>
      </span>

      <div class="play-overlay" v-if="entry.kind === 'video'">
        <span class="play-btn-circle">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5.5v13l11-6.5z" />
          </svg>
        </span>
      </div>

      <span v-if="!entry.is_dir && entry.ext" class="ext-badge">{{ entry.ext }}</span>

      <!-- 彩色标签角标 -->
      <span v-if="entry.tag" class="tag-dot" :class="`tag-${entry.tag}`"></span>

      <!-- 批量选中圆圈 -->
      <button
        class="select-dot"
        :class="{ on: selected }"
        title="选中（批量操作）"
        @click.stop="emit('dot', $event)"
        @mousedown.stop
      ></button>

      <!-- 收藏星标（右上角） -->
      <button
        class="fav-star"
        :class="{ on: isFavorite(entry.path) }"
        :title="isFavorite(entry.path) ? '取消收藏' : '收藏'"
        @click.stop="emit('star', $event)"
        @mousedown.stop
      >
        <svg viewBox="0 0 24 24" :fill="isFavorite(entry.path) ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
          <path d="M12 3.2l2.7 5.6 6.1.86-4.4 4.3 1.05 6.1L12 17.2l-5.45 2.86 1.05-6.1-4.4-4.3 6.1-.86z" />
        </svg>
      </button>
    </div>

    <div class="label">
      <div class="name">{{ entry.name }}</div>
      <div class="sub">{{ subText }}</div>
    </div>
  </div>
</template>
