<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api, assetUrl, fmtDate, fmtSize, isVideoName } from "../api";
import { confirmAction, deleteForever, emptyTrash, loadTrash, restoreTrash, store, trashTtlDays } from "../store";

onMounted(async () => {
  await loadTrash();
  loadThumbs();
  tickTimer = window.setInterval(() => (nowTick.value = Date.now()), 60_000);
});
onBeforeUnmount(() => {
  if (tickTimer) window.clearInterval(tickTimer);
});

const nowTick = ref(Date.now());
let tickTimer: number | undefined;

// 1.0.2-r6：到期时间展示（expire_at 为毫秒时间戳，0 = 永不自动清除）
function expireText(t: { expire_at: number }): string {
  if (!t.expire_at) return "永不自动清除";
  const remain = t.expire_at - nowTick.value;
  if (remain <= 0) return "到期，即将自动清除";
  const days = Math.ceil(remain / 86_400_000);
  const prefix = days > 1 ? `剩 ${days} 天` : days === 1 ? "明天" : "今天";
  return `${prefix}自动清除 · ${fmtDate(t.expire_at)}`;
}

const thumbs = ref<Record<string, string>>({});

async function loadThumbs() {
  const items = store.trash;
  for (let i = 0; i < items.length; i += 8) {
    const chunk = items.slice(i, i + 8);
    try {
      const res = await api.getThumbs(
        chunk.map((t) => ({ path: t.trash_path, is_dir: t.is_dir, is_video: isVideoName(t.name) }))
      );
      // 后端按请求的 path 原样回传（get_thumbs 返回字段为 path），据此建立映射
      for (const r of res) {
        if (r.thumb) thumbs.value[r.path] = assetUrl(r.thumb);
      }
    } catch {
      /* ignore */
    }
  }
}

const checked = ref(new Set<string>());
const allChecked = computed(
  () => store.trash.length > 0 && checked.value.size === store.trash.length
);

function thumbOf(t: { trash_path: string; name: string }): string | null {
  return thumbs.value[t.trash_path] || null;
}

function toggle(id: string) {
  const s = new Set(checked.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  checked.value = s;
}
function toggleAll() {
  checked.value = allChecked.value ? new Set() : new Set(store.trash.map((t) => t.id));
}
function icon(t: { name: string; is_dir: boolean }): string {
  if (t.is_dir) return "📁";
  const kind = isVideoName(t.name) ? "video" : /jpe?g|png|gif|webp|bmp|tiff?|heic|heif|avif|svg/i.test(t.name) ? "image" : "other";
  return kind === "video" ? "🎬" : kind === "image" ? "🖼" : "📄";
}

function deleteChecked() {
  const ids = [...checked.value];
  confirmAction(
    "彻底删除",
    `将把选中的 ${ids.length} 项从硬盘上永久删除，此操作不可恢复！确定继续吗？`,
    () => {
      deleteForever(ids);
      checked.value = new Set();
    },
    true
  );
}
function clearAll() {
  confirmAction(
    "清空回收站",
    `将把回收站中的全部 ${store.trash.length} 项从硬盘上永久删除，此操作不可恢复！确定继续吗？`,
    () => {
      emptyTrash();
      checked.value = new Set();
    },
    true
  );
}
function restoreOne(id: string) {
  restoreTrash([id]).then(() => {
    const s = new Set(checked.value);
    s.delete(id);
    checked.value = s;
  });
}
</script>

<template>
  <div>
    <div class="section-title">
      回收站
      <span class="n">{{ store.trash.length }} 项{{ checked.size ? ` · 已选 ${checked.size} 项` : "" }}</span>
      <span style="flex: 1"></span>
      <button v-if="checked.size" class="btn danger" @click="deleteChecked">
        彻底删除选中（{{ checked.size }}）
      </button>
      <button v-if="store.trash.length" class="btn danger" @click="clearAll">一键清空回收站</button>
    </div>
    <div v-if="store.trash.length" class="trash-ttl-hint">
      <span>🕒 {{ trashTtlDays() > 0 ? `回收站内条目 ${trashTtlDays()} 天后自动从硬盘清除` : "当前设置为永不自动清除" }}</span>
      <span> · 可在「设置 → 回收站自动清除」中修改</span>
    </div>
    <div class="row-list">
      <div v-for="t in store.trash" :key="t.id" class="row-item" :title="t.orig_path">
        <input
          type="checkbox"
          class="trash-check"
          :checked="checked.has(t.id)"
          @change="toggle(t.id)"
          @click.stop
        />
        <img v-if="thumbOf(t)" class="r-thumb" :src="thumbOf(t)!" decoding="async" />
        <div v-else class="r-icon">{{ icon(t) }}</div>
        <div class="r-main">
          <div class="r-name">{{ t.name }}</div>
          <div class="r-path">原位置：{{ t.orig_path }}</div>
        </div>
        <div class="r-meta">
          <div>{{ fmtSize(t.size) }} · {{ fmtDate(t.deleted_at) }}</div>
          <div class="r-expire" :class="{ urgent: t.expire_at > 0 && t.expire_at - nowTick < 86_400_000 }">
            {{ expireText(t) }}
          </div>
        </div>
        <div class="r-actions">
          <button class="btn" @click.stop="restoreOne(t.id)">恢复</button>
          <button
            class="btn danger"
            @click.stop="confirmAction('彻底删除', `将把「${t.name}」从硬盘上永久删除，此操作不可恢复！确定继续吗？`, () => deleteForever([t.id]), true)"
          >
            彻底删除
          </button>
        </div>
      </div>
    </div>
    <div v-if="!store.trash.length" class="empty-state">
      <div class="icon">🗑</div>
      <p>回收站是空的 · 删除的文件会先移到这里，可随时恢复</p>
    </div>
  </div>
</template>

<style scoped>
.r-thumb {
  width: 44px;
  height: 36px;
  object-fit: cover;
  border-radius: 8px;
  flex-shrink: 0;
  background: var(--panel-2);
}
.trash-check {
  width: 16px;
  height: 16px;
  accent-color: var(--primary);
  cursor: pointer;
  flex-shrink: 0;
}
/* 1.0.2-r6：到期时间与顶部提示 */
.trash-ttl-hint {
  font-size: 12px;
  color: var(--text-faint);
  margin: 2px 0 10px;
}
.r-expire {
  font-size: 11.5px;
  color: var(--text-faint);
  margin-top: 2px;
}
.r-expire.urgent {
  color: var(--danger, #e5484d);
  font-weight: 600;
}
</style>
