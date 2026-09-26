<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useOfflineStore } from "../stores/offline";
import type { BBox } from "../lib/offline";

const props = defineProps<{
  /** 当前地图视野；面板打开时由父组件传入。 */
  viewport: { bbox: BBox; zoom: number } | null;
}>();

const offline = useOfflineStore();
const open = ref(false);
const name = ref("");
const minZoom = ref(10);
const maxZoom = ref(14);

const estimate = computed(() => {
  if (!props.viewport) return null;
  return offline.estimate(props.viewport.bbox, minZoom.value, maxZoom.value);
});

watch(open, (value) => {
  if (value && props.viewport) {
    const current = Math.floor(props.viewport.zoom);
    minZoom.value = Math.max(0, current - 2);
    maxZoom.value = Math.min(19, current + 2);
  }
});

async function save() {
  if (!props.viewport) return;
  await offline.saveRegion(name.value, props.viewport.bbox, minZoom.value, maxZoom.value);
  name.value = "";
}

function formatTime(value: string | null): string {
  if (!value) return "从未同步";
  return new Date(value).toLocaleString();
}
</script>

<template>
  <div class="offline-panel">
    <button class="button secondary small" type="button" @click="open = !open">
      {{ open ? "收起离线管理" : "离线区域" }}
      <span v-if="!offline.online" class="badge pending">离线中</span>
    </button>

    <div v-if="open" class="card offline-card">
      <div class="card-body">
        <div class="inline" style="justify-content: space-between">
          <strong>离线区域</strong>
          <span class="muted">{{ offline.online ? "在线" : "离线" }}</span>
        </div>
        <p class="muted" style="margin: 6px 0 12px">
          按当前视野与缩放级别预取瓦片和地点；网络恢复后自动增量同步，过期缓存不会覆盖服务端新版。
        </p>

        <template v-if="viewport">
          <div class="field">
            <label for="offline-name">区域名称</label>
            <input id="offline-name" v-model="name" type="text" maxlength="60" placeholder="例如：通勤路线" />
          </div>
          <div class="grid-2">
            <div class="field">
              <label for="offline-min-zoom">最小缩放</label>
              <input id="offline-min-zoom" v-model.number="minZoom" type="number" min="0" max="19" />
            </div>
            <div class="field">
              <label for="offline-max-zoom">最大缩放</label>
              <input id="offline-max-zoom" v-model.number="maxZoom" type="number" min="0" max="19" />
            </div>
          </div>
          <p v-if="estimate" class="muted">
            预计 {{ estimate.tiles }} 个瓦片（上限 {{ estimate.maxTiles }}）
          </p>
          <p v-if="estimate?.validationError" class="error-box">{{ estimate.validationError }}</p>
          <button
            class="button small"
            type="button"
            :disabled="Boolean(estimate?.validationError) || Boolean(offline.downloadingRegionId)"
            @click="save"
          >
            保存当前视野为离线区域
          </button>
        </template>

        <div v-if="offline.downloadingRegionId && offline.progress" class="offline-progress">
          <p class="muted">
            {{ offline.progress.phase === "tiles" ? "下载瓦片" : "下载地点" }}…
            {{ offline.progress.tiles.done }}/{{ offline.progress.tiles.total }}
            <template v-if="offline.progress.phase === 'features'">
              ，已缓存 {{ offline.progress.featureCount }} 个地点
            </template>
          </p>
          <progress
            :value="offline.progress.tiles.done"
            :max="Math.max(1, offline.progress.tiles.total)"
          ></progress>
        </div>

        <p v-if="offline.error" class="error-box">{{ offline.error }}</p>

        <div v-if="offline.regions.length" class="offline-region-list">
          <div v-for="region in offline.regions" :key="region.id" class="offline-region">
            <div>
              <strong>{{ region.name }}</strong>
              <span v-if="region.status === 'downloading'" class="badge pending">下载中</span>
              <span v-else-if="region.status === 'error'" class="badge rejected">失败</span>
              <span v-else class="badge">就绪</span>
              <p class="muted" style="margin: 4px 0 0">
                z{{ region.minZoom }}–z{{ region.maxZoom }} · {{ region.tileCount }} 瓦片 ·
                {{ region.featureCount }} 地点 · {{ formatTime(region.lastSyncedAt) }}
              </p>
              <p v-if="region.error" class="muted">{{ region.error }}</p>
            </div>
            <div class="inline">
              <button
                v-if="region.status === 'error'"
                class="button secondary small"
                type="button"
                :disabled="Boolean(offline.downloadingRegionId)"
                @click="offline.download(region.id)"
              >
                重试
              </button>
              <button class="button danger small" type="button" @click="offline.removeRegion(region.id)">删除</button>
            </div>
          </div>
        </div>
        <p v-else class="muted">还没有离线区域。</p>

        <button
          v-if="offline.readyRegions.length"
          class="button secondary small"
          type="button"
          :disabled="offline.syncing || !offline.online"
          @click="offline.syncNow()"
        >
          {{ offline.syncing ? "同步中…" : "立即同步全部" }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.offline-panel {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 5;
  display: grid;
  justify-items: end;
  gap: 8px;
}
.offline-card {
  width: min(360px, calc(100vw - 48px));
  max-height: 70vh;
  overflow: auto;
}
.offline-progress progress {
  width: 100%;
}
.offline-region-list {
  display: grid;
  gap: 10px;
  margin: 12px 0;
}
.offline-region {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: flex-start;
  border-top: 1px solid var(--line);
  padding-top: 10px;
}
</style>
