<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api, fmtSize, type DiskUsage, type Stats } from "../api";
import {
  applyTheme,
  openLibrary,
  refreshTrashData,
  saveSetting,
  startScan,
  store,
  toast,
  toggleTheme,
} from "../store";

const videoApp = ref(store.settings.video_app || "");
const imageApp = ref(store.settings.image_app || "");
const clickActionMode = ref(store.settings.click_action || "internal");
// 1.0.2-r4：缓存保留时长（小时；"0" = 永不自动清理）。点选即写入设置，
// 后端 set_setting 立即同步给缓存清理逻辑，无需等「保存设置」。
// 1.0.2-r8：支持自定义小时数——当前值不在预设档时原样保留（此前会被重置为 "1"）。
const CACHE_PRESETS = ["1", "6", "24", "0"];
const cacheTtlHours = ref(
  (() => {
    const raw = store.settings.cache_ttl_hours;
    if (raw === undefined || raw === "") return "1"; // 缺省 1 小时
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? String(Math.round(n)) : "1";
  })()
);
async function setCacheTtl(v: string) {
  // 夹紧 0 – 8760（0 = 永不；8760 = 365 天）
  const n = Math.max(0, Math.min(8760, Math.round(Number(v) || 0)));
  cacheTtlHours.value = String(n);
  await saveSetting("cache_ttl_hours", String(n));
}
// 1.0.2-r10：当前资料库的缓存目录（<库根>/.VTManager/cache），供下方「进入缓存目录」一键跳转
const cacheDir = computed(() => (store.root ? `${store.root}/.VTManager/cache` : ""));
async function openCacheDir() {
  const d = cacheDir.value;
  if (!d) return;
  try {
    await api.openDirectory(d);
  } catch (e: any) {
    toast(String(e), "err");
  }
}
// 1.0.2-r6：回收站自动清除间隔天数（0 = 永不，缺省 3）。改动立即生效——
// saveSetting 持久化到 settings 表，setTrashTtlDays 后端命令同步重置
// 所有在站条目的到期时间（从当前时刻重新计时）。
const trashTtlDays = ref(
  (() => {
    // 注意：缺省/空值必须落回 3，不能经 Number("")=0 误判为「永不」
    const raw = store.settings.trash_ttl_days;
    const n = raw === undefined || raw === "" ? 3 : Number(raw);
    return Number.isFinite(n) && n >= 0 ? String(n) : "3";
  })()
);
async function setTrashTtl(v: string) {
  const n = Math.max(0, Math.min(365, Math.round(Number(v) || 0)));
  trashTtlDays.value = String(n);
  await saveSetting("trash_ttl_days", String(n));
  try {
    await api.setTrashTtlDays(n);
    // 1.0.2-r8：后端已按当前时刻重置在站条目到期时间，前端列表立即同步（不切换视图）
    await refreshTrashData();
    toast(n > 0 ? `已设置：回收站条目 ${n} 天后自动清除` : "已设置：回收站条目永不自动清除", "ok");
  } catch {
    /* 后端旧版本无此命令时静默降级（仅保存设置） */
  }
}
function setTrashTtlQuick(v: string) {
  trashTtlDays.value = v;
  void setTrashTtl(v);
}
const tmdbKey = ref(store.settings.tmdb_key || "");
const stats = ref<Stats | null>(null);
const testing = ref(false);

// 存储空间（1.0.1-r13）：应用在资料库中的占用明细 + 一键清除缓存
// 1.0.2：增加「优化数据库」（WAL checkpoint + VACUUM）
const disk = ref<DiskUsage | null>(null);
const clearing = ref(false);
const optimizing = ref(false);

async function loadDisk() {
  try {
    disk.value = await api.diskUsage();
  } catch {
    /* ignore */
  }
}
loadDisk();

async function clearCacheAll() {
  const d = disk.value;
  if (!d) return;
  store.confirm = {
    title: "清除缓存",
    message: `将删除缩略图缓存、图片预览与转封装缓存，预计释放 ${fmtSize(
      d.thumbs_bytes + d.previews_bytes + d.remux_bytes
    )}。删除后浏览与播放时按需自动重建，不影响正常使用。`,
    danger: true,
    okText: "一键清除",
    onOk: async () => {
      clearing.value = true;
      try {
        const freed = await api.clearCache();
        toast(`已清除缓存，释放 ${fmtSize(freed)}`, "ok");
        await loadDisk();
      } catch (e: any) {
        toast(String(e), "err");
      } finally {
        clearing.value = false;
      }
    },
  };
}

function setTheme(mode: string) {
  if (store.settings.theme !== mode) toggleTheme();
}

/** 1.0.2：数据库一键优化（WAL checkpoint + VACUUM），压缩碎片、提升查询速度 */
async function optimizeDatabase() {
  optimizing.value = true;
  try {
    const freed = await api.optimizeDb();
    toast(
      freed > 0
        ? `数据库已优化，释放 ${fmtSize(freed)}`
        : "数据库已优化（无需压缩）",
      "ok"
    );
  } catch (e: any) {
    toast(String(e), "err");
  } finally {
    optimizing.value = false;
  }
}

async function loadStats() {
  try {
    stats.value = await api.stats();
  } catch {
    /* ignore */
  }
}
loadStats();

async function saveAll() {
  await saveSetting("video_app", videoApp.value);
  await saveSetting("image_app", imageApp.value);
  await saveSetting("click_action", clickActionMode.value);
  if (tmdbKey.value !== (store.settings.tmdb_key || "")) {
    await saveSetting("tmdb_key", tmdbKey.value.trim());
  }
  applyTheme();
  toast("设置已保存", "ok");
}

async function testTmdb() {
  if (!tmdbKey.value.trim()) {
    toast("请先填写 API Key", "err");
    return;
  }
  testing.value = true;
  const old = store.settings.tmdb_key;
  await saveSetting("tmdb_key", tmdbKey.value.trim());
  try {
    const r = await api.tmdbSearch("harry potter");
    toast(r.length ? `连接成功，测试返回 ${r.length} 条结果` : "连接成功", "ok");
  } catch (e: any) {
    toast(String(e), "err");
    if (old) await saveSetting("tmdb_key", old);
  } finally {
    testing.value = false;
  }
}

async function rescan() {
  await startScan();
}

async function chooseLibrary() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const dir = await open({ directory: true, multiple: false, title: "切换资料库目录" });
  if (typeof dir === "string" && dir) {
    try {
      await openLibrary(dir);
      toast("资料库已切换", "ok");
    } catch (e: any) {
      toast(String(e), "err");
    }
  }
}

function fmtDate(ms: number | null): string {
  if (!ms) return "从未扫描";
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") store.modals.settings = false;
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="modal-mask" @click.self="store.modals.settings = false">
    <div class="modal" style="width: 620px">
      <div class="modal-head">
        <div class="t">设置</div>
        <button class="x" @click="store.modals.settings = false">✕</button>
      </div>
      <div class="modal-body">
        <!-- 外观 -->
        <div class="settings-section">
          <h3>外观</h3>
          <div class="field">
            <label>界面主题</label>
            <div class="radio-group">
              <div
                class="radio-pill"
                :class="{ on: (store.settings.theme || 'light') === 'light' }"
                @click="setTheme('light')"
              >
                ☀️ 日间模式
              </div>
              <div
                class="radio-pill"
                :class="{ on: store.settings.theme === 'dark' }"
                @click="setTheme('dark')"
              >
                🌙 夜间模式
              </div>
            </div>
            <div class="hint">也可以点击主界面右下角的圆形按钮快速切换，切换带渐变动效。</div>
          </div>
        </div>

        <!-- 播放与查看 -->
        <div class="settings-section">
          <h3>播放与查看</h3>
          <div class="field">
            <label>默认视频播放应用（留空 = 系统默认）</label>
            <select v-model="videoApp">
              <option value="">系统默认播放器</option>
              <option v-for="a in store.apps" :key="a.path" :value="a.path">{{ a.name }}</option>
            </select>
          </div>
          <div class="field">
            <label>默认图片查看应用（留空 = 系统默认）</label>
            <select v-model="imageApp">
              <option value="">系统默认看图程序</option>
              <option v-for="a in store.apps" :key="a.path" :value="a.path">{{ a.name }}</option>
            </select>
          </div>
          <div class="field">
            <label>单击视频/图片时的行为</label>
            <div class="radio-group">
              <div
                class="radio-pill"
                :class="{ on: clickActionMode === 'internal' }"
                @click="clickActionMode = 'internal'"
              >
                应用内预览（可切换外部打开）
              </div>
              <div
                class="radio-pill"
                :class="{ on: clickActionMode === 'external' }"
                @click="clickActionMode = 'external'"
              >
                直接用默认应用打开
              </div>
            </div>
          </div>
          <div class="field">
            <label>关闭播放器时清理视频转封装缓存</label>
            <div class="radio-group">
              <div
                class="radio-pill"
                :class="{ on: (store.settings.cleanup_remux_on_close || '1') === '1' }"
                @click="saveSetting('cleanup_remux_on_close', '1')"
              >
                自动清理（推荐）
              </div>
              <div
                class="radio-pill"
                :class="{ on: store.settings.cleanup_remux_on_close === '0' }"
                @click="saveSetting('cleanup_remux_on_close', '0')"
              >
                保留副本（重播秒开）
              </div>
            </div>
            <div class="hint">
              MKV/AVI 等格式在应用内播放时，会在资料库缓存生成一份与原视频等大的转封装副本（用于流畅拖动进度条）。默认关闭播放器或切换视频时立即删除该副本，不占用额外磁盘空间；再次播放会自动快速重建。不影响本地视频文件。
            </div>
          </div>
        </div>

        <!-- TMDB -->
        <div class="settings-section">
          <h3>TMDB 电影信息刮削（可选）</h3>
          <div class="field">
            <label>API Key（v3 auth）</label>
            <div style="display: flex; gap: 8px">
              <input type="password" v-model="tmdbKey" placeholder="在 themoviedb.org 免费注册获取" />
              <button class="btn" :disabled="testing" @click="testTmdb">
                {{ testing ? "测试中…" : "测试连接" }}
              </button>
            </div>
            <div class="hint">
              注册地址：themoviedb.org → 设置 → API → 创建开发者。仅在进行「刮削」操作时联网使用。
            </div>
          </div>
        </div>

        <!-- 资料库 -->
        <div class="settings-section">
          <h3>资料库与索引</h3>
          <div class="field">
            <label>当前资料库目录</label>
            <div style="display: flex; gap: 8px">
              <input type="text" :value="store.root" readonly />
              <button class="btn" @click="chooseLibrary">切换…</button>
            </div>
          </div>
          <div v-if="stats" class="stat-grid">
            <div class="stat-cell">
              <div class="v">{{ stats.videos }}</div>
              <div class="k">视频</div>
            </div>
            <div class="stat-cell">
              <div class="v">{{ stats.images }}</div>
              <div class="k">图片</div>
            </div>
            <div class="stat-cell">
              <div class="v">{{ fmtSize(stats.total_size) }}</div>
              <div class="k">文件总量</div>
            </div>
          </div>
          <div class="field">
            <button class="btn" :disabled="store.scanRunning" @click="rescan">
              {{ store.scanRunning ? `正在扫描… ${store.scanCount}` : "重新扫描全盘索引" }}
            </button>
            <span style="font-size: 11.5px; color: var(--text-faint); margin-left: 10px">
              上次扫描：{{ fmtDate(stats?.last_scan ?? null) }} · 索引 {{ stats?.count ?? 0 }} 项
            </span>
          </div>
        </div>

        <!-- 存储空间（1.0.1-r13，1.0.2 增加应用本体大小） -->
        <div class="settings-section">
          <h3>存储空间</h3>
          <div v-if="disk" class="disk-grid">
            <div class="disk-cell">
              <div class="v">{{ fmtSize(disk.app_bytes) }}</div>
              <div class="k">应用本体大小</div>
            </div>
            <div class="disk-cell">
              <div class="v">{{ fmtSize(disk.total_bytes) }}</div>
              <div class="k">应用数据总占用</div>
            </div>
            <div class="disk-cell">
              <div class="v">{{ fmtSize(disk.thumbs_bytes + disk.previews_bytes + disk.remux_bytes) }}</div>
              <div class="k">缓存（可清除）</div>
            </div>
            <div class="disk-cell">
              <div class="v">{{ fmtSize(disk.covers_bytes) }}</div>
              <div class="k">封面</div>
            </div>
            <div class="disk-cell">
              <div class="v">{{ fmtSize(disk.trash_bytes) }}</div>
              <div class="k">回收站</div>
            </div>
          </div>
          <div v-else class="hint">读取占用统计中…</div>
          <div v-if="disk" style="font-size: 11.5px; color: var(--text-faint); margin: 8px 0 10px">
            缩略图 {{ fmtSize(disk.thumbs_bytes) }} · 预览 {{ fmtSize(disk.previews_bytes) }} · 转封装 {{ fmtSize(disk.remux_bytes) }} · 数据库 {{ fmtSize(disk.db_bytes) }}
          </div>
          <!-- 1.0.2-r4：缓存按时间自动过期（默认 1 小时未再查看即删除，之后按需重建）
               1.0.2-r8：支持自定义小时数（0 = 永不） -->
          <div class="field">
            <label>缓存保留时长</label>
            <div class="radio-group">
              <div
                class="radio-pill"
                :class="{ on: cacheTtlHours === '1' }"
                @click="setCacheTtl('1')"
              >
                1 小时
              </div>
              <div
                class="radio-pill"
                :class="{ on: cacheTtlHours === '6' }"
                @click="setCacheTtl('6')"
              >
                6 小时
              </div>
              <div
                class="radio-pill"
                :class="{ on: cacheTtlHours === '24' }"
                @click="setCacheTtl('24')"
              >
                24 小时
              </div>
              <div
                class="radio-pill"
                :class="{ on: cacheTtlHours === '0' }"
                @click="setCacheTtl('0')"
              >
                永不清理
              </div>
            </div>
            <div class="ttl-input-row">
              <span>自定义</span>
              <input
                class="ttl-input"
                type="number"
                min="0"
                max="8760"
                step="1"
                :value="cacheTtlHours"
                @change="(e: any) => setCacheTtl((e.target as HTMLInputElement).value)"
                @blur="(e: any) => setCacheTtl((e.target as HTMLInputElement).value)"
              />
              <span>小时（0 = 永不）</span>
            </div>
            <div style="font-size: 11.5px; color: var(--text-faint); margin-top: 6px">
              超过时长未再次查看的缩略图与预览自动删除，再次访问时按需重建（不影响本地原文件）。
              视频转封装副本不走这里，仍按「关闭播放器即删」处理。改动立即生效。
            </div>
            <!-- 1.0.2-r10：缓存目录展示 + 一键进入（Finder / 资源管理器） -->
            <div v-if="cacheDir" class="cache-dir-row">
              <span class="cache-dir-hint">缓存目录</span>
              <code class="cache-dir-path" :title="cacheDir">{{ cacheDir }}</code>
              <button class="btn cache-dir-btn" @click="openCacheDir">进入缓存目录</button>
            </div>
          </div>
          <!-- 1.0.2-r6：回收站自动清除（默认 3 天；0 = 永不）。改动立即生效，
               后端 set_trash_ttl_days 会按当前时刻重置所有在站条目的到期时间 -->
          <div class="field" style="border-top: 1px solid var(--panel-2); padding-top: 12px">
            <label>回收站自动清除</label>
            <div class="radio-group">
              <div
                class="radio-pill"
                :class="{ on: trashTtlDays === '3' }"
                @click="setTrashTtlQuick('3')"
              >
                3 天
              </div>
              <div
                class="radio-pill"
                :class="{ on: trashTtlDays === '7' }"
                @click="setTrashTtlQuick('7')"
              >
                7 天
              </div>
              <div
                class="radio-pill"
                :class="{ on: trashTtlDays === '30' }"
                @click="setTrashTtlQuick('30')"
              >
                30 天
              </div>
              <div
                class="radio-pill"
                :class="{ on: trashTtlDays === '0' }"
                @click="setTrashTtlQuick('0')"
              >
                永不
              </div>
            </div>
            <div class="ttl-input-row">
              <span>自定义</span>
              <input
                class="ttl-input"
                type="number"
                min="0"
                max="365"
                step="1"
                :value="trashTtlDays"
                @change="(e: any) => setTrashTtl((e.target as HTMLInputElement).value)"
                @blur="(e: any) => setTrashTtl((e.target as HTMLInputElement).value)"
              />
              <span>天（1–365，0 = 永不）</span>
            </div>
            <div style="font-size: 11.5px; color: var(--text-faint); margin-top: 6px">
              回收站内的文件/文件夹到期后自动从硬盘清除；每次修改设置都会按当前时刻
              重新计算在站条目的到期时间，删除时也会提示剩余天数。改动立即生效。
            </div>
          </div>
          <div class="field" style="margin-bottom: 0">
            <button
              class="btn danger clear-cache-btn"
              :disabled="clearing"
              @click="clearCacheAll"
            >
              {{ clearing ? "清除中…" : "一键清除缓存" }}
            </button>
            <button
              class="btn"
              style="margin-left: 8px"
              :disabled="optimizing || store.scanRunning"
              @click="optimizeDatabase"
            >
              {{ optimizing ? "优化中…" : "优化数据库" }}
            </button>
            <span style="font-size: 11.5px; color: var(--text-faint); margin-left: 10px">
              仅清除可再生缓存，浏览/播放时自动重建，不影响正常使用
            </span>
          </div>
          <div style="font-size: 11.5px; color: var(--text-faint); margin-top: 8px">
            优化数据库 = WAL 合并 + VACUUM 压缩：长期增删大量文件后整理数据库碎片，查询更快；扫描进行中不可用
          </div>
        </div>

        <!-- 关于 -->
        <div class="settings-section">
          <h3>关于</h3>
          <div class="hint" style="font-size: 12px">
            VTManager v{{ store.version }} · 本地单机应用，数据与封面缓存保存在资料库的
            .VTManager 目录中，随硬盘迁移。<br />
            视频元数据与缩略图优先走系统原生解码（AVFoundation），速度快、占用低；
            内置 ffmpeg 作为兼容回退。
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="store.modals.settings = false">取消</button>
        <button class="btn primary" @click="saveAll">保存设置</button>
      </div>
    </div>
  </div>
</template>
