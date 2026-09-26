<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiFetch } from "../lib/api";
import { getCachedFeature } from "../lib/offline";
import { useAuthStore } from "../stores/auth";

type Feature = {
  id: string;
  ownerId: string;
  categoryKey: string;
  categoryName: string;
  title: string;
  description: string;
  longitude: number;
  latitude: number;
  locationAccuracyM: number;
  condition: string;
  stepFree: boolean | null;
  wheelchairAccessible: boolean | null;
  noiseLevel: number | null;
  tags: string[];
  details: Record<string, unknown>;
  media: Array<{ id: string; url: string | null; thumbnailUrl: string | null }>;
  created_at?: string;
  updatedAt: string;
  firstPublishedAt: string | null;
  confirmations: Array<{ result: string; count: number }>;
};

type Comment = {
  id: string;
  parentId: string | null;
  body: string;
  authorName: string;
  createdAt: string;
  editedAt: string | null;
};

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const feature = ref<Feature | null>(null);
const comments = ref<Comment[]>([]);
const commentBody = ref("");
const error = ref("");
const notice = ref("");
const loading = ref(true);

const detailLabels: Record<string, string> = {
  seatCount: "座位数", hasBackrest: "有靠背", covered: "有遮蔽", shaded: "有树荫", wheelchairSpace: "有轮椅空间",
  material: "材质", potable: "是否可饮用", waterType: "出水类型", bottleFiller: "可接瓶", working: "当前可用",
  pressure: "水压", capacity: "容纳人数", windProtection: "挡风程度", seating: "有座位", flooding: "容易积水",
  structureNotes: "结构备注", powerOutlet: "有电源", wifi: "有 Wi-Fi", crowdLevel: "拥挤程度", bestTimes: "推荐时段",
  brightness: "亮度", coverage: "覆盖范围", colorTemperature: "光色", lightType: "灯具类型", operatingHours: "亮灯时段",
  brokenLights: "损坏灯数", safetyFeeling: "安全感"
};

const canEdit = computed(() => Boolean(auth.user && feature.value && auth.user.id === feature.value.ownerId));
const detailEntries = computed(() => Object.entries(feature.value?.details ?? {}).filter(([, value]) => value !== null && value !== ""));

function displayValue(value: unknown) {
  if (value === true) return "是";
  if (value === false) return "否";
  if (value === "yes") return "是";
  if (value === "no") return "否";
  if (value === "unknown") return "未知";
  return String(value);
}

async function load() {
  loading.value = true;
  try {
    const id = String(route.params.id);
    feature.value = await apiFetch<Feature>(`/features/${id}`);
    comments.value = await apiFetch<Comment[]>(`/features/${id}/comments`);
  } catch (cause) {
    // 网络失败时回退到离线缓存的详情，并明确标注数据可能不是最新。
    const cached = await getCachedFeature(String(route.params.id)).catch(() => undefined);
    if (cached) {
      feature.value = cached.payload as Feature;
      notice.value = "网络不可用，显示离线缓存数据，恢复联网后将自动更新。";
    } else {
      error.value = cause instanceof Error ? cause.message : "加载失败";
    }
  } finally {
    loading.value = false;
  }
}

async function addComment() {
  if (!feature.value || !commentBody.value.trim()) return;
  error.value = "";
  try {
    await apiFetch(`/features/${feature.value.id}/comments`, {
      method: "POST",
      body: { body: commentBody.value }
    });
    commentBody.value = "";
    notice.value = "评论已提交，审核通过后公开。";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "评论失败";
  }
}

async function confirm(result: "still_accurate" | "changed" | "closed") {
  if (!feature.value) return;
  if (!auth.isAuthenticated) {
    await router.push({ name: "login", query: { redirect: route.fullPath } });
    return;
  }
  try {
    await apiFetch(`/features/${feature.value.id}/confirmations`, { method: "POST", body: { result } });
    notice.value = "确认已记录，感谢帮助其他使用者。";
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "确认失败";
  }
}

async function report() {
  if (!feature.value) return;
  if (!auth.isAuthenticated) {
    await router.push({ name: "login", query: { redirect: route.fullPath } });
    return;
  }
  const reasonCode = window.prompt("请输入举报原因码，例如 WRONG_LOCATION、PERSONAL_INFORMATION、SPAM_OR_ADVERTISING");
  if (!reasonCode) return;
  const notes = window.prompt("补充说明（可选）") ?? undefined;
  try {
    await apiFetch("/reports", {
      method: "POST",
      body: { targetType: "feature", targetId: feature.value.id, reasonCode, notes }
    });
    notice.value = "举报已进入审核队列。";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "举报失败";
  }
}

onMounted(load);
</script>

<template>
  <section>
    <div v-if="loading" class="loading">加载中…</div>
    <div v-else-if="error && !feature" class="error-box">{{ error }}</div>
    <template v-else-if="feature">
      <div class="page-heading">
        <div>
          <div class="inline">
            <span class="badge">{{ feature.categoryName }}</span>
            <span class="badge">{{ feature.condition }}</span>
            <span v-if="feature.firstPublishedAt" class="badge">最近更新 {{ new Date(feature.updatedAt).toLocaleDateString() }}</span>
          </div>
          <h1>{{ feature.title }}</h1>
          <p>{{ feature.description }}</p>
        </div>
        <div class="inline">
          <RouterLink v-if="canEdit" class="button secondary" :to="`/submit/${feature.id}`">创建修订</RouterLink>
          <button class="button ghost" type="button" @click="report">举报</button>
        </div>
      </div>

      <p v-if="error" class="error-box">{{ error }}</p>
      <p v-if="notice" class="success-box">{{ notice }}</p>

      <div class="detail-layout">
        <div class="stack">
          <section v-if="feature.media.length" class="card"><div class="card-body">
            <div class="media-grid">
              <a v-for="media in feature.media" :key="media.id" :href="media.url ?? '#'" target="_blank" rel="noreferrer">
                <img :src="media.thumbnailUrl ?? media.url ?? ''" alt="地点细节照片" />
              </a>
            </div>
          </div></section>

          <section class="card"><div class="card-body">
            <h2>实际细节</h2>
            <dl class="detail-list">
              <template v-for="[key, value] in detailEntries" :key="key">
                <dt>{{ detailLabels[key] ?? key }}</dt>
                <dd>{{ displayValue(value) }}</dd>
              </template>
              <dt>无台阶到达</dt><dd>{{ feature.stepFree === null ? "未知" : feature.stepFree ? "是" : "否" }}</dd>
              <dt>轮椅可用</dt><dd>{{ feature.wheelchairAccessible === null ? "未知" : feature.wheelchairAccessible ? "是" : "否" }}</dd>
              <dt>坐标</dt><dd>{{ feature.latitude.toFixed(6) }}, {{ feature.longitude.toFixed(6) }}（约 ±{{ feature.locationAccuracyM }} 米）</dd>
              <dt>标签</dt><dd>{{ feature.tags?.join("、") || "无" }}</dd>
            </dl>
            <div class="inline" style="margin-top: 18px">
              <button class="button secondary" type="button" @click="confirm('still_accurate')">仍然准确</button>
              <button class="button ghost" type="button" @click="confirm('changed')">已经变化</button>
              <button class="button ghost" type="button" @click="confirm('closed')">已经关闭</button>
            </div>
            <p v-if="feature.confirmations.length" class="muted" style="margin-top: 10px">
              已确认：{{ feature.confirmations.map((item) => `${item.result} ${item.count}`).join(" · ") }}
            </p>
          </div></section>

          <section class="card"><div class="card-body">
            <h2>评论</h2>
            <form v-if="auth.isVerified" class="stack" style="margin: 14px 0" @submit.prevent="addComment">
              <textarea v-model="commentBody" maxlength="1000" placeholder="分享实际体验、时段变化或补充信息。评论同样需要审核。" />
              <button class="button" type="submit" :disabled="!commentBody.trim()">提交评论</button>
            </form>
            <p v-else class="notice-box">登录并验证邮箱后可以评论。</p>
            <div v-if="!comments.length" class="empty">还没有公开评论。</div>
            <article v-for="comment in comments" :key="comment.id" class="comment">
              <div class="comment-head">
                <strong>{{ comment.authorName }}</strong>
                <span>{{ new Date(comment.createdAt).toLocaleString() }}{{ comment.editedAt ? " · 已编辑" : "" }}</span>
              </div>
              <p>{{ comment.body }}</p>
            </article>
          </div></section>
        </div>

        <aside class="stack">
          <section class="card"><div class="card-body">
            <h2>位置</h2>
            <p class="muted">地图浏览页会对相同区域内容进行聚合，避免一次加载全部数据。</p>
            <a class="button secondary" :href="`/map`">回到地图</a>
          </div></section>
          <section class="card"><div class="card-body">
            <h2>内容状态</h2>
            <p class="muted">首次发布后有效期默认为 180 天。多人反馈变化或关闭时，内容会进入优先复核。</p>
          </div></section>
        </aside>
      </div>
    </template>
  </section>
</template>
