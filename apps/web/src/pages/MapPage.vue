<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import maplibregl from "maplibre-gl";
import { apiFetch } from "../lib/api";
import OfflinePanel from "../components/OfflinePanel.vue";
import { useOfflineStore } from "../stores/offline";
import {
  ensureOfflineProtocol,
  queryCachedFeatures,
  toOfflineTileUrl,
  type BBox
} from "../lib/offline";

type FeatureResult = {
  id: string;
  categoryKey: string;
  categoryName: string;
  title: string;
  description: string;
  longitude: number;
  latitude: number;
  condition: string;
  updatedAt: string;
  media: Array<{ id: string; url: string | null; thumbnailUrl: string | null }>;
};

type Category = { key: string; name: string };

const router = useRouter();
const offline = useOfflineStore();
const mapElement = ref<HTMLDivElement | null>(null);
const features = ref<FeatureResult[]>([]);
const categories = ref<Category[]>([]);
const selectedCategory = ref("");
const loading = ref(false);
const error = ref("");
const offlineNotice = ref("");
const viewport = ref<{ bbox: BBox; zoom: number } | null>(null);
let map: maplibregl.Map | null = null;
let loaded = false;

const tileUrl = import.meta.env.VITE_TILE_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const styleUrl = import.meta.env.VITE_MAP_STYLE_URL?.trim() || "";
const glyphsUrl = import.meta.env.VITE_MAP_GLYPHS_URL || "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";
const rawCenter = (import.meta.env.VITE_DEFAULT_MAP_CENTER || "116.397,39.908").split(",").map(Number);
const center: [number, number] = [rawCenter[0] ?? 116.397, rawCenter[1] ?? 39.908];
const zoom = Number(import.meta.env.VITE_DEFAULT_MAP_ZOOM || 12);

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

function refreshViewport() {
  if (!map) return;
  const bounds = map.getBounds();
  viewport.value = {
    bbox: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
    zoom: map.getZoom()
  };
}

async function loadFeatures() {
  if (!map) return;
  loading.value = true;
  error.value = "";
  offlineNotice.value = "";
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
    features.value = await apiFetch<FeatureResult[]>(`/features?${query}`);
    updateSource();
  } catch (cause) {
    // 网络失败时回退到离线缓存；缓存命中则明确标注，避免把旧数据当成实时数据。
    const cached = await queryCachedFeatures(
      [west, south, east, north],
      selectedCategory.value || undefined
    ).catch(() => []);
    if (cached.length) {
      features.value = cached as FeatureResult[];
      offlineNotice.value = "网络不可用，当前显示离线缓存数据，恢复联网后将自动同步。";
      updateSource();
    } else {
      error.value = cause instanceof Error ? cause.message : "加载地图数据失败";
    }
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
  categories.value = await apiFetch<Category[]>("/categories").catch(() => []);
  if (!mapElement.value) return;
  ensureOfflineProtocol();
  map = new maplibregl.Map({
    container: mapElement.value,
    center,
    zoom,
    style: styleUrl || {
      version: 8,
      glyphs: glyphsUrl,
      sources: {
        osm: {
          type: "raster",
          tiles: [toOfflineTileUrl(tileUrl)],
          tileSize: 256,
          attribution: "© OpenStreetMap contributors"
        }
      },
      layers: [{ id: "osm", type: "raster", source: "osm" }]
    }
  });
  map.addControl(new maplibregl.NavigationControl(), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
  map.on("load", () => {
    addFeatureLayers();
    refreshViewport();
  });
  map.on("moveend", () => {
    refreshViewport();
    if (loaded) void loadFeatures();
  });
  map.on("error", (event) => { error.value = event.error?.message ?? "地图加载失败"; });
});

onBeforeUnmount(() => {
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
        <div ref="mapElement" class="map-canvas" aria-label="公共空间细节地图"></div>
        <OfflinePanel :viewport="viewport" />
        <div class="map-toolbar">
          <div class="inline">
            <label for="category-filter" class="muted">分类</label>
            <select id="category-filter" v-model="selectedCategory" @change="loadFeatures">
              <option value="">全部</option>
              <option v-for="category in categories" :key="category.key" :value="category.key">{{ category.name }}</option>
            </select>
            <span v-if="loading" class="muted">加载中…</span>
            <span v-else class="muted">{{ features.length }} 个结果</span>
            <span v-if="!offline.online" class="badge pending">离线</span>
          </div>
        </div>
      </div>

      <aside class="card result-panel">
        <div class="card-body">
          <div class="inline" style="justify-content: space-between">
            <strong>当前视野</strong>
            <span class="muted">{{ features.length }} 项</span>
          </div>
          <p v-if="offlineNotice" class="notice-box">{{ offlineNotice }}</p>
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
