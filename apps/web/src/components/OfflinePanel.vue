<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  getOfflineManager,
  estimateTileCount,
  type OfflineRegion,
  type PrefetchProgress,
  type OfflineStatus
} from "../lib/offline";

interface BoundsLike {
  getWest(): number;
  getEast(): number;
  getSouth(): number;
  getNorth(): number;
}

const props = defineProps<{
  getBounds: () => BoundsLike | null;
  getZoom: () => number | null;
}>();

const manager = getOfflineManager();
const online = ref(manager.isOnline());
const syncing = ref(false);
const status = ref<OfflineStatus>(manager.getStatus());
const regions = ref<OfflineRegion[]>([]);
const panelOpen = ref(false);
const name = ref("");
const minZoom = ref(0);
const maxZoom = ref(0);
const estimated = ref(0);
const message = ref("");
const messageKind = ref<"info" | "error" | "success">("info");
const progress = ref<PrefetchProgress | null>(null);
const abortController = ref<AbortController | null>(null);

let unsubscribeStatus: (() => void) | null = null;
let unsubscribeProgress: (() => void) | null = null;

const busy = computed(() => progress.value?.phase === "tiles");
const percent = computed(() => {
  const p = progress.value;
  if (!p || p.total === 0) return 0;
  return Math.round((p.completed / p.total) * 100);
});

async function refreshRegions() {
  regions.value = await manager.listRegions();
}

function syncSelectionToCurrentView() {
  const bounds = props.getBounds();
  const zoom = props.getZoom();
  if (!bounds || zoom === null) return;
  const rounded = Math.floor(zoom);
  minZoom.value = Math.max(0, rounded - 2);
  maxZoom.value = Math.min(16, rounded + 1);
  recomputeEstimate();
}

function recomputeEstimate() {
  const bounds = props.getBounds();
  if (!bounds) {
    estimated.value = 0;
    return;
  }
  estimated.value = estimateTileCount(
    [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
    minZoom.value,
    maxZoom.value
  );
}

function flash(text: string, kind: "info" | "error" | "success" = "info") {
  message.value = text;
  messageKind.value = kind;
}

async function saveCurrentView() {
  const bounds = props.getBounds();
  if (!bounds) {
    flash("地图尚未就绪", "error");
    return;
  }
  if (maxZoom.value < minZoom.value) {
    flash("最大缩放级不能小于最小缩放级", "error");
    return;
  }
  const region: OfflineRegion = {
    id: (crypto.randomUUID?.() as string | undefined) ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: name.value.trim() || `选区 ${regions.value.length + 1}`,
    bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
    minZoom: minZoom.value,
    maxZoom: maxZoom.value,
    createdAt: Date.now(),
    lastSyncedAt: null,
    tileCount: 0,
    bytes: 0,
    busy: false
  };
  const controller = new AbortController();
  abortController.value = controller;
  message.value = "";
  progress.value = null;
  try {
    const result = await manager.prefetch(region, { signal: controller.signal });
    flash(
      `已离线保存「${region.name}」：${result.failedTiles === 0 ? "全部瓦片成功" : `${result.failedTiles} 张瓦片失败`}，${result.features.length} 个地点`,
      result.failedTiles === 0 ? "success" : "info"
    );
    name.value = "";
    await refreshRegions();
  } catch (cause) {
    flash(cause instanceof Error ? cause.message : "预取失败", "error");
  } finally {
    abortController.value = null;
  }
}

function cancelPrefetch() {
  abortController.value?.abort();
}

async function removeRegion(id: string) {
  await manager.deleteRegion(id);
  await refreshRegions();
}

async function syncNow() {
  const result = await manager.syncNow();
  if (result.ok) {
    flash(`同步完成：${result.upserted} 个地点更新，${result.deleted} 个移除，${result.tilesChanged} 张瓦片更新`, "success");
  } else {
    flash(result.message ?? "同步失败", "error");
  }
  await refreshRegions();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value: number | null): string {
  if (!value) return "从未";
  return new Date(value).toLocaleString();
}

onMounted(() => {
  unsubscribeStatus = manager.onStatusChange((next) => {
    status.value = next;
    online.value = next.online;
    syncing.value = next.syncing;
  });
  unsubscribeProgress = manager.onPrefetchProgress((p) => {
    progress.value = p;
  });
  void refreshRegions();
});

onBeforeUnmount(() => {
  unsubscribeStatus?.();
  unsubscribeProgress?.();
});
</script>

<template>
  <div class="offline-card card">
    <button type="button" class="offline-header" @click="panelOpen = !panelOpen">
      <span class="inline">
        <span class="status-dot" :class="online ? 'online' : 'offline'" aria-hidden="true"></span>
        <strong>离线地图</strong>
        <span class="muted">{{ online ? (syncing ? "同步中…" : "在线") : "离线模式" }}</span>
      </span>
      <span class="muted">{{ panelOpen ? "收起" : "展开" }}</span>
    </button>

    <div v-if="panelOpen" class="card-body offline-body">
      <p v-if="!online" class="error-box">当前无网络：地图显示已缓存选区与地点，恢复网络后自动增量同步。</p>

      <div class="offline-actions">
        <button type="button" class="button" @click="syncNow" :disabled="syncing || !online">
          {{ syncing ? "同步中…" : "立即同步" }}
        </button>
        <span v-if="status.lastSyncAt" class="muted">上次：{{ formatTime(status.lastSyncAt) }}</span>
      </div>

      <div class="offline-form">
        <h4>保存当前视野</h4>
        <input v-model="name" type="text" placeholder="选区名称（可选）" maxlength="40" />
        <div class="inline">
          <label class="muted">
            最小 z
            <input v-model.number="minZoom" type="number" min="0" max="22" @change="recomputeEstimate" />
          </label>
          <label class="muted">
            最大 z
            <input v-model.number="maxZoom" type="number" min="0" max="22" @change="recomputeEstimate" />
          </label>
          <button type="button" class="button button-secondary" @click="syncSelectionToCurrentView">按当前视野填充</button>
        </div>
        <p class="muted">预计 {{ estimated.toLocaleString() }} 张瓦片；缩放级跨度越大，占用空间越多。</p>
        <div class="inline">
          <button type="button" class="button" :disabled="busy" @click="saveCurrentView">
            {{ busy ? `下载中 ${percent}%` : "预取此选区" }}
          </button>
          <button v-if="busy" type="button" class="button button-secondary" @click="cancelPrefetch">取消</button>
        </div>
        <div v-if="busy" class="progress-bar" aria-hidden="true">
          <div class="progress-fill" :style="{ width: `${percent}%` }"></div>
        </div>
      </div>

      <p v-if="message" :class="messageKind === 'error' ? 'error-box' : 'success-box'">{{ message }}</p>

      <div v-if="regions.length" class="region-list">
        <h4>已保存选区（{{ regions.length }}）</h4>
        <ul>
          <li v-for="region in regions" :key="region.id">
            <div class="inline" style="justify-content: space-between">
              <strong>{{ region.name }}</strong>
              <button type="button" class="link-danger" @click="removeRegion(region.id)">删除</button>
            </div>
            <small class="muted">
              z{{ region.minZoom }}–{{ region.maxZoom }} · {{ region.tileCount.toLocaleString() }} 瓦片
              · {{ formatBytes(region.bytes) }}
            </small>
            <br />
            <small class="muted">同步于 {{ formatTime(region.lastSyncedAt) }}</small>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.offline-header {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
}
.status-dot {
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 50%;
  display: inline-block;
}
.status-dot.online { background: #16a34a; }
.status-dot.offline { background: #dc2626; }
.offline-body { display: flex; flex-direction: column; gap: 0.75rem; }
.offline-actions { display: flex; align-items: center; gap: 0.75rem; }
.offline-form { display: flex; flex-direction: column; gap: 0.5rem; border-top: 1px solid #e2e8f0; padding-top: 0.75rem; }
.offline-form input[type="text"] { width: 100%; }
.offline-form input[type="number"] { width: 4.5rem; margin-left: 0.35rem; }
.progress-bar { height: 6px; background: #e2e8f0; border-radius: 999px; overflow: hidden; }
.progress-fill { height: 100%; background: #0f766e; transition: width 0.2s; }
.region-list ul { list-style: none; padding: 0; margin: 0.5rem 0 0; display: flex; flex-direction: column; gap: 0.5rem; }
.region-list li { border: 1px solid #e2e8f0; border-radius: 0.5rem; padding: 0.5rem 0.75rem; }
.link-danger { background: none; border: none; color: #dc2626; cursor: pointer; padding: 0; font-size: 0.85rem; }
.success-box { background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; padding: 0.5rem 0.75rem; border-radius: 0.5rem; margin: 0; }
.button:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
