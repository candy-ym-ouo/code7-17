<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import maplibregl from "maplibre-gl";
import { apiFetch } from "../lib/api";
import OfflinePanel from "../components/OfflinePanel.vue";
import {
  getOfflineManager,
  registerOfflineTileProtocol,
  toOfflineTemplate,
  mergeFeaturesIntoStore,
  type CachedFeatureData
} from "../lib/offline";

type FeatureResult = CachedFeatureData;

type Category = { key: string; name: string };

const router = useRouter();
const offline = getOfflineManager();
const mapElement = ref<HTMLDivElement | null>(null);
const features = ref<FeatureResult[]>([]);
const categories = ref<Category[]>([]);
const selectedCategory = ref("");
const loading = ref(false);
const error = ref("");
const offlineBanner = ref(!offline.isOnline());
let map: maplibregl.Map | null = null;
let loaded = false;
let unbindNetwork: (() => void) | null = null;

const rawTileUrl = import.meta.env.VITE_TILE_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
offline.setTileTemplate(rawTileUrl);
const tileUrl = toOfflineTemplate(rawTileUrl);
const styleUrl = import.meta.env.VITE_MAP_STYLE_URL?.trim() || "";
const glyphsUrl = import.meta.env.VITE_MAP_GLYPHS_URL || "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";
const rawCenter = (import.meta.env.VITE_DEFAULT_MAP_CENTER || "116.397,39.908").split(",").map(Number);
const mapCenter: [number, number] = [rawCenter[0] ?? 116.397, rawCenter[1] ?? 39.908];
const initialZoom = Number(import.meta.env.VITE_DEFAULT_MAP_ZOOM || 12);

function featureCollection() {
  return {
    type: "FeatureCollection" as const,
    features: features.value.map((item) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [item.longitude, item.latitude] },
      properties: {
        id: item.id,
        categoryKey: item.categoryKey,
        title: item.title
      }
    }))
  };
}

function updateSource() {
  if (!map || !loaded) return;
  const source = map.getSource("features") as maplibregl.GeoJSONSource | undefined;
  source?.setData(featureCollection() as never);
}

async function loadFromCache(): Promise<FeatureResult[]> {
  if (!map) return [];
  const bounds = map.getBounds();
  return await offline.queryFeatures(
    [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
    selectedCategory.value || undefined
  );
}

/** 供离线面板读取当前视野（模板里直接写字面量函数会被收窄为 never）。 */
function currentBounds() {
  return map?.getBounds() ?? null;
}
function currentZoom() {
  return map?.getZoom() ?? null;
}

async function loadFeatures() {
  if (!map) return;
  loading.value = true;
  error.value = "";
  const bounds = map.getBounds();
  const center = map.getCenter();
  let west = bounds.getWest();
  let east = bounds.getEast();
  let south = bounds.getSouth();
  let north = bounds.getNorth();
  const longitudeSpan = east - west;
  if (longitudeSpan > 5) {
    west = center.lng - 2.5;
    east = center.lng + 2.5;
    west = ((west + 180) % 360 + 360) % 360 - 180;
    east = ((east + 180) % 360 + 360) % 360 - 180;
  }
  if (north - south > 5) {
    south = Math.max(-90, center.lat - 2.5);
    north = Math.min(90, center.lat + 2.5);
  }
  const bbox = [west, south, east, north].map((value) => value.toFixed(6)).join(",");
  const query = new URLSearchParams({ bbox, limit: "400" });
  if (selectedCategory.value) query.set("category", selectedCategory.value);
  try {
    const onlineFeatures = await apiFetch<FeatureResult[]>(`/features?${query}`);
    features.value = onlineFeatures;
    offlineBanner.value = false;
    error.value = "";
    updateSource();
    // 在线浏览到的地点顺带入缓存（无选区归属，供离线兜底；合并按版本裁决）。
    void mergeFeaturesIntoStore(offline.store, onlineFeatures, null).catch(() => undefined);
  } catch {
    // 网络失败（离线/超时）：降级为本地缓存，地图仍可浏览已缓存选区。
    features.value = await loadFromCache();
    offlineBanner.value = true;
    updateSource();
  } finally {
    loading.value = false;
  }
}

function addFeatureLayers() {
  if (!map || loaded) return;
  loaded = true;
  map.addSource("features", {
    type: "geojson",
    data: featureCollection() as never,
    cluster: true,
    clusterMaxZoom: 14,
    clusterRadius: 52
  });

  map.addLayer({
    id: "clusters",
    type: "circle",
    source: "features",
    filter: ["has", "point_count"],
    paint: {
      "circle-color": "#0f766e",
      "circle-radius": ["step", ["get", "point_count"], 18, 10, 24, 40, 31],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 3
    }
  });

  map.addLayer({
    id: "cluster-count",
    type: "symbol",
    source: "features",
    filter: ["has", "point_count"],
    layout: {
      "text-field": ["get", "point_count_abbreviated"],
      "text-size": 12,
      "text-font": ["Open Sans Regular"]
    },
    paint: { "text-color": "#ffffff" }
  });

  map.addLayer({
    id: "unclustered-point",
    type: "circle",
    source: "features",
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": [
        "match",
        ["get", "categoryKey"],
        "bench", "#b45309",
        "drinking_water", "#0369a1",
        "rain_shelter", "#4f46e5",
        "quiet_corner", "#15803d",
        "night_lighting", "#a21caf",
        "#334155"
      ],
      "circle-radius": 9,
      "circle-stroke-width": 3,
      "circle-stroke-color": "#ffffff"
    }
  });

  map.on("click", "clusters", async (event) => {
    const feature = map?.queryRenderedFeatures(event.point, { layers: ["clusters"] })[0];
    if (!feature || feature.geometry.type !== "Point") return;
    const clusterId = feature.properties?.cluster_id as number;
    const source = map?.getSource("features") as maplibregl.GeoJSONSource;
    const targetZoom = await source.getClusterExpansionZoom(clusterId);
    map?.easeTo({ center: feature.geometry.coordinates as [number, number], zoom: targetZoom });
  });

  map.on("click", "unclustered-point", (event) => {
    const feature = event.features?.[0];
    const id = feature?.properties?.id as string | undefined;
    if (id) void router.push(`/features/${id}`);
  });

  map.on("mouseenter", "clusters", () => { if (map) map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "clusters", () => { if (map) map.getCanvas().style.cursor = ""; });
  map.on("mouseenter", "unclustered-point", () => { if (map) map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "unclustered-point", () => { if (map) map.getCanvas().style.cursor = ""; });
  void loadFeatures();
}

onMounted(async () => {
  await nextTick();
  registerOfflineTileProtocol(maplibregl, offline.fetcher);
  unbindNetwork = offline.bindNetworkEvents();
  categories.value = await apiFetch<Category[]>("/categories").catch(() => []);
  if (!mapElement.value) return;
  map = new maplibregl.Map({
    container: mapElement.value,
    center: mapCenter,
    zoom: initialZoom,
    style: styleUrl || {
      version: 8,
      glyphs: glyphsUrl,
      sources: {
        osm: {
          type: "raster",
          tiles: [tileUrl],
          tileSize: 256,
          attribution: "© OpenStreetMap contributors"
        }
      },
      layers: [{ id: "osm", type: "raster", source: "osm" }]
    }
  });
  map.addControl(new maplibregl.NavigationControl(), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
  map.on("load", addFeatureLayers);
  map.on("moveend", () => { if (loaded) void loadFeatures(); });
  map.on("error", (event) => {
    // 单瓦片失败已在离线管线内吞掉并回退缓存；只记录其他错误。
    if (!/mapoffline|tile/i.test(event.error?.message ?? "")) {
      error.value = event.error?.message ?? "地图加载失败";
    }
  });
});

onBeforeUnmount(() => {
  unbindNetwork?.();
  unbindNetwork = null;
  map?.remove();
  map = null;
});
</script>

<template>
  <section>
    <div class="page-heading">
      <div>
        <h1>公共空间的真实细节</h1>
        <p>地图只展示已审核内容；点击聚合点放大，点击单个标记查看详情。</p>
      </div>
      <RouterLink v-if="$route.name === 'map'" class="button" to="/submit">记录一个细节</RouterLink>
    </div>

    <div class="map-layout">
      <div class="map-panel">
        <div v-if="offlineBanner" class="offline-banner" role="status">
          当前为离线模式：显示已缓存的选区瓦片与地点，恢复网络后将自动增量同步。
        </div>
        <div ref="mapElement" class="map-canvas" aria-label="公共空间细节地图"></div>
        <div class="map-toolbar">
          <div class="inline">
            <label for="category-filter" class="muted">分类</label>
            <select id="category-filter" v-model="selectedCategory" @change="loadFeatures">
              <option value="">全部</option>
              <option v-for="category in categories" :key="category.key" :value="category.key">{{ category.name }}</option>
            </select>
            <span v-if="loading" class="muted">加载中…</span>
            <span v-else class="muted">{{ features.length }} 个结果</span>
          </div>
        </div>
      </div>

      <aside class="card result-panel">
        <OfflinePanel
          :get-bounds="currentBounds"
          :get-zoom="currentZoom"
        />
        <div class="card-body">
          <div class="inline" style="justify-content: space-between">
            <strong>当前视野</strong>
            <span class="muted">{{ features.length }} 项</span>
          </div>
          <p v-if="error" class="error-box">{{ error }}</p>
        </div>
        <div v-if="!features.length && !loading" class="empty">当前视野没有已发布的细节。</div>
        <RouterLink v-for="feature in features" :key="feature.id" class="result-item" :to="`/features/${feature.id}`">
          <div class="inline">
            <span class="badge">{{ feature.categoryName }}</span>
            <span class="badge">{{ feature.condition }}</span>
          </div>
          <h3>{{ feature.title }}</h3>
          <p>{{ feature.description }}</p>
          <small class="muted">更新于 {{ new Date(feature.updatedAt).toLocaleDateString() }}</small>
        </RouterLink>
      </aside>
    </div>
  </section>
</template>
