import path from 'path';
import fs from 'fs';
import { randomUUID, createHmac, pbkdf2Sync, timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { requestLLM } from './llm.js';
import {
  CLARIFY_SYSTEM,
  buildClarifyUser,
  parseClarifyResponse,
  ensureClarifyQuestions,
  REASON_SYSTEM,
  buildReasonUser,
  GENERATE_SYSTEM,
  buildGenerateUser,
  STRUCTURE_ANCHOR_SYSTEM,
  buildStructureAnchorUser,
  SEGMENT_GENERATE_SYSTEM,
  buildSegmentGenerateUser,
  CONSISTENCY_REPAIR_SYSTEM,
  buildConsistencyRepairUser,
  REVISE_APPLY_SYSTEM,
  buildReviseApplyUser,
  REVISE_CONSISTENCY_SYSTEM,
  buildReviseConsistencyUser,
} from './prompts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const MODEL_V3 = process.env.LLM_MODEL_V3 || 'deepseek-chat';
const MODEL_R1 = process.env.LLM_MODEL_R1 || 'deepseek-reasoner';
const MODEL_V3_FALLBACK = (process.env.LLM_MODEL_V3_FALLBACK || '').trim();
const MODEL_R1_FALLBACK = (process.env.LLM_MODEL_R1_FALLBACK || '').trim();
const REVISE_APPLY_MODEL = process.env.REVISE_APPLY_MODEL || MODEL_V3;
const REVISE_APPLY_FALLBACK_MODEL = (process.env.REVISE_APPLY_FALLBACK_MODEL || '').trim() || MODEL_R1;
const REVISE_CONSISTENCY_MODEL = process.env.REVISE_CONSISTENCY_MODEL || MODEL_V3;
const REVISE_CONSISTENCY_FALLBACK_MODEL = (process.env.REVISE_CONSISTENCY_FALLBACK_MODEL || '').trim() || MODEL_R1;
const PORT = Number(process.env.PORT) || 3001;
const APP_ENV_PROFILE = (process.env.APP_ENV_PROFILE || process.env.NODE_ENV || 'dev').toLowerCase();
const MAX_REQUIREMENT_LENGTH = 4000;
const MAX_SCENARIO_LENGTH = 80;
const MAX_ANNOTATIONS = 50;
const MAX_ANNOTATION_QUOTE_LENGTH = 1000;
const MAX_ANNOTATION_CONTENT_LENGTH = 4000;
const REQUIRED_SECTION_HEADINGS = [
  '产品定位',
  '用户画像',
  '核心用户旅程',
  '功能列表',
  '每个功能的详细说明',
  '非功能需求',
  '技术架构建议',
  'AI 能力使用点',
  '商业化路径',
];
const SECTION_DEFINITIONS = REQUIRED_SECTION_HEADINGS.map((title, index) => ({ id: index + 1, title }));
const SECTION_TITLE_BY_ID = new Map(SECTION_DEFINITIONS.map((item) => [item.id, item.title]));
const MIN_SECTION_CONTENT_CHARS = Math.max(Number(process.env.MIN_SECTION_CONTENT_CHARS) || 120, 40);
const MIN_SECTION_CONTENT_CHARS_SEGMENT = Math.max(Number(process.env.MIN_SECTION_CONTENT_CHARS_SEGMENT) || 40, 20);
const SECTION_QUALITY_SIGNALS = {
  1: { minHits: 2, terms: ['核心价值', '目标用户', '差异化', '定位', '场景'] },
  2: { minHits: 2, terms: ['用户', '画像', '场景', '痛点', '行为'] },
  3: { minHits: 2, terms: ['旅程', '触发', '路径', '步骤', '决策', '情绪'] },
  4: { minHits: 2, terms: ['功能', '模块', 'mvp', '优先级', '列表'] },
  5: { minHits: 2, terms: ['输入', '输出', '系统', '交互', '规则', '流程'] },
  6: { minHits: 2, terms: ['性能', '兼容', '稳定', '安全', '可维护'] },
  7: { minHits: 2, terms: ['架构', '模块', '服务', '数据', '部署', '技术栈'] },
  8: { minHits: 1, terms: ['AI', '模型', '推荐', '生成', '自动化', '能力'] },
  9: { minHits: 2, terms: ['商业化', '变现', '订阅', '广告', '收入', '指标'] },
};
const GEN_TOTAL_BUDGET_MS = Math.max(Number(process.env.GEN_TOTAL_BUDGET_MS) || 480000, 60000);
const REASON_MAX_MS = Math.max(Number(process.env.REASON_MAX_MS) || 90000, 5000);
const GENERATE_MAX_MS = Math.max(Number(process.env.GENERATE_MAX_MS) || 180000, 5000);
const CONTINUE_MAX_MS = Math.max(Number(process.env.CONTINUE_MAX_MS) || 90000, 5000);
const DRAFT_MAX_MS = Math.max(Number(process.env.DRAFT_MAX_MS) || 120000, 5000);
const GENERATE_STAGE_MAX_ATTEMPTS = Math.max(Number(process.env.GENERATE_STAGE_MAX_ATTEMPTS) || 2, 1);
const SAFETY_MARGIN_MS = Math.max(Number(process.env.SAFETY_MARGIN_MS) || 15000, 1000);
const MAX_FALLBACK_ATTEMPTS_PER_JOB = Math.max(
  Number(process.env.MAX_FALLBACK_ATTEMPTS_PER_JOB) || 2,
  0
);
const MIN_STAGE_TIMEOUT_MS = 5000;
const REVISE_TOTAL_BUDGET_MS = Math.max(Number(process.env.REVISE_TOTAL_BUDGET_MS) || 180000, 60000);
const REVISE_APPLY_MAX_MS = Math.max(Number(process.env.REVISE_APPLY_MAX_MS) || 120000, 10000);
const REVISE_CONSISTENCY_MAX_MS = Math.max(Number(process.env.REVISE_CONSISTENCY_MAX_MS) || 70000, 5000);
const REVISE_CONSISTENCY_MAX_ATTEMPTS = Math.max(
  Number(process.env.REVISE_CONSISTENCY_MAX_ATTEMPTS) || 2,
  1
);
const REVISE_JOB_TTL_MS = Math.max(Number(process.env.REVISE_JOB_TTL_MS) || 30 * 60 * 1000, 60 * 1000);
const MAX_REVISE_JOBS = Math.max(Number(process.env.MAX_REVISE_JOBS) || 300, 50);
const JOB_TTL_MS = Math.max(Number(process.env.GENERATE_JOB_TTL_MS) || 30 * 60 * 1000, 60 * 1000);
const MAX_GENERATE_JOBS = Math.max(Number(process.env.MAX_GENERATE_JOBS) || 200, 20);
const AUTH_REQUIRED = process.env.AUTH_REQUIRED !== '0';
const JWT_SECRET = sanitizeEnvSecret(process.env.JWT_SECRET, 'change-this-secret-in-prod');
const ACCESS_TOKEN_TTL_MS = Math.max(Number(process.env.ACCESS_TOKEN_TTL_MS) || 15 * 60 * 1000, 60 * 1000);
const REFRESH_TOKEN_TTL_MS = Math.max(Number(process.env.REFRESH_TOKEN_TTL_MS) || 30 * 24 * 60 * 60 * 1000, 60 * 1000);
const RATE_LIMIT_WINDOW_MS = Math.max(Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000, 1000);
const DEFAULT_RATE_LIMIT_PER_WINDOW = Math.max(Number(process.env.DEFAULT_RATE_LIMIT_PER_WINDOW) || 60, 10);
const WRITE_RATE_LIMIT_PER_WINDOW = Math.max(Number(process.env.WRITE_RATE_LIMIT_PER_WINDOW) || 30, 10);
const STATUS_POLL_RATE_LIMIT_PER_WINDOW = Math.max(
  Number(process.env.STATUS_POLL_RATE_LIMIT_PER_WINDOW) || 240,
  30
);
const AUTH_BILLING_RATE_LIMIT_PER_WINDOW = Math.max(
  Number(process.env.AUTH_BILLING_RATE_LIMIT_PER_WINDOW) || 60,
  20
);
const USER_STORE_FILE = path.resolve(__dirname, './data/platform-store.json');
const JOB_STORE_FILE = path.resolve(__dirname, './data/job-store.json');
const ENABLE_STRUCTURED_LOG = process.env.STRUCTURED_LOG !== '0';
const SENTRY_DSN = (process.env.SENTRY_DSN || '').trim();
const SUPPORTED_PAYMENT_PROVIDERS = new Set(['stripe', 'wechatpay', 'alipay']);
const PAYMENT_CHECKOUT_BASE_URL = (process.env.PAYMENT_CHECKOUT_BASE_URL || '').trim().replace(/\/+$/, '');
const ANON_TRIAL_TOKEN_TTL_MS = Math.max(Number(process.env.ANON_TRIAL_TOKEN_TTL_MS) || 30 * 60 * 1000, 60 * 1000);
const ANON_TRIAL_MAX_PREVIEW_CHARS = Math.max(Number(process.env.ANON_TRIAL_MAX_PREVIEW_CHARS) || 20000, 2000);
const ANON_QUOTA_ENFORCED = process.env.ANON_QUOTA_ENFORCED
  ? process.env.ANON_QUOTA_ENFORCED !== '0'
  : !['dev', 'test'].includes(APP_ENV_PROFILE);
const REVISE_SYNC_MAX_DOC_LENGTH = Math.max(Number(process.env.REVISE_SYNC_MAX_DOC_LENGTH) || 6000, 1000);
const REVISE_SYNC_MAX_ANNOTATIONS = Math.max(Number(process.env.REVISE_SYNC_MAX_ANNOTATIONS) || 3, 1);
const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    cycle: ['monthly'],
    priceCny: { monthly: 0, yearly: 0 },
    priceUsd: { monthly: 0, yearly: 0 },
    limits: { monthlyGenerate: 1, monthlyRevise: 3, monthlyTokens: 400000, maxConcurrentJobs: 1, perMinRequests: 30 },
    entitlements: { canDownload: false },
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    cycle: ['monthly'],
    priceCny: { monthly: 99, yearly: 99 },
    priceUsd: { monthly: 15, yearly: 15 },
    limits: { monthlyGenerate: 999999, monthlyRevise: 999999, monthlyTokens: 50000000, maxConcurrentJobs: 5, perMinRequests: 240 },
    entitlements: { canDownload: true },
  },
};
const frontendDistDir = path.resolve(__dirname, '../frontend/dist');
const frontendIndexFile = path.join(frontendDistDir, 'index.html');
const hasFrontendDist = fs.existsSync(frontendIndexFile);

function sanitizeEnvSecret(value, fallback) {
  const v = typeof value === 'string' ? value.trim() : '';
  return v || fallback;
}

const app = express();
const corsOrigin = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

app.use(cors(
  corsOrigin.length > 0
    ? {
        origin(origin, callback) {
          if (!origin || corsOrigin.includes(origin)) {
            callback(null, true);
            return;
          }
          callback(new Error('当前来源未被 CORS_ORIGIN 允许'));
        },
      }
    : undefined
));
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] ? sanitizeText(req.headers['x-request-id'], 120) : randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
});
app.use((req, res, next) => {
  if (!ENABLE_STRUCTURED_LOG) return next();
  const startedAt = Date.now();
  res.on('finish', () => {
    const userId = req.authUser?.id || '';
    const line = {
      level: res.statusCode >= 500 ? 'error' : (res.statusCode >= 400 ? 'warn' : 'info'),
      at: nowIso(),
      requestId: req.requestId || '',
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      userId,
      ip: req.ip,
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(line));
  });
  next();
});

const jsonHeader = { 'Content-Type': 'application/json; charset=utf-8' };

const asyncRoute = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res)).catch(next);
};

const usersById = new Map();
const usersByEmail = new Map();
const refreshTokens = new Map();
const subscriptionsByUser = new Map();
const usageByUserMonth = new Map();
const paymentEventsByUser = new Map();
const rateLimitWindows = new Map();
const anonTrialByFingerprint = new Map();
const anonTrialByIp = new Map();
const anonTrialTickets = new Map();
const anonUsageByMonth = new Map();

let persistUserTimer = null;
let persistJobTimer = null;

function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function monthKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 7);
}

function encodeBase64Url(input) {
  return Buffer.from(input).toString('base64url');
}

function decodeBase64Url(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function signToken(payload) {
  const header = encodeBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = encodeBase64Url(JSON.stringify(payload));
  const sig = createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expected = createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(decodeBase64Url(body));
    if (!payload || typeof payload !== 'object') return null;
    if (!payload.exp || Date.now() > Number(payload.exp)) return null;
    return payload;
  } catch {
    return null;
  }
}

function hashPassword(password, salt = randomUUID().replace(/-/g, '')) {
  const digest = pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  return `${salt}:${digest}`;
}

function verifyPassword(password, passwordHash) {
  if (!passwordHash || typeof passwordHash !== 'string' || !passwordHash.includes(':')) return false;
  const [salt, stored] = passwordHash.split(':');
  const computed = pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  const a = Buffer.from(stored);
  const b = Buffer.from(computed);
  return a.length === b.length && timingSafeEqual(a, b);
}

function buildAuthResponse(user) {
  const accessToken = signToken({
    sub: user.id,
    email: user.email,
    name: user.name || '',
    type: 'access',
    iat: Date.now(),
    exp: Date.now() + ACCESS_TOKEN_TTL_MS,
  });
  const refreshToken = randomUUID();
  refreshTokens.set(refreshToken, {
    userId: user.id,
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
    createdAt: Date.now(),
  });
  schedulePersistUsers();
  return { accessToken, refreshToken };
}

function cleanupRefreshTokens() {
  const now = Date.now();
  for (const [token, item] of refreshTokens.entries()) {
    if (!item || item.expiresAt <= now) refreshTokens.delete(token);
  }
}

function sanitizeEmail(value) {
  return sanitizeText(String(value || '').toLowerCase(), 200);
}

function sanitizePassword(value) {
  return sanitizeText(String(value || ''), 200);
}

function sanitizeName(value) {
  return sanitizeText(String(value || ''), 80);
}

function getUserPlan(userId) {
  const sub = subscriptionsByUser.get(userId);
  if (!sub || sub.status !== 'active') return PLANS.free;
  return PLANS[sub.planId] || PLANS.free;
}

function getUsageRecord(userId, key = monthKey()) {
  const mapKey = `${userId}:${key}`;
  const existing = usageByUserMonth.get(mapKey);
  if (existing) return existing;
  const created = { period: key, userId, generateCount: 0, reviseCount: 0, tokenCount: 0 };
  usageByUserMonth.set(mapKey, created);
  return created;
}

function getQuotaRemaining(userId, key = monthKey()) {
  const usage = getUsageRecord(userId, key);
  const plan = getUserPlan(userId);
  const lim = plan.limits;
  return {
    period: key,
    generateRemaining: Math.max(lim.monthlyGenerate - usage.generateCount, 0),
    reviseRemaining: Math.max(lim.monthlyRevise - usage.reviseCount, 0),
    tokenRemaining: Math.max(lim.monthlyTokens - usage.tokenCount, 0),
  };
}

function estimateTokensFromText(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

function getConcurrentJobsCount(userId) {
  let count = 0;
  for (const job of generationJobs.values()) {
    if (job?.payload?.userId === userId && (job.status === 'queued' || job.status === 'running')) count += 1;
  }
  for (const job of reviseConsistencyJobs.values()) {
    if (job?.payload?.userId === userId && (job.status === 'queued' || job.status === 'running')) count += 1;
  }
  return count;
}

function enforceQuota(userId, action, estimatedTokens = 0) {
  const plan = getUserPlan(userId);
  const limits = plan.limits;
  const usage = getUsageRecord(userId);
  if (action === 'generate' && usage.generateCount >= limits.monthlyGenerate) {
    const err = new Error(`本月生成次数已达上限（${limits.monthlyGenerate}），请升级月订阅后继续`);
    err.code = 'monthly_quota_exceeded';
    throw err;
  }
  if (action === 'revise' && usage.reviseCount >= limits.monthlyRevise) {
    const err = new Error(`本月修订次数已达上限（${limits.monthlyRevise}），请升级月订阅后继续`);
    err.code = 'monthly_quota_exceeded';
    throw err;
  }
  if (usage.tokenCount + estimatedTokens > limits.monthlyTokens) {
    const err = new Error(`本月模型预算已达上限（${limits.monthlyTokens} tokens），请升级月订阅后继续`);
    err.code = 'monthly_quota_exceeded';
    throw err;
  }
  const concurrent = getConcurrentJobsCount(userId);
  if (concurrent >= limits.maxConcurrentJobs) {
    throw new Error(`并发任务已达上限（${limits.maxConcurrentJobs}），请稍后再试`);
  }
}

function consumeQuota(userId, action, estimatedTokens = 0) {
  const usage = getUsageRecord(userId);
  if (action === 'generate') usage.generateCount += 1;
  if (action === 'revise') usage.reviseCount += 1;
  usage.tokenCount += Math.max(estimatedTokens, 0);
  usageByUserMonth.set(`${userId}:${usage.period}`, usage);
  schedulePersistUsers();
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name || '',
    createdAt: user.createdAt,
  };
}

function createDefaultSubscription(userId) {
  const sub = {
    userId,
    planId: 'free',
    cycle: 'monthly',
    status: 'none',
    renewAt: null,
    startedAt: nowIso(),
    updatedAt: nowIso(),
  };
  subscriptionsByUser.set(userId, sub);
}

function schedulePersistUsers() {
  if (persistUserTimer) return;
  persistUserTimer = setTimeout(() => {
    persistUserTimer = null;
    persistPlatformState();
  }, 80);
}

function schedulePersistJobs() {
  if (persistJobTimer) return;
  persistJobTimer = setTimeout(() => {
    persistJobTimer = null;
    persistQueueState();
  }, 80);
}

function persistPlatformState() {
  try {
    ensureDirFor(USER_STORE_FILE);
    const payload = {
      users: [...usersById.values()],
      refreshTokens: [...refreshTokens.entries()],
      subscriptions: [...subscriptionsByUser.values()],
      usageByUserMonth: [...usageByUserMonth.values()],
      anonUsageByMonth: [...anonUsageByMonth.values()],
      paymentEventsByUser: [...paymentEventsByUser.entries()],
      anonTrialByFingerprint: [...anonTrialByFingerprint.entries()],
      anonTrialByIp: [...anonTrialByIp.entries()],
      anonTrialTickets: [...anonTrialTickets.entries()],
      updatedAt: nowIso(),
    };
    fs.writeFileSync(USER_STORE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (error) {
    console.error('[persistPlatformState]', error);
  }
}

function loadPlatformState() {
  try {
    if (!fs.existsSync(USER_STORE_FILE)) return;
    const raw = fs.readFileSync(USER_STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const users = Array.isArray(parsed.users) ? parsed.users : [];
    for (const user of users) {
      if (!user?.id || !user?.email) continue;
      usersById.set(user.id, user);
      usersByEmail.set(user.email, user.id);
    }
    const tokenList = Array.isArray(parsed.refreshTokens) ? parsed.refreshTokens : [];
    for (const item of tokenList) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      refreshTokens.set(item[0], item[1]);
    }
    const subs = Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
    for (const sub of subs) {
      if (!sub?.userId) continue;
      subscriptionsByUser.set(sub.userId, sub);
    }
    const usage = Array.isArray(parsed.usageByUserMonth)
      ? parsed.usageByUserMonth
      : (Array.isArray(parsed.usageByUserDay) ? parsed.usageByUserDay : []);
    for (const u of usage) {
      const period = u?.period || u?.date;
      if (!u?.userId || !period) continue;
      const record = {
        period,
        userId: u.userId,
        generateCount: Number(u.generateCount) || 0,
        reviseCount: Number(u.reviseCount) || 0,
        tokenCount: Number(u.tokenCount) || 0,
      };
      usageByUserMonth.set(`${record.userId}:${record.period}`, record);
    }
    const anonUsage = Array.isArray(parsed.anonUsageByMonth) ? parsed.anonUsageByMonth : [];
    for (const u of anonUsage) {
      const period = sanitizeText(u?.period, 20);
      const fingerprint = sanitizeText(u?.fingerprint, 200);
      const ip = sanitizeText(u?.ip, 200);
      if (!period || !fingerprint || !ip) continue;
      anonUsageByMonth.set(`${period}:${fingerprint}:${ip}`, {
        period,
        fingerprint,
        ip,
        generateCount: Number(u?.generateCount) || 0,
        reviseCount: Number(u?.reviseCount) || 0,
        tokenCount: Number(u?.tokenCount) || 0,
        claimedByUserId: sanitizeText(u?.claimedByUserId, 80),
      });
    }
    const paymentEntries = Array.isArray(parsed.paymentEventsByUser) ? parsed.paymentEventsByUser : [];
    for (const item of paymentEntries) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      paymentEventsByUser.set(item[0], Array.isArray(item[1]) ? item[1] : []);
    }
    const anonByFp = Array.isArray(parsed.anonTrialByFingerprint) ? parsed.anonTrialByFingerprint : [];
    for (const item of anonByFp) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      anonTrialByFingerprint.set(item[0], item[1]);
    }
    const anonByIp = Array.isArray(parsed.anonTrialByIp) ? parsed.anonTrialByIp : [];
    for (const item of anonByIp) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      anonTrialByIp.set(item[0], item[1]);
    }
    const tickets = Array.isArray(parsed.anonTrialTickets) ? parsed.anonTrialTickets : [];
    for (const item of tickets) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      anonTrialTickets.set(item[0], item[1]);
    }
    cleanupRefreshTokens();
  } catch (error) {
    console.error('[loadPlatformState]', error);
  }
}

function serializeJob(job) {
  if (!job) return null;
  return {
    ...job,
    payload: job.payload || {},
  };
}

function persistQueueState() {
  try {
    ensureDirFor(JOB_STORE_FILE);
    const payload = {
      generationJobs: [...generationJobs.values()].map(serializeJob),
      generationQueue: [...generationQueue],
      reviseConsistencyJobs: [...reviseConsistencyJobs.values()].map(serializeJob),
      reviseConsistencyQueue: [...reviseConsistencyQueue],
      updatedAt: nowIso(),
    };
    fs.writeFileSync(JOB_STORE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (error) {
    console.error('[persistQueueState]', error);
  }
}

function loadQueueState() {
  try {
    if (!fs.existsSync(JOB_STORE_FILE)) return;
    const raw = fs.readFileSync(JOB_STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const genJobs = Array.isArray(parsed.generationJobs) ? parsed.generationJobs : [];
    const revJobs = Array.isArray(parsed.reviseConsistencyJobs) ? parsed.reviseConsistencyJobs : [];
    const loadedAt = Date.now();
    for (const job of genJobs) {
      if (!job?.id) continue;
      const restored = {
        ...job,
        status: job.status === 'completed' || job.status === 'failed' ? job.status : 'queued',
        stage:
          job.status === 'completed' || job.status === 'failed'
            ? job.stage
            : (job.stage?.startsWith('running_') ? job.stage : 'running_draft'),
        lifecycle:
          job.status === 'completed' || job.status === 'failed'
            ? job.lifecycle
            : (job.stage?.startsWith('running_') ? job.stage : 'running_draft'),
        updatedAt: loadedAt,
      };
      generationJobs.set(restored.id, restored);
      if (restored.status === 'queued') generationQueue.push(restored.id);
    }
    for (const job of revJobs) {
      if (!job?.id) continue;
      const restored = {
        ...job,
        status: job.status === 'completed' || job.status === 'failed' ? job.status : 'queued',
        updatedAt: loadedAt,
      };
      reviseConsistencyJobs.set(restored.id, restored);
      if (restored.status === 'queued') reviseConsistencyQueue.push(restored.id);
    }
  } catch (error) {
    console.error('[loadQueueState]', error);
  }
}

function appendPaymentEvent(userId, event) {
  const list = paymentEventsByUser.get(userId) || [];
  list.unshift({
    id: randomUUID(),
    createdAt: nowIso(),
    ...event,
  });
  paymentEventsByUser.set(userId, list.slice(0, 200));
  schedulePersistUsers();
}

function buildPlanResponse(userId) {
  const sub = subscriptionsByUser.get(userId);
  const plan = getUserPlan(userId);
  const entitlements = {
    canDownload: Boolean(plan.entitlements?.canDownload),
    canGenerate: true,
    canRevise: true,
  };
  return {
    plan: plan.id,
    planName: plan.name,
    subscription: sub || {
      userId,
      planId: 'free',
      cycle: 'monthly',
      status: 'none',
      renewAt: null,
      startedAt: null,
      updatedAt: null,
    },
    quotaRemaining: getQuotaRemaining(userId),
    limits: plan.limits,
    entitlements,
  };
}

function buildAnonymousPlanResponse(req) {
  const limits = PLANS.free.limits;
  if (!ANON_QUOTA_ENFORCED) {
    return {
      plan: PLANS.free.id,
      quotaRemaining: {
        period: monthKey(),
        generateRemaining: 999999,
        reviseRemaining: 999999,
        tokenRemaining: limits.monthlyTokens,
      },
      entitlements: {
        canDownload: false,
        canGenerate: true,
        canRevise: true,
      },
    };
  }
  const fingerprint = getDeviceFingerprint(req);
  const ip = getClientIp(req);
  const usage = fingerprint
    ? getAnonUsageRecord(fingerprint, ip)
    : { period: monthKey(), generateCount: 0, reviseCount: 0, tokenCount: 0 };
  const quotaRemaining = {
    period: usage.period || monthKey(),
    generateRemaining: Math.max(1 - (usage.generateCount || 0), 0),
    reviseRemaining: Math.max(3 - (usage.reviseCount || 0), 0),
    tokenRemaining: Math.max(limits.monthlyTokens - (usage.tokenCount || 0), 0),
  };
  return {
    plan: PLANS.free.id,
    quotaRemaining,
    entitlements: {
      canDownload: false,
      canGenerate: quotaRemaining.generateRemaining > 0 && quotaRemaining.tokenRemaining > 0,
      canRevise: quotaRemaining.reviseRemaining > 0 && quotaRemaining.tokenRemaining > 0,
    },
  };
}

function resolveRequestPlanInfo(req) {
  if (req.authUser?.id) {
    return req.planInfo || buildPlanResponse(req.authUser.id);
  }
  return buildAnonymousPlanResponse(req);
}

function cleanupAnonTrialRecords() {
  const now = Date.now();
  for (const [token, record] of anonTrialTickets.entries()) {
    if (!record || record.expiresAt <= now || record.usedAt) {
      anonTrialTickets.delete(token);
    }
  }
}

function claimAnonTrial({ fingerprint, ip }) {
  cleanupAnonTrialRecords();
  const fpUsedAt = anonTrialByFingerprint.get(fingerprint);
  const ipUsedAt = anonTrialByIp.get(ip);
  if (fpUsedAt || ipUsedAt) {
    const err = new Error('匿名试用机会已用完，请注册登录继续');
    err.code = 'trial_exhausted';
    throw err;
  }
  const payload = {
    type: 'anon_trial',
    fingerprint,
    ip,
    iat: Date.now(),
    exp: Date.now() + ANON_TRIAL_TOKEN_TTL_MS,
  };
  const token = signToken(payload);
  anonTrialTickets.set(token, {
    fingerprint,
    ip,
    createdAt: Date.now(),
    expiresAt: payload.exp,
    usedAt: null,
  });
  anonTrialByFingerprint.set(fingerprint, nowIso());
  anonTrialByIp.set(ip, nowIso());
  schedulePersistUsers();
  return token;
}

function verifyAnonTrialToken(token, fingerprint, ip) {
  cleanupAnonTrialRecords();
  const payload = verifyToken(token);
  if (!payload || payload.type !== 'anon_trial') return null;
  const ticket = anonTrialTickets.get(token);
  if (!ticket || ticket.usedAt) return null;
  if (payload.fingerprint !== fingerprint || payload.ip !== ip) return null;
  if (ticket.expiresAt <= Date.now()) return null;
  return ticket;
}

function sanitizeText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function getDeviceFingerprint(req) {
  const fp = sanitizeText(req.headers?.['x-device-fingerprint'] || req.body?.fingerprint || '', 200);
  return fp;
}

function getClientIp(req) {
  return sanitizeText(req.ip || req.headers['x-forwarded-for'] || '', 200) || 'unknown';
}

function requireAuth(req, res, next) {
  if (!AUTH_REQUIRED) {
    req.authUser = null;
    return next();
  }
  const auth = sanitizeText(req.headers?.authorization || '', 1000);
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: '未登录或登录已过期' });
  }
  const token = auth.slice(7).trim();
  const payload = verifyToken(token);
  if (!payload || payload.type !== 'access' || !payload.sub) {
    return res.status(401).json({ success: false, message: '访问令牌无效，请重新登录' });
  }
  const user = usersById.get(payload.sub);
  if (!user) {
    return res.status(401).json({ success: false, message: '用户不存在，请重新登录' });
  }
  req.authUser = sanitizeUser(user);
  return next();
}

function attachOptionalAuth(req, res, next) {
  const auth = sanitizeText(req.headers?.authorization || '', 1000);
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    const payload = verifyToken(token);
    if (payload && payload.type === 'access' && payload.sub) {
      const user = usersById.get(payload.sub);
      if (user) {
        req.authUser = sanitizeUser(user);
      }
    }
  }
  next();
}

function requireRateLimit(req, res, next) {
  const requestPath = req.path || req.originalUrl || '';
  const normalizedPath = requestPath.startsWith('/api/') ? requestPath : `/api${requestPath}`;
  const isStatusPoll =
    req.method === 'GET'
    && (
      /^\/api\/document\/generate\/[^/]+$/.test(normalizedPath)
      || /^\/api\/document\/revise\/[^/]+$/.test(normalizedPath)
      || /^\/api\/document\/revise\/repair\/[^/]+$/.test(normalizedPath)
    );
  const isAuthOrBilling =
    normalizedPath.startsWith('/api/auth/')
    || normalizedPath.startsWith('/api/billing/')
    || normalizedPath.startsWith('/api/subscription/')
    || normalizedPath.startsWith('/api/webhooks/');
  let userId = req.authUser?.id || '';
  if (!userId) {
    const auth = sanitizeText(req.headers?.authorization || '', 1000);
    if (auth.startsWith('Bearer ')) {
      const payload = verifyToken(auth.slice(7).trim());
      if (payload?.sub) userId = payload.sub;
    }
  }
  const bucket = isStatusPoll ? 'status-poll' : (isAuthOrBilling ? 'auth-billing' : 'write');
  const key = `${userId || `ip:${req.ip}`}:${bucket}`;
  const plan = userId ? getUserPlan(userId) : PLANS.free;
  const limit = isStatusPoll
    ? STATUS_POLL_RATE_LIMIT_PER_WINDOW
    : isAuthOrBilling
      ? AUTH_BILLING_RATE_LIMIT_PER_WINDOW
      : Math.min(plan.limits?.perMinRequests || DEFAULT_RATE_LIMIT_PER_WINDOW, WRITE_RATE_LIMIT_PER_WINDOW);
  const now = Date.now();
  const current = rateLimitWindows.get(key);
  if (!current || now - current.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
    rateLimitWindows.set(key, { windowStartedAt: now, count: 1 });
    return next();
  }
  if (current.count >= limit) {
    return res.status(429).json({
      success: false,
      code: 'rate_limited',
      message: `请求过于频繁，请稍后再试（限流 ${limit}/分钟）`,
    });
  }
  current.count += 1;
  rateLimitWindows.set(key, current);
  return next();
}

function attachPlanInfo(req, res, next) {
  if (!req.authUser?.id) return next();
  const planInfo = buildPlanResponse(req.authUser.id);
  req.planInfo = planInfo;
  next();
}

function getAnonUsageRecord(fingerprint, ip, period = monthKey()) {
  const key = `${period}:${fingerprint}:${ip}`;
  const existing = anonUsageByMonth.get(key);
  if (existing) return existing;
  const created = {
    period,
    fingerprint,
    ip,
    generateCount: 0,
    reviseCount: 0,
    tokenCount: 0,
    claimedByUserId: '',
  };
  anonUsageByMonth.set(key, created);
  return created;
}

function enforceAnonQuota(req, action, estimatedTokens = 0) {
  if (!ANON_QUOTA_ENFORCED) {
    return null;
  }
  const fingerprint = getDeviceFingerprint(req);
  if (!fingerprint) {
    const err = new Error('匿名使用需要设备指纹');
    err.code = 'invalid_fingerprint';
    throw err;
  }
  const ip = getClientIp(req);
  const usage = getAnonUsageRecord(fingerprint, ip);
  if (action === 'generate' && usage.generateCount >= 1) {
    const err = new Error('匿名试用生成次数已用完，请登录继续');
    err.code = 'trial_exhausted';
    throw err;
  }
  if (action === 'revise' && usage.reviseCount >= 3) {
    const err = new Error('匿名试用修订次数已用完，请登录继续');
    err.code = 'trial_exhausted';
    throw err;
  }
  if (usage.tokenCount + estimatedTokens > PLANS.free.limits.monthlyTokens) {
    const err = new Error('匿名试用额度已用完，请登录继续');
    err.code = 'trial_exhausted';
    throw err;
  }
  return usage;
}

function consumeAnonQuota(req, action, estimatedTokens = 0) {
  if (!ANON_QUOTA_ENFORCED) {
    return;
  }
  const fingerprint = getDeviceFingerprint(req);
  const ip = getClientIp(req);
  const usage = getAnonUsageRecord(fingerprint, ip);
  if (action === 'generate') usage.generateCount += 1;
  if (action === 'revise') usage.reviseCount += 1;
  usage.tokenCount += Math.max(estimatedTokens, 0);
  anonUsageByMonth.set(`${usage.period}:${usage.fingerprint}:${usage.ip}`, usage);
  schedulePersistUsers();
}

function claimAnonUsageToUser(req, userId) {
  const fingerprint = getDeviceFingerprint(req);
  if (!fingerprint) return null;
  const ip = getClientIp(req);
  const usage = getAnonUsageRecord(fingerprint, ip);
  if (!usage || usage.claimedByUserId) return null;
  if (usage.generateCount <= 0 && usage.reviseCount <= 0 && usage.tokenCount <= 0) return null;
  const userUsage = getUsageRecord(userId, usage.period);
  userUsage.generateCount += Math.min(usage.generateCount, PLANS.free.limits.monthlyGenerate);
  userUsage.reviseCount += Math.min(usage.reviseCount, PLANS.free.limits.monthlyRevise);
  userUsage.tokenCount += Math.min(usage.tokenCount, PLANS.free.limits.monthlyTokens);
  usage.claimedByUserId = userId;
  anonUsageByMonth.set(`${usage.period}:${usage.fingerprint}:${usage.ip}`, usage);
  usageByUserMonth.set(`${userUsage.userId}:${userUsage.period}`, userUsage);
  schedulePersistUsers();
  return usage;
}

function sanitizeClarificationAnswers(input) {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, 5)
    .map((item) => ({
      q: sanitizeText(item?.q, 300),
      a: sanitizeText(item?.a, 2000),
    }))
    .filter((item) => item.q);
}

function sanitizeAnnotations(input) {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, MAX_ANNOTATIONS)
    .map((item) => {
      const type = item?.type;
      const requestedPolicy = sanitizeText(item?.anchorPolicy, 50);
      const defaultPolicy = type === 'modify'
        ? 'replace_selected'
        : type === 'delete'
          ? 'delete_selected'
          : type === 'supplement'
            ? 'insert_after_selected'
            : '';
      return {
        type,
      quote: sanitizeText(item?.quote, MAX_ANNOTATION_QUOTE_LENGTH),
      content: sanitizeText(item?.content, MAX_ANNOTATION_CONTENT_LENGTH),
      note: sanitizeText(item?.note, 1000),
        anchorPolicy: requestedPolicy || defaultPolicy,
      };
    })
    .filter((item) =>
      ['modify', 'delete', 'supplement'].includes(item.type) &&
      item.quote
    );
}

function validateRevisionAnnotations(annotations) {
  for (const item of annotations) {
    if ((item.type === 'modify' || item.type === 'supplement') && !item.content) {
      throw new Error(`${item.type === 'modify' ? '修改' : '补充'}标注缺少输入内容`);
    }
  }
}

function parseRevisionConsistencyResult(raw, fallbackDocument) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    return {
      finalDocument: fallbackDocument,
      linkedUpdates: [],
      consistencyUpdated: false,
    };
  }
  try {
    const parsed = JSON.parse(text);
    const finalDocument = typeof parsed.finalDocument === 'string' ? parsed.finalDocument.trim() : '';
    const linkedUpdates = Array.isArray(parsed.linkedUpdates)
      ? parsed.linkedUpdates
          .map((item) => ({
            section: sanitizeText(item?.section, 120),
            summary: sanitizeText(item?.summary, 500),
            reason: sanitizeText(item?.reason, 500),
          }))
          .filter((item) => item.section && item.summary)
      : [];
    return {
      finalDocument: normalizePrimarySectionNumbers(finalDocument || fallbackDocument),
      linkedUpdates,
      consistencyUpdated: linkedUpdates.length > 0,
    };
  } catch {
    return {
      finalDocument: normalizePrimarySectionNumbers(text || fallbackDocument),
      linkedUpdates: [],
      consistencyUpdated: false,
    };
  }
}

function createEmptySectionMap() {
  const map = new Map();
  for (const item of SECTION_DEFINITIONS) {
    map.set(item.id, { id: item.id, title: item.title, content: '' });
  }
  return map;
}

function sectionMapToJson(sectionMap) {
  return {
    sections: SECTION_DEFINITIONS.map((item) => ({
      id: item.id,
      title: item.title,
      content: sanitizeText(sectionMap.get(item.id)?.content || '', 200000),
    })),
  };
}

function parseSectionsJson(raw, { allowedIds = null, minChars = MIN_SECTION_CONTENT_CHARS_SEGMENT } = {}) {
  const invalidSectionIds = new Set();
  const qualityWarnings = [];
  const sectionsById = new Map();
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    return {
      ok: false,
      error: '输出为空',
      sectionsById,
      invalidSectionIds: [],
      missingSectionIds: allowedIds ? [...allowedIds] : SECTION_DEFINITIONS.map((item) => item.id),
      qualityWarnings,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: 'JSON 解析失败',
      sectionsById,
      invalidSectionIds: [],
      missingSectionIds: allowedIds ? [...allowedIds] : SECTION_DEFINITIONS.map((item) => item.id),
      qualityWarnings: ['模型返回非 JSON，已触发该阶段重试'],
    };
  }

  const list = Array.isArray(parsed?.sections) ? parsed.sections : null;
  if (!list) {
    return {
      ok: false,
      error: 'JSON 缺少 sections 数组',
      sectionsById,
      invalidSectionIds: [],
      missingSectionIds: allowedIds ? [...allowedIds] : SECTION_DEFINITIONS.map((item) => item.id),
      qualityWarnings: ['模型返回 JSON 结构不符合协议（缺少 sections）'],
    };
  }

  for (const item of list) {
    const id = Number(item?.id);
    const title = sanitizeText(item?.title, 80);
    const content = String(item?.content || '').trim();
    if (!Number.isInteger(id) || !SECTION_TITLE_BY_ID.has(id)) {
      if (Number.isInteger(id)) invalidSectionIds.add(id);
      continue;
    }
    const expectedTitle = SECTION_TITLE_BY_ID.get(id);
    if (!title || title !== expectedTitle) {
      invalidSectionIds.add(id);
      qualityWarnings.push(`章节 ${id} 标题不匹配，期望「${expectedTitle}」`);
      continue;
    }
    if (allowedIds && !allowedIds.has(id)) {
      invalidSectionIds.add(id);
      qualityWarnings.push(`章节 ${id} 不在当前允许范围内`);
      continue;
    }
    if (!content || content.length < minChars) {
      invalidSectionIds.add(id);
      qualityWarnings.push(`章节 ${id} 内容过短（<${minChars}字）`);
      continue;
    }
    if (sectionsById.has(id)) {
      qualityWarnings.push(`章节 ${id} 在 JSON 中重复，已采用最后一次输出`);
    }
    sectionsById.set(id, { id, title: expectedTitle, content });
  }

  const expectedIds = allowedIds ? [...allowedIds] : SECTION_DEFINITIONS.map((item) => item.id);
  const missingSectionIds = expectedIds.filter((id) => !sectionsById.has(id));
  return {
    ok: missingSectionIds.length === 0 && invalidSectionIds.size === 0,
    error: '',
    sectionsById,
    invalidSectionIds: [...invalidSectionIds].sort((a, b) => a - b),
    missingSectionIds,
    qualityWarnings,
  };
}

function applySectionsToMap(sectionMap, sectionsById) {
  for (const [id, section] of sectionsById.entries()) {
    sectionMap.set(id, { id, title: section.title, content: section.content.trim() });
  }
}

function renderSectionMapMarkdown(sectionMap) {
  const chunks = [];
  for (const item of SECTION_DEFINITIONS) {
    const content = String(sectionMap.get(item.id)?.content || '').trim();
    if (!content) continue;
    chunks.push(`## ${item.id}. ${item.title}\n${content}`);
  }
  return chunks.join('\n\n').trim();
}

function buildShingles(text) {
  const normalized = String(text || '').replace(/\s+/g, '').toLowerCase();
  if (!normalized) return new Set();
  const grams = new Set();
  for (let i = 0; i < normalized.length - 1; i += 1) {
    grams.add(normalized.slice(i, i + 2));
  }
  return grams.size > 0 ? grams : new Set([normalized]);
}

function textSimilarity(a, b) {
  const sa = buildShingles(a);
  const sb = buildShingles(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const token of sa) {
    if (sb.has(token)) inter += 1;
  }
  return inter / (sa.size + sb.size - inter);
}

function hasBalancedPairs(text) {
  const pairs = [
    ['(', ')'],
    ['（', '）'],
    ['[', ']'],
    ['{', '}'],
    ['“', '”'],
    ['‘', '’'],
  ];
  for (const [left, right] of pairs) {
    let count = 0;
    for (const ch of String(text || '')) {
      if (ch === left) count += 1;
      if (ch === right) count -= 1;
      if (count < 0) return false;
    }
    if (count !== 0) return false;
  }
  return true;
}

function hasStructuralGap(document) {
  if (!document) return true;
  const trimmed = String(document).trim();
  if (!trimmed) return true;
  const tail = trimmed.slice(-220);
  if (/[，、：\-（([“‘"]$/.test(trimmed)) return true;
  if (/#{1,6}\s*[^\n]*$/.test(tail)) return true;
  if (/\|\s*[-:]+\s*\|?$/.test(tail)) return true;
  if (!/[。！？.!?）\]」』”’]$/.test(trimmed)) return true;
  return !hasBalancedPairs(trimmed);
}

function evaluateSectionMapQuality(sectionMap, glossary = []) {
  const missingSectionIds = [];
  const invalidSectionIds = [];
  const qualityWarnings = [];
  const sections = [];
  for (const item of SECTION_DEFINITIONS) {
    const content = String(sectionMap.get(item.id)?.content || '').trim();
    sections.push({ id: item.id, title: item.title, content });
    if (!content) {
      missingSectionIds.push(item.id);
      continue;
    }
    if (content.length < MIN_SECTION_CONTENT_CHARS) {
      invalidSectionIds.push(item.id);
      qualityWarnings.push(`章节 ${item.id}「${item.title}」信息密度不足（<${MIN_SECTION_CONTENT_CHARS}字）`);
    }
    const signalRule = SECTION_QUALITY_SIGNALS[item.id];
    if (signalRule) {
      const lower = content.toLowerCase();
      const hitCount = signalRule.terms.reduce((acc, term) => (
        lower.includes(String(term).toLowerCase()) ? acc + 1 : acc
      ), 0);
      if (hitCount < signalRule.minHits) {
        invalidSectionIds.push(item.id);
        qualityWarnings.push(
          `章节 ${item.id}「${item.title}」关键信息不足（命中 ${hitCount}/${signalRule.minHits}）`
        );
      }
    }
  }

  for (let i = 0; i < sections.length; i += 1) {
    for (let j = i + 1; j < sections.length; j += 1) {
      const a = sections[i];
      const b = sections[j];
      if (!a.content || !b.content) continue;
      const sim = textSimilarity(a.content.slice(0, 600), b.content.slice(0, 600));
      if (sim >= 0.86) {
        qualityWarnings.push(`章节 ${a.id} 与章节 ${b.id} 内容重复度偏高（${Math.round(sim * 100)}%）`);
      }
    }
  }

  const fullDoc = renderSectionMapMarkdown(sectionMap);
  const lowerDoc = fullDoc.toLowerCase();
  const glossaryList = Array.isArray(glossary) ? glossary : [];
  for (const item of glossaryList) {
    const term = sanitizeText(item?.term, 80);
    const aliases = Array.isArray(item?.aliases) ? item.aliases.map((a) => sanitizeText(a, 80)).filter(Boolean) : [];
    if (!term || aliases.length === 0) continue;
    const hasTerm = lowerDoc.includes(term.toLowerCase());
    const hasAlias = aliases.some((alias) => lowerDoc.includes(alias.toLowerCase()));
    if (hasAlias && !hasTerm) {
      qualityWarnings.push(`术语一致性提示：出现别名但未使用主术语「${term}」`);
    }
  }

  const hasGap = hasStructuralGap(fullDoc);
  if (hasGap) qualityWarnings.push('文档尾部闭合校验未通过（可能存在半句或括号未闭合）');

  const presentCount = 9 - missingSectionIds.length;
  const validCount = 9 - new Set(invalidSectionIds).size;
  let completionScore = Math.round((presentCount / 9) * 70 + (validCount / 9) * 30);
  if (hasGap) completionScore = Math.max(0, completionScore - 10);

  return {
    missingSectionIds,
    invalidSectionIds: [...new Set(invalidSectionIds)].sort((a, b) => a - b),
    missingSections: missingSectionIds.map((id) => SECTION_TITLE_BY_ID.get(id)).filter(Boolean),
    qualityWarnings,
    completionScore,
    hasStructuralGap: hasGap,
    incomplete: missingSectionIds.length > 0 || invalidSectionIds.length > 0 || hasGap,
  };
}

function parseMarkdownToSectionMap(document) {
  const map = createEmptySectionMap();
  const text = String(document || '').trim();
  if (!text) return map;
  const matcher = /^##\s*(\d+)\.\s*([^\n]+)\n([\s\S]*?)(?=^##\s*\d+\.\s*[^\n]+\n|$)/gm;
  let found = null;
  while ((found = matcher.exec(text)) !== null) {
    const id = Number(found[1]);
    const title = sanitizeText(found[2], 80);
    const content = String(found[3] || '').trim();
    if (!Number.isInteger(id) || !SECTION_TITLE_BY_ID.has(id)) continue;
    if (title !== SECTION_TITLE_BY_ID.get(id)) continue;
    if (!content) continue;
    map.set(id, { id, title, content });
  }
  return map;
}

function getMissingSections(document) {
  const quality = evaluateSectionMapQuality(parseMarkdownToSectionMap(document));
  return quality.missingSections;
}

function validateDocumentCompleteness(document, glossary = []) {
  return evaluateSectionMapQuality(parseMarkdownToSectionMap(document), glossary);
}

function extractKeywords(text) {
  if (!text) return [];
  const normalized = String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const words = normalized
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  return [...new Set(words)].slice(0, 30);
}

function locateSectionByHeading(document, heading) {
  const idx = document.indexOf(heading);
  if (idx < 0) return null;
  const nextIndices = REQUIRED_SECTION_HEADINGS
    .map((item) => document.indexOf(item, idx + heading.length))
    .filter((item) => item > idx);
  const end = nextIndices.length > 0 ? Math.min(...nextIndices) : document.length;
  return { start: idx, end };
}

function getAffectedSections(document, annotations) {
  const affected = new Set();
  if (!document || !Array.isArray(annotations) || annotations.length === 0) {
    return [...REQUIRED_SECTION_HEADINGS];
  }

  for (const ann of annotations) {
    const quote = ann.quote || '';
    const content = ann.content || '';
    const tokens = extractKeywords(`${quote} ${content}`);
    const quotePos = quote ? document.indexOf(quote.slice(0, 80)) : -1;

    if (quotePos >= 0) {
      let chosen = null;
      for (const heading of REQUIRED_SECTION_HEADINGS) {
        const range = locateSectionByHeading(document, heading);
        if (!range) continue;
        if (quotePos >= range.start && quotePos < range.end) {
          chosen = heading;
          break;
        }
      }
      if (chosen) affected.add(chosen);
    }

    for (const heading of REQUIRED_SECTION_HEADINGS) {
      const range = locateSectionByHeading(document, heading);
      if (!range) continue;
      const sectionText = document.slice(range.start, range.end).toLowerCase();
      const matched = tokens.some((token) => sectionText.includes(token));
      if (matched) affected.add(heading);
    }
  }

  if (affected.size === 0) {
    return [...REQUIRED_SECTION_HEADINGS];
  }
  return REQUIRED_SECTION_HEADINGS.filter((heading) => affected.has(heading));
}

function shouldRunSyncRevise(document, annotations) {
  return (
    String(document || '').length <= REVISE_SYNC_MAX_DOC_LENGTH
    && Array.isArray(annotations)
    && annotations.length <= REVISE_SYNC_MAX_ANNOTATIONS
  );
}

async function executeReviseConsistencyOnce(appliedDocument, annotations, affectedSections, deadlineAt) {
  const timeoutMs = getStageTimeout(deadlineAt, REVISE_CONSISTENCY_MAX_MS, '一致性联动阶段');
  const raw = await requestLLMWithBudgetAndFallback(
    [
      { role: 'system', content: REVISE_CONSISTENCY_SYSTEM },
      {
        role: 'user',
        content: buildReviseConsistencyUser(appliedDocument, annotations, affectedSections),
      },
    ],
    {
      model: REVISE_CONSISTENCY_MODEL,
      fallbackModel: REVISE_CONSISTENCY_FALLBACK_MODEL,
      stream: false,
      timeout_ms: timeoutMs,
    },
    { allowFallback: true, fallbackAttempts: 0, maxFallbackAttempts: 1 }
  );
  return parseRevisionConsistencyResult(raw, appliedDocument);
}

function applyLocalRevisionFallback(document, annotations) {
  let working = String(document || '');
  let applied = 0;
  for (const ann of annotations) {
    const quote = ann?.quote || '';
    if (!quote) continue;
    const idx = working.indexOf(quote);
    if (idx < 0) continue;
    const before = working.slice(0, idx);
    const selected = working.slice(idx, idx + quote.length);
    const after = working.slice(idx + quote.length);
    if (ann.type === 'modify') {
      const replacement = (ann.content || '').trim();
      if (!replacement) continue;
      working = `${before}${replacement}${after}`;
      applied += 1;
      continue;
    }
    if (ann.type === 'delete') {
      working = `${before}${after}`;
      applied += 1;
      continue;
    }
    if (ann.type === 'supplement') {
      const addition = (ann.content || '').trim();
      if (!addition) continue;
      const glue = /[。！？!?.]$/.test(selected) ? '\n' : '，';
      working = `${before}${selected}${glue}${addition}${after}`;
      applied += 1;
    }
  }
  return {
    document: working,
    applied,
    used: applied > 0 && working.trim().length > 0,
  };
}

function mergeContinuation(partialDocument, continuation) {
  const left = partialDocument.trimEnd();
  const right = continuation.trim();
  if (!right) return left;
  if (left.endsWith(right)) return left;
  return `${left}\n\n${right}`;
}

function escapeRegExp(input) {
  return String(input || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePrimarySectionNumbers(document) {
  const source = String(document || '').trim();
  if (!source) return source;
  let normalized = source;
  let seq = 1;
  for (const heading of REQUIRED_SECTION_HEADINGS) {
    const pattern = new RegExp(
      `^\\s{0,3}##\\s*(?:\\d+\\.\\s*)?(${escapeRegExp(heading)}(?:[^\\n]*))$`,
      'm'
    );
    if (!pattern.test(normalized)) continue;
    normalized = normalized.replace(pattern, `## ${seq}. $1`);
    seq += 1;
  }
  return normalized;
}

const SECTION_SEGMENTS = [
  {
    label: '1-3',
    sectionDefs: SECTION_DEFINITIONS.slice(0, 3),
    stage: 'running_segment_1_3',
    progress: 45,
  },
  {
    label: '4-6',
    sectionDefs: SECTION_DEFINITIONS.slice(3, 6),
    stage: 'running_segment_4_6',
    progress: 62,
  },
  {
    label: '7-9',
    sectionDefs: SECTION_DEFINITIONS.slice(6, 9),
    stage: 'running_segment_7_9',
    progress: 78,
  },
];

function parseStructureAnchors(raw) {
  const fallbackOutline = REQUIRED_SECTION_HEADINGS.map((section) => ({
    section,
    intent: '',
    mustInclude: [],
  }));
  const fallback = { outline: fallbackOutline, glossary: [] };
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    const outline = Array.isArray(parsed?.outline)
      ? parsed.outline
          .map((item) => ({
            section: sanitizeText(item?.section, 80),
            intent: sanitizeText(item?.intent, 400),
            mustInclude: Array.isArray(item?.mustInclude)
              ? item.mustInclude
                  .map((i) => sanitizeText(i, 120))
                  .filter(Boolean)
                  .slice(0, 8)
              : [],
          }))
          .filter((item) => item.section)
      : [];
    const glossary = Array.isArray(parsed?.glossary)
      ? parsed.glossary
          .map((item) => ({
            term: sanitizeText(item?.term, 80),
            definition: sanitizeText(item?.definition, 240),
            aliases: Array.isArray(item?.aliases)
              ? item.aliases.map((i) => sanitizeText(i, 60)).filter(Boolean).slice(0, 6)
              : [],
          }))
          .filter((item) => item.term)
      : [];
    const normalizedOutline = REQUIRED_SECTION_HEADINGS.map((section) => {
      const matched = outline.find((item) => item.section === section);
      return matched || { section, intent: '', mustInclude: [] };
    });
    return { outline: normalizedOutline, glossary: glossary.slice(0, 16) };
  } catch {
    return fallback;
  }
}

function extractSegmentContent(raw, headings) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const ranges = headings
    .map((heading) => locateSectionByHeading(text, heading))
    .filter(Boolean);
  if (ranges.length === 0) return text;
  const picked = ranges
    .map((range) => text.slice(range.start, range.end).trim())
    .filter(Boolean);
  return picked.join('\n\n').trim();
}

function mergeSegmentDocument(baseDocument, segmentDocument, headings) {
  const base = String(baseDocument || '').trim();
  const seg = extractSegmentContent(segmentDocument, headings);
  if (!seg) return base;
  if (!base) return seg;
  return `${base}\n\n${seg}`.trim();
}

function isRetryableModelError(error) {
  const msg = error?.message || String(error) || '';
  return (
    msg.includes('超时') ||
    msg.includes('网络请求失败') ||
    msg.includes('大模型 API 错误 (500)') ||
    msg.includes('大模型 API 错误 (502)') ||
    msg.includes('大模型 API 错误 (503)') ||
    msg.includes('大模型 API 错误 (504)')
  );
}

function getStageTimeout(deadlineAt, stageMaxMs, stageLabel) {
  const remainingMs = Math.max(deadlineAt - Date.now(), 0);
  const usableBudget = remainingMs - SAFETY_MARGIN_MS;
  if (usableBudget < MIN_STAGE_TIMEOUT_MS) {
    const err = new Error(`剩余预算不足，无法继续${stageLabel}，请缩小需求范围后重试`);
    err.code = 'budget_exhausted';
    throw err;
  }
  return Math.min(stageMaxMs, usableBudget);
}

async function requestLLMWithBudgetAndFallback(messages, options, context = {}) {
  const {
    allowFallback = true,
    fallbackAttempts = 0,
    maxFallbackAttempts = MAX_FALLBACK_ATTEMPTS_PER_JOB,
    onFallbackUsed,
  } = context;
  const primaryModel = options.model;
  const fallbackModel = options.fallbackModel;
  const reqOpts = { ...options };
  delete reqOpts.fallbackModel;

  try {
    return await requestLLM(messages, reqOpts);
  } catch (err) {
    const canFallback =
      allowFallback &&
      fallbackModel &&
      fallbackModel !== primaryModel &&
      isRetryableModelError(err) &&
      fallbackAttempts < maxFallbackAttempts;
    if (!canFallback) {
      if (allowFallback && fallbackAttempts >= maxFallbackAttempts && isRetryableModelError(err)) {
        throw new Error(`模型重试次数已达上限（${maxFallbackAttempts}），请缩小需求范围后重试`);
      }
      throw err;
    }
    console.warn(`[llm] 主模型失败，自动切换到备用模型: ${primaryModel} -> ${fallbackModel}`);
    if (typeof onFallbackUsed === 'function') {
      onFallbackUsed(primaryModel, fallbackModel);
    }
    return requestLLM(messages, { ...reqOpts, model: fallbackModel });
  }
}

const generationJobs = new Map();
const generationQueue = [];
let processingGenerationQueue = false;
const reviseConsistencyJobs = new Map();
const reviseConsistencyQueue = [];
let processingReviseConsistencyQueue = false;

function cleanupGenerationJobs() {
  const now = Date.now();
  for (const [jobId, job] of generationJobs.entries()) {
    const finished = job.status === 'completed' || job.status === 'failed';
    if (finished && now - job.updatedAt > JOB_TTL_MS) {
      generationJobs.delete(jobId);
    }
  }

  if (generationJobs.size <= MAX_GENERATE_JOBS) return;
  const byUpdatedAt = [...generationJobs.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const overflow = generationJobs.size - MAX_GENERATE_JOBS;
  for (let i = 0; i < overflow; i += 1) {
    generationJobs.delete(byUpdatedAt[i][0]);
  }
}

function cleanupReviseConsistencyJobs() {
  const now = Date.now();
  for (const [jobId, job] of reviseConsistencyJobs.entries()) {
    const finished = job.status === 'completed' || job.status === 'failed';
    if (finished && now - job.updatedAt > REVISE_JOB_TTL_MS) {
      reviseConsistencyJobs.delete(jobId);
    }
  }

  if (reviseConsistencyJobs.size <= MAX_REVISE_JOBS) return;
  const byUpdatedAt = [...reviseConsistencyJobs.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const overflow = reviseConsistencyJobs.size - MAX_REVISE_JOBS;
  for (let i = 0; i < overflow; i += 1) {
    reviseConsistencyJobs.delete(byUpdatedAt[i][0]);
  }
}

function updateGenerationJob(jobId, patch) {
  const current = generationJobs.get(jobId);
  if (!current) return null;
  const now = Date.now();
  const deadlineAt = patch.deadlineAt || current.deadlineAt || 0;
  const createdAt = current.createdAt || now;
  const next = {
    ...current,
    ...patch,
    elapsedMs: Math.max(now - createdAt, 0),
    remainingMs: deadlineAt ? Math.max(deadlineAt - now, 0) : 0,
    updatedAt: now,
  };
  generationJobs.set(jobId, next);
  schedulePersistJobs();
  return next;
}

function updateReviseConsistencyJob(jobId, patch) {
  const current = reviseConsistencyJobs.get(jobId);
  if (!current) return null;
  const now = Date.now();
  const deadlineAt = patch.deadlineAt || current.deadlineAt || 0;
  const createdAt = current.createdAt || now;
  const next = {
    ...current,
    ...patch,
    elapsedMs: Math.max(now - createdAt, 0),
    remainingMs: deadlineAt ? Math.max(deadlineAt - now, 0) : 0,
    updatedAt: now,
  };
  reviseConsistencyJobs.set(jobId, next);
  schedulePersistJobs();
  return next;
}

function normalizeRunningLifecycle(patch = {}, current = {}) {
  if (patch.lifecycle) return patch.lifecycle;
  const stage = patch.stage || current.stage || '';
  if (typeof stage === 'string' && stage.startsWith('running_')) {
    return stage;
  }
  return current.lifecycle;
}

async function runStageWithRetries(runOnce, maxAttempts, onAttempt, onError) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (typeof onAttempt === 'function') onAttempt(attempt);
      return await runOnce(attempt);
    } catch (err) {
      lastError = err;
      if (typeof onError === 'function') onError(err, attempt);
    }
  }
  if (lastError) {
    lastError.code = lastError.code || 'stage_retry_exhausted';
    throw lastError;
  }
  const err = new Error('阶段执行失败');
  err.code = 'stage_retry_exhausted';
  throw err;
}

async function generateDocumentFlow(job, onProgress = () => {}) {
  const { payload, deadlineAt, forcedStage } = job;
  const { userRequirement, answers, scenario } = payload;
  const skipReasoning = process.env.FAST_GENERATE === '1' || process.env.FAST_GENERATE === 'true';
  const fallbackState = { attempts: Number(job.fallbackAttempts) || 0 };
  const generateMaxTokens = Math.min(
    Math.max(Number(process.env.GENERATE_MAX_TOKENS) || 4096, 2048),
    12288
  );

  let doc = typeof job.latestDocumentSnapshot === 'string' ? job.latestDocumentSnapshot : '';
  let sectionMap = doc.trim() ? parseMarkdownToSectionMap(doc) : createEmptySectionMap();
  const syncDocFromMap = () => {
    doc = renderSectionMapMarkdown(sectionMap);
    return doc;
  };
  let reasoning = typeof job.reasoning === 'string' ? job.reasoning : '';
  let anchors = {
    outline: REQUIRED_SECTION_HEADINGS.map((section) => ({ section, intent: '', mustInclude: [] })),
    glossary: [],
  };

  if (!reasoning && answers.length > 0 && !skipReasoning) {
    onProgress(20, '正在推理需求边界', {
      stage: 'running_draft',
      stageProgress: 20,
      overallProgress: 20,
    });
    try {
      reasoning = await requestLLM(
        [
          { role: 'system', content: REASON_SYSTEM },
          { role: 'user', content: buildReasonUser(userRequirement, answers, scenario) },
        ],
        {
          model: MODEL_R1,
          timeout_ms: getStageTimeout(deadlineAt, REASON_MAX_MS, '推理阶段'),
        }
      );
      onProgress(25, '推理完成', { stage: 'running_draft', reasoning });
    } catch (reasonError) {
      console.warn('[generate] 推理阶段失败，自动降级为无推理直出:', reasonError?.message || reasonError);
      reasoning = '';
    }
  }

  const completeForced = forcedStage === 'complete';
  const consistencyForced = forcedStage === 'consistency';
  const shouldRunSegmentedDraft = forcedStage === 'draft' || (!forcedStage && !doc) || (!doc && (completeForced || consistencyForced));
  if (shouldRunSegmentedDraft) {
    onProgress(28, '正在锁定结构锚点与术语表', {
      stage: 'running_draft',
      stageProgress: 22,
      overallProgress: 28,
    });
    try {
      const anchorRaw = await requestLLMWithBudgetAndFallback(
        [
          { role: 'system', content: STRUCTURE_ANCHOR_SYSTEM },
          { role: 'user', content: buildStructureAnchorUser(userRequirement, reasoning, answers, scenario) },
        ],
        {
          model: MODEL_V3,
          fallbackModel: MODEL_V3_FALLBACK || MODEL_R1,
          stream: false,
          max_tokens: 2200,
          timeout_ms: getStageTimeout(deadlineAt, Math.min(DRAFT_MAX_MS, 60000), '结构锚点阶段'),
        },
        {
          allowFallback: true,
          fallbackAttempts: fallbackState.attempts,
          maxFallbackAttempts: MAX_FALLBACK_ATTEMPTS_PER_JOB,
          onFallbackUsed: () => {
            fallbackState.attempts += 1;
          },
        }
      );
      anchors = parseStructureAnchors(anchorRaw);
    } catch (anchorError) {
      onProgress(30, `结构锚点降级：${anchorError?.message || anchorError}`, {
        stage: 'running_draft',
        lastError: anchorError?.message || String(anchorError),
      });
    }

    sectionMap = createEmptySectionMap();
    doc = '';
    for (const segment of SECTION_SEGMENTS) {
      const segmentDoc = await runStageWithRetries(
        async () => {
          const segmentRaw = await requestLLMWithBudgetAndFallback(
            [
              { role: 'system', content: SEGMENT_GENERATE_SYSTEM },
              {
                role: 'user',
                content: buildSegmentGenerateUser({
                  requirement: userRequirement,
                  scenario,
                  reasoning,
                  clarificationAnswers: answers,
                  existingDocument: doc,
                  segmentLabel: segment.label,
                  allowedSections: segment.sectionDefs,
                  outline: anchors.outline,
                  glossary: anchors.glossary,
                }),
              },
            ],
            {
              model: MODEL_V3,
              fallbackModel: MODEL_V3_FALLBACK || MODEL_R1,
              stream: false,
              max_tokens: Math.max(1800, Math.floor(generateMaxTokens * 0.55)),
              timeout_ms: getStageTimeout(deadlineAt, DRAFT_MAX_MS, `${segment.label} 分段生成`),
            },
            {
              allowFallback: true,
              fallbackAttempts: fallbackState.attempts,
              maxFallbackAttempts: MAX_FALLBACK_ATTEMPTS_PER_JOB,
              onFallbackUsed: () => {
                fallbackState.attempts += 1;
              },
            }
          );
          const parsed = parseSectionsJson(segmentRaw, {
            allowedIds: new Set(segment.sectionDefs.map((item) => item.id)),
            minChars: MIN_SECTION_CONTENT_CHARS_SEGMENT,
          });
          if (!parsed.ok) {
            const details = [
              parsed.error || '协议校验失败',
              parsed.missingSectionIds.length ? `缺失章节ID: ${parsed.missingSectionIds.join(',')}` : '',
              parsed.invalidSectionIds.length ? `非法章节ID: ${parsed.invalidSectionIds.join(',')}` : '',
            ]
              .filter(Boolean)
              .join('；');
            throw new Error(`分段 ${segment.label} 输出不合法：${details}`);
          }
          applySectionsToMap(sectionMap, parsed.sectionsById);
          return syncDocFromMap();
        },
        GENERATE_STAGE_MAX_ATTEMPTS,
        (attempt) => onProgress(segment.progress, `正在生成章节 ${segment.label}（${attempt}/${GENERATE_STAGE_MAX_ATTEMPTS}）`, {
          stage: segment.stage,
          outputLevel: 'draft',
          document: doc,
          latestDocumentSnapshot: doc,
          stageProgress: Math.min(25 + attempt * 25, 95),
          overallProgress: segment.progress,
          attempt,
          maxAttempts: GENERATE_STAGE_MAX_ATTEMPTS,
        }),
        (err) => onProgress(segment.progress, `章节 ${segment.label} 重试中：${err?.message || err}`, {
          stage: segment.stage,
          outputLevel: 'draft',
          document: doc,
          latestDocumentSnapshot: doc,
          lastError: err?.message || String(err),
        })
      ).catch((error) => {
        if (doc.trim()) {
          onProgress(segment.progress, `章节 ${segment.label} 生成未完成，已保留当前可用稿`, {
            stage: 'completed_partial',
            outputLevel: 'partial',
            document: doc,
            latestDocumentSnapshot: doc,
            lastError: error?.message || String(error),
          });
          return doc;
        }
        throw error;
      });
      doc = syncDocFromMap();
      onProgress(Math.min(segment.progress + 8, 86), `章节 ${segment.label} 已完成`, {
        stage: segment.stage,
        outputLevel: 'draft',
        document: doc,
        latestDocumentSnapshot: doc,
        overallProgress: Math.min(segment.progress + 8, 86),
        fallbackAttempts: fallbackState.attempts,
        reasoning,
      });
    }
  } else {
    onProgress(55, '已从快照恢复可用稿', {
      stage: 'running_complete',
      outputLevel: 'draft',
      document: doc,
      latestDocumentSnapshot: doc,
      stageProgress: 0,
      overallProgress: 55,
      reasoning,
      fallbackAttempts: fallbackState.attempts,
    });
  }

  const runTargetedCompletion = async (reasonLabel) => {
    const completedDoc = await runStageWithRetries(
      async () => {
        const current = evaluateSectionMapQuality(sectionMap, anchors.glossary);
        const targetIds = [...new Set([...current.missingSectionIds, ...current.invalidSectionIds])];
        if (targetIds.length === 0) return syncDocFromMap();
        const missingDefs = SECTION_DEFINITIONS.filter((item) => targetIds.includes(item.id));
        const completionRaw = await requestLLMWithBudgetAndFallback(
          [
            { role: 'system', content: SEGMENT_GENERATE_SYSTEM },
            {
              role: 'user',
              content: buildSegmentGenerateUser({
                requirement: userRequirement,
                scenario,
                reasoning,
                clarificationAnswers: answers,
                existingDocument: doc,
                segmentLabel: `${reasonLabel}-缺章与弱章补强`,
                allowedSections: missingDefs,
                outline: anchors.outline,
                glossary: anchors.glossary,
              }),
            },
          ],
          {
            model: MODEL_V3,
            fallbackModel: MODEL_V3_FALLBACK || MODEL_R1,
            stream: false,
            max_tokens: Math.max(1600, Math.floor(generateMaxTokens * 0.45)),
            timeout_ms: getStageTimeout(deadlineAt, CONTINUE_MAX_MS, `${reasonLabel}补齐阶段`),
          },
          {
            allowFallback: true,
            fallbackAttempts: fallbackState.attempts,
            maxFallbackAttempts: MAX_FALLBACK_ATTEMPTS_PER_JOB,
            onFallbackUsed: () => {
              fallbackState.attempts += 1;
            },
          }
        );
        const parsed = parseSectionsJson(completionRaw, {
          allowedIds: new Set(targetIds),
          minChars: MIN_SECTION_CONTENT_CHARS_SEGMENT,
        });
        if (!parsed.ok) {
          const details = [
            parsed.error || '协议校验失败',
            parsed.missingSectionIds.length ? `缺失章节ID: ${parsed.missingSectionIds.join(',')}` : '',
            parsed.invalidSectionIds.length ? `非法章节ID: ${parsed.invalidSectionIds.join(',')}` : '',
          ]
            .filter(Boolean)
            .join('；');
          throw new Error(`补强输出不合法：${details}`);
        }
        applySectionsToMap(sectionMap, parsed.sectionsById);
        return syncDocFromMap();
      },
      GENERATE_STAGE_MAX_ATTEMPTS,
      (attempt) => onProgress(84, `正在定向补齐与补强章节（${attempt}/${GENERATE_STAGE_MAX_ATTEMPTS}）`, {
        stage: 'running_complete',
        outputLevel: 'draft',
        document: doc,
        latestDocumentSnapshot: doc,
        stageProgress: Math.min(35 + attempt * 20, 95),
        overallProgress: 84,
        attempt,
        maxAttempts: GENERATE_STAGE_MAX_ATTEMPTS,
      }),
      (err) => onProgress(84, `定向补齐/补强重试中：${err?.message || err}`, {
        stage: 'running_complete',
        outputLevel: 'draft',
        document: doc,
        latestDocumentSnapshot: doc,
        lastError: err?.message || String(err),
      })
    ).catch((error) => {
      onProgress(90, `定向补齐未完成：${error?.message || error}`, {
        stage: 'completed_partial',
        outputLevel: 'partial',
        document: doc,
        latestDocumentSnapshot: doc,
        missingSections: evaluateSectionMapQuality(sectionMap, anchors.glossary).missingSections,
        lastError: error?.message || String(error),
      });
      return doc;
    });
    doc = completedDoc;
  };

  const initialCheck = evaluateSectionMapQuality(sectionMap, anchors.glossary);
  if (completeForced || initialCheck.incomplete) {
    await runTargetedCompletion('缺失章节');
  }

  if (doc.trim() && (!completeForced || consistencyForced || evaluateSectionMapQuality(sectionMap, anchors.glossary).incomplete)) {
    doc = await runStageWithRetries(
      async () => {
        const currentState = sectionMapToJson(sectionMap);
        const repaired = await requestLLMWithBudgetAndFallback(
          [
            { role: 'system', content: CONSISTENCY_REPAIR_SYSTEM },
            { role: 'user', content: buildConsistencyRepairUser(currentState, anchors.outline, anchors.glossary) },
          ],
          {
            model: MODEL_V3,
            fallbackModel: MODEL_V3_FALLBACK || MODEL_R1,
            stream: false,
            max_tokens: Math.max(1200, Math.floor(generateMaxTokens * 0.35)),
            timeout_ms: getStageTimeout(deadlineAt, Math.floor(CONTINUE_MAX_MS * 0.7), '统一性修复阶段'),
          },
          {
            allowFallback: false,
            fallbackAttempts: fallbackState.attempts,
            maxFallbackAttempts: MAX_FALLBACK_ATTEMPTS_PER_JOB,
          }
        );
        const parsed = parseSectionsJson(repaired, {
          allowedIds: new Set(SECTION_DEFINITIONS.map((item) => item.id)),
          minChars: MIN_SECTION_CONTENT_CHARS_SEGMENT,
        });
        if (!parsed.ok) {
          throw new Error('统一性修复结果违反结构约束（仅允许改写 content）');
        }
        applySectionsToMap(sectionMap, parsed.sectionsById);
        return syncDocFromMap();
      },
      1,
      () => onProgress(90, '正在做统一性修复', {
        stage: 'running_consistency_json',
        outputLevel: 'draft',
        document: doc,
        latestDocumentSnapshot: doc,
        stageProgress: 75,
        overallProgress: 90,
      })
    ).catch((error) => {
      onProgress(92, `统一性修复跳过：${error?.message || error}`, {
        stage: 'running_consistency_json',
        outputLevel: 'partial',
        document: doc,
        latestDocumentSnapshot: doc,
        lastError: error?.message || String(error),
      });
      return doc;
    });
  }

  const repairCheck = evaluateSectionMapQuality(sectionMap, anchors.glossary);
  if (repairCheck.incomplete && doc.trim()) {
    await runTargetedCompletion('统一性修复后');
  }

  doc = syncDocFromMap();
  const finalCheck = evaluateSectionMapQuality(sectionMap, anchors.glossary);
  const isFinal = !finalCheck.incomplete;
  onProgress(98, isFinal ? '最终稿已完成' : '生成了可用稿，部分章节待补齐', {
    stage: isFinal ? 'completed_final' : 'completed_partial',
    outputLevel: isFinal ? 'final' : 'partial',
    stageProgress: 100,
    overallProgress: 100,
    document: doc,
    latestDocumentSnapshot: doc,
    missingSections: finalCheck.missingSections,
    missingSectionIds: finalCheck.missingSectionIds,
    invalidSectionIds: finalCheck.invalidSectionIds,
    completionScore: finalCheck.completionScore,
    qualityWarnings: finalCheck.qualityWarnings,
    fallbackAttempts: fallbackState.attempts,
    attempt: job.attempt || 0,
    maxAttempts: job.maxAttempts || GENERATE_STAGE_MAX_ATTEMPTS,
  });
  return {
    document: doc,
    fallbackAttempts: fallbackState.attempts,
    missingSections: finalCheck.missingSections,
    missingSectionIds: finalCheck.missingSectionIds,
    invalidSectionIds: finalCheck.invalidSectionIds,
    completionScore: finalCheck.completionScore,
    qualityWarnings: finalCheck.qualityWarnings,
    outputLevel: isFinal ? 'final' : 'partial',
    lifecycle: isFinal ? 'completed_final' : 'completed_partial',
    lastError: finalCheck.incomplete ? '仍有缺失章节，已返回可用稿' : '',
    reasoning,
  };
}

function enqueueGenerationJob(payload) {
  cleanupGenerationJobs();
  const jobId = randomUUID();
  const now = Date.now();
  const deadlineAt = now + GEN_TOTAL_BUDGET_MS;
  const job = {
    id: jobId,
    status: 'queued',
    stage: 'running_draft',
    lifecycle: 'queued',
    outputLevel: 'draft',
    progress: 6,
    step: '已进入队列',
    stageProgress: 0,
    overallProgress: 6,
    payload,
    document: '',
    latestDocumentSnapshot: '',
    message: '',
    lastError: '',
    deadlineAt,
    elapsedMs: 0,
    remainingMs: GEN_TOTAL_BUDGET_MS,
    fallbackAttempts: 0,
    missingSections: [],
    missingSectionIds: SECTION_DEFINITIONS.map((item) => item.id),
    invalidSectionIds: [],
    completionScore: 0,
    qualityWarnings: [],
    attempt: 0,
    maxAttempts: GENERATE_STAGE_MAX_ATTEMPTS,
    forcedStage: '',
    reasoning: '',
    createdAt: now,
    updatedAt: now,
  };
  generationJobs.set(jobId, job);
  generationQueue.push(jobId);
  schedulePersistJobs();
  processGenerationQueue();
  return job;
}

async function processGenerationQueue() {
  if (processingGenerationQueue) return;
  processingGenerationQueue = true;
  try {
    while (generationQueue.length > 0) {
      const jobId = generationQueue.shift();
      const job = generationJobs.get(jobId);
      if (!job || job.status !== 'queued') continue;

      updateGenerationJob(jobId, {
        status: 'running',
        lifecycle: 'running_draft',
        stage: 'running_draft',
        progress: 12,
        stageProgress: 0,
        overallProgress: 12,
        step: '任务开始执行',
      });

      try {
        const result = await generateDocumentFlow(job, (progress, step, patch = {}) => {
          const current = generationJobs.get(jobId) || {};
          updateGenerationJob(jobId, {
            progress,
            overallProgress: patch.overallProgress ?? progress,
            stageProgress: patch.stageProgress ?? 0,
            step,
            lifecycle: normalizeRunningLifecycle(patch, current),
            ...patch,
          });
        });
        const isFinal = result.outputLevel === 'final';
        updateGenerationJob(jobId, {
          status: 'completed',
          lifecycle: isFinal ? 'completed_final' : 'completed_partial',
          stage: isFinal ? 'completed_final' : 'completed_partial',
          outputLevel: result.outputLevel,
          progress: 100,
          stageProgress: 100,
          overallProgress: 100,
          step: '生成完成',
          document: result.document,
          latestDocumentSnapshot: result.document,
          fallbackAttempts: result.fallbackAttempts,
          missingSections: result.missingSections,
          missingSectionIds: result.missingSectionIds || [],
          invalidSectionIds: result.invalidSectionIds || [],
          completionScore: Number.isFinite(result.completionScore) ? result.completionScore : 0,
          qualityWarnings: Array.isArray(result.qualityWarnings) ? result.qualityWarnings : [],
          lastError: result.lastError || '',
          reasoning: result.reasoning || '',
          forcedStage: '',
        });
      } catch (error) {
        const message = error?.message || String(error) || '生成失败';
        const current = generationJobs.get(jobId);
        const snapshot = current?.latestDocumentSnapshot || '';
        const hasSnapshot = typeof snapshot === 'string' && snapshot.trim().length > 0;
        updateGenerationJob(jobId, {
          status: hasSnapshot ? 'completed' : 'failed',
          progress: hasSnapshot ? Math.max(current?.overallProgress || 90, 90) : 100,
          overallProgress: current?.overallProgress ?? 100,
          step: hasSnapshot ? '阶段失败，已返回可用稿' : '生成失败',
          message,
          stage: hasSnapshot ? 'completed_partial' : (current?.stage || 'running_draft'),
          lifecycle: hasSnapshot ? 'completed_partial' : 'failed_fatal',
          outputLevel: hasSnapshot ? 'partial' : 'draft',
          document: snapshot || '',
          latestDocumentSnapshot: snapshot || '',
          fallbackAttempts: current?.fallbackAttempts || 0,
          missingSections: current?.missingSections || [],
          missingSectionIds: current?.missingSectionIds || [],
          invalidSectionIds: current?.invalidSectionIds || [],
          completionScore: Number.isFinite(current?.completionScore) ? current.completionScore : 0,
          qualityWarnings: Array.isArray(current?.qualityWarnings) ? current.qualityWarnings : [],
          lastError: message,
          forcedStage: '',
        });
      }
    }
  } finally {
    processingGenerationQueue = false;
    cleanupGenerationJobs();
  }
}

function enqueueReviseConsistencyJob(payload) {
  cleanupReviseConsistencyJobs();
  const id = randomUUID();
  const now = Date.now();
  const deadlineAt = now + REVISE_TOTAL_BUDGET_MS;
  const job = {
    id,
    status: 'queued',
    stage: 'consistency',
    step: '等待执行一致性联动',
    payload,
    attempt: 0,
    maxAttempts: REVISE_CONSISTENCY_MAX_ATTEMPTS,
    linkedUpdates: [],
    candidateDocument: '',
    applied: false,
    message: '',
    deadlineAt,
    elapsedMs: 0,
    remainingMs: REVISE_TOTAL_BUDGET_MS,
    createdAt: now,
    updatedAt: now,
  };
  reviseConsistencyJobs.set(id, job);
  reviseConsistencyQueue.push(id);
  schedulePersistJobs();
  processReviseConsistencyQueue();
  return job;
}

async function processReviseConsistencyQueue() {
  if (processingReviseConsistencyQueue) return;
  processingReviseConsistencyQueue = true;
  try {
    while (reviseConsistencyQueue.length > 0) {
      const jobId = reviseConsistencyQueue.shift();
      const job = reviseConsistencyJobs.get(jobId);
      if (!job || job.status !== 'queued') continue;

      const nextAttempt = job.attempt + 1;
      updateReviseConsistencyJob(jobId, {
        status: 'running',
        stage: 'consistency',
        step: `一致性联动执行中（第 ${nextAttempt}/${job.maxAttempts} 次）`,
        attempt: nextAttempt,
        message: '',
      });

      try {
        const parsed = await executeReviseConsistencyOnce(
          job.payload.appliedDocument,
          job.payload.annotations,
          job.payload.affectedSections,
          job.deadlineAt
        );
        updateReviseConsistencyJob(jobId, {
          status: 'completed',
          step: '一致性联动完成',
          candidateDocument: parsed.finalDocument,
          linkedUpdates: parsed.linkedUpdates,
          message: '',
        });
      } catch (error) {
        const current = reviseConsistencyJobs.get(jobId);
        const msg = error?.message || String(error) || '一致性联动失败';
        const canRetry = current && current.attempt < current.maxAttempts;
        if (canRetry) {
          updateReviseConsistencyJob(jobId, {
            status: 'queued',
            step: `一致性联动失败，准备重试（${current.attempt}/${current.maxAttempts}）`,
            message: msg,
          });
          reviseConsistencyQueue.push(jobId);
        } else {
          const fallbackDoc = current?.payload?.appliedDocument || '';
          updateReviseConsistencyJob(jobId, {
            status: 'completed_degraded',
            step: '一致性联动降级完成（已保留基础修订结果）',
            candidateDocument: fallbackDoc,
            linkedUpdates: [],
            message: msg,
          });
        }
      }
    }
  } finally {
    processingReviseConsistencyQueue = false;
    cleanupReviseConsistencyJobs();
  }
}

app.use('/api', requireRateLimit);

app.post('/api/trial/claim', asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  const fingerprint = sanitizeText(req.body?.fingerprint, 200);
  const ip = sanitizeText(req.ip || req.headers['x-forwarded-for'] || '', 200) || 'unknown';
  if (!fingerprint) {
    return res.status(400).json({ success: false, code: 'invalid_params', message: '缺少设备指纹' });
  }
  try {
    const anonTrialToken = claimAnonTrial({ fingerprint, ip });
    return res.json({
      success: true,
      anonTrialToken,
      expiresInMs: ANON_TRIAL_TOKEN_TTL_MS,
      message: '已领取匿名试用资格，可生成 1 次预览',
    });
  } catch (error) {
    const code = error?.code || 'trial_exhausted';
    return res.status(409).json({
      success: false,
      code,
      message: error?.message || '匿名试用机会已用完，请注册登录继续',
    });
  }
}));

app.post('/api/trial/generate', asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  const anonTrialToken = sanitizeText(req.body?.anonTrialToken, 1500);
  const fingerprint = sanitizeText(req.body?.fingerprint, 200);
  const userRequirement = sanitizeText(req.body?.userRequirement, MAX_REQUIREMENT_LENGTH);
  const scenario = sanitizeText(req.body?.scenario, MAX_SCENARIO_LENGTH);
  const ip = sanitizeText(req.ip || req.headers['x-forwarded-for'] || '', 200) || 'unknown';

  if (!anonTrialToken || !fingerprint || !userRequirement) {
    return res.status(400).json({ success: false, code: 'invalid_params', message: '缺少试用令牌、设备指纹或需求描述' });
  }

  const ticket = verifyAnonTrialToken(anonTrialToken, fingerprint, ip);
  if (!ticket) {
    return res.status(409).json({
      success: false,
      code: 'trial_exhausted',
      message: '匿名试用无效或已使用，请注册登录继续',
    });
  }

  try {
    const generated = await requestLLMWithBudgetAndFallback(
      [
        { role: 'system', content: GENERATE_SYSTEM },
        { role: 'user', content: buildGenerateUser(userRequirement, '', [], scenario) },
      ],
      {
        model: MODEL_V3,
        fallbackModel: MODEL_V3_FALLBACK || MODEL_R1,
        stream: false,
        max_tokens: 2800,
        timeout_ms: Math.min(DRAFT_MAX_MS, 90000),
      },
      { allowFallback: true, fallbackAttempts: 0, maxFallbackAttempts: 1 }
    );
    const document = sanitizeText(typeof generated === 'string' ? generated.trim() : '', ANON_TRIAL_MAX_PREVIEW_CHARS);
    ticket.usedAt = nowIso();
    anonTrialTickets.set(anonTrialToken, ticket);
    schedulePersistUsers();
    return res.json({
      success: true,
      document,
      outputLevel: 'preview',
      plan: 'free',
      quotaRemaining: { period: monthKey(), generateRemaining: 0, reviseRemaining: 0, tokenRemaining: 0 },
      entitlements: { canDownload: false, canGenerate: false, canRevise: false },
      message: '匿名试用已完成：可预览，不可下载。登录后可继续。',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      code: 'trial_generate_failed',
      message: error?.message || '匿名试用生成失败，请稍后重试',
    });
  }
}));

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  const email = sanitizeEmail(req.body?.email);
  const password = sanitizePassword(req.body?.password);
  const name = sanitizeName(req.body?.name);
  if (!email || !password) {
    return res.status(400).json({ success: false, message: '缺少邮箱或密码' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, message: '邮箱格式不正确' });
  }
  if (password.length < 8) {
    return res.status(400).json({ success: false, message: '密码至少 8 位' });
  }
  if (usersByEmail.has(email)) {
    return res.status(409).json({ success: false, message: '邮箱已注册' });
  }
  const user = {
    id: randomUUID(),
    email,
    name: name || email.split('@')[0],
    passwordHash: hashPassword(password),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  usersById.set(user.id, user);
  usersByEmail.set(user.email, user.id);
  createDefaultSubscription(user.id);
  claimAnonUsageToUser(req, user.id);
  schedulePersistUsers();
  const token = buildAuthResponse(user);
  return res.json({
    success: true,
    user: sanitizeUser(user),
    ...token,
    ...buildPlanResponse(user.id),
  });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  const email = sanitizeEmail(req.body?.email);
  const password = sanitizePassword(req.body?.password);
  const userId = usersByEmail.get(email);
  const user = userId ? usersById.get(userId) : null;
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ success: false, message: '邮箱或密码错误' });
  }
  user.updatedAt = nowIso();
  usersById.set(user.id, user);
  claimAnonUsageToUser(req, user.id);
  schedulePersistUsers();
  const token = buildAuthResponse(user);
  return res.json({
    success: true,
    user: sanitizeUser(user),
    ...token,
    ...buildPlanResponse(user.id),
  });
}));

app.post('/api/auth/refresh', asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  cleanupRefreshTokens();
  const refreshToken = sanitizeText(req.body?.refreshToken, 200);
  const item = refreshTokens.get(refreshToken);
  if (!item || item.expiresAt <= Date.now()) {
    return res.status(401).json({ success: false, message: 'refresh token 已失效' });
  }
  const user = usersById.get(item.userId);
  if (!user) {
    refreshTokens.delete(refreshToken);
    schedulePersistUsers();
    return res.status(401).json({ success: false, message: '用户不存在' });
  }
  refreshTokens.delete(refreshToken);
  const token = buildAuthResponse(user);
  return res.json({
    success: true,
    user: sanitizeUser(user),
    ...token,
    ...buildPlanResponse(user.id),
  });
}));

app.post('/api/auth/logout', requireAuth, asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  const refreshToken = sanitizeText(req.body?.refreshToken, 200);
  if (refreshToken) {
    refreshTokens.delete(refreshToken);
    schedulePersistUsers();
  }
  return res.json({ success: true });
}));

app.get('/api/auth/me', requireAuth, asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  const user = usersById.get(req.authUser.id);
  return res.json({
    success: true,
    user: sanitizeUser(user),
    ...buildPlanResponse(req.authUser.id),
  });
}));

app.get('/api/usage', requireAuth, asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  const key = monthKey();
  const usage = getUsageRecord(req.authUser.id, key);
  const planInfo = buildPlanResponse(req.authUser.id);
  return res.json({
    success: true,
    period: key,
    usage,
    quotaRemaining: planInfo.quotaRemaining,
    plan: planInfo.plan,
    limits: planInfo.limits,
    entitlements: planInfo.entitlements,
  });
}));

app.get('/api/billing/plans', requireAuth, asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  const plans = Object.values(PLANS).map((item) => ({
    id: item.id,
    name: item.name,
    cycle: item.cycle,
    priceCny: item.priceCny,
    priceUsd: item.priceUsd,
    limits: item.limits,
  }));
  return res.json({ success: true, plans });
}));

app.get('/api/billing/subscription', requireAuth, asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  return res.json({ success: true, ...buildPlanResponse(req.authUser.id) });
}));

app.post('/api/billing/subscription', requireAuth, asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  const planId = sanitizeText(req.body?.planId, 30).toLowerCase();
  const cycle = 'monthly';
  if (!PLANS[planId]) {
    return res.status(400).json({ success: false, message: '不支持的套餐' });
  }
  if (cycle !== 'monthly' || !PLANS[planId].cycle.includes(cycle)) {
    return res.status(400).json({ success: false, message: '不支持的计费周期' });
  }
  const sub = {
    userId: req.authUser.id,
    planId,
    cycle,
    status: planId === 'free' ? 'none' : 'active',
    renewAt: nowIso(),
    startedAt: subscriptionsByUser.get(req.authUser.id)?.startedAt || nowIso(),
    updatedAt: nowIso(),
  };
  subscriptionsByUser.set(req.authUser.id, sub);
  appendPaymentEvent(req.authUser.id, {
    provider: 'manual',
    type: 'subscription_changed',
    planId,
    cycle,
    status: 'succeeded',
    amountCny: PLANS[planId].priceCny[cycle] || 0,
    amountUsd: PLANS[planId].priceUsd[cycle] || 0,
  });
  return res.json({ success: true, ...buildPlanResponse(req.authUser.id) });
}));

app.post('/api/billing/checkout-session', requireAuth, asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  const provider = sanitizeText(req.body?.provider, 30).toLowerCase();
  const planId = sanitizeText(req.body?.planId, 30).toLowerCase();
  const cycle = sanitizeText(req.body?.cycle, 30).toLowerCase() || 'monthly';
  if (!SUPPORTED_PAYMENT_PROVIDERS.has(provider)) {
    return res.status(400).json({ success: false, message: '不支持的支付通道' });
  }
  if (!PLANS[planId] || !PLANS[planId].cycle.includes(cycle)) {
    return res.status(400).json({ success: false, message: '套餐或周期无效' });
  }
  if (!PAYMENT_CHECKOUT_BASE_URL) {
    return res.status(503).json({
      success: false,
      code: 'payment_not_configured',
      message: '支付未配置，当前环境不能创建收银台链接',
    });
  }
  const sessionId = randomUUID();
  appendPaymentEvent(req.authUser.id, {
    provider,
    type: 'checkout_session_created',
    planId,
    cycle,
    status: 'pending',
    sessionId,
    amountCny: PLANS[planId].priceCny[cycle] || 0,
    amountUsd: PLANS[planId].priceUsd[cycle] || 0,
  });
  return res.json({
    success: true,
    sessionId,
    provider,
    checkoutUrl: `${PAYMENT_CHECKOUT_BASE_URL}/${provider}/checkout/${sessionId}`,
    message: '已创建支付会话',
  });
}));

app.post('/api/subscription/checkout', requireAuth, asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  const provider = sanitizeText(req.body?.provider, 30).toLowerCase() || 'stripe';
  const planId = 'pro';
  const cycle = 'monthly';
  if (!SUPPORTED_PAYMENT_PROVIDERS.has(provider)) {
    return res.status(400).json({ success: false, code: 'invalid_provider', message: '不支持的支付通道' });
  }
  if (!PAYMENT_CHECKOUT_BASE_URL) {
    return res.status(503).json({
      success: false,
      code: 'payment_not_configured',
      message: '支付未配置，当前环境不能创建收银台链接',
    });
  }
  const sessionId = randomUUID();
  appendPaymentEvent(req.authUser.id, {
    provider,
    type: 'subscription_checkout_created',
    planId,
    cycle,
    status: 'pending',
    sessionId,
    amountCny: PLANS[planId].priceCny[cycle] || 0,
    amountUsd: PLANS[planId].priceUsd[cycle] || 0,
  });
  return res.json({
    success: true,
    sessionId,
    provider,
    planId,
    cycle,
    checkoutUrl: `${PAYMENT_CHECKOUT_BASE_URL}/${provider}/checkout/${sessionId}`,
    message: '月订阅结账会话已创建',
  });
}));

app.get('/api/billing/invoices', requireAuth, asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  const items = paymentEventsByUser.get(req.authUser.id) || [];
  return res.json({ success: true, invoices: items });
}));

function applyWebhookSubscriptionUpdate(userId, planId, cycle, provider, status) {
  if (!usersById.has(userId)) return;
  const normalizedStatus = status === 'failed' ? 'past_due' : (status === 'canceled' ? 'canceled' : 'active');
  const sub = {
    userId,
    planId: PLANS[planId] ? planId : 'free',
    cycle: cycle || 'monthly',
    status: normalizedStatus,
    renewAt: nowIso(),
    startedAt: subscriptionsByUser.get(userId)?.startedAt || nowIso(),
    updatedAt: nowIso(),
  };
  subscriptionsByUser.set(userId, sub);
  appendPaymentEvent(userId, {
    provider,
    type: 'webhook_subscription_update',
    planId: sub.planId,
    cycle: sub.cycle,
    status,
  });
}

app.post('/api/webhooks/stripe', asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  const userId = sanitizeText(req.body?.metadata?.userId || req.body?.userId, 80);
  const planId = sanitizeText(req.body?.metadata?.planId || req.body?.planId, 30).toLowerCase();
  const cycle = sanitizeText(req.body?.metadata?.cycle || req.body?.cycle, 30).toLowerCase();
  const status = sanitizeText(req.body?.status, 30).toLowerCase() || 'succeeded';
  if (userId) applyWebhookSubscriptionUpdate(userId, planId || 'free', cycle || 'monthly', 'stripe', status);
  return res.json({ success: true, received: true });
}));

app.post('/api/webhooks/wechatpay', asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  const userId = sanitizeText(req.body?.attach?.userId || req.body?.userId, 80);
  const planId = sanitizeText(req.body?.attach?.planId || req.body?.planId, 30).toLowerCase();
  const cycle = sanitizeText(req.body?.attach?.cycle || req.body?.cycle, 30).toLowerCase();
  const status = sanitizeText(req.body?.trade_state || req.body?.status, 30).toLowerCase() || 'succeeded';
  if (userId) applyWebhookSubscriptionUpdate(userId, planId || 'free', cycle || 'monthly', 'wechatpay', status);
  return res.json({ success: true, received: true });
}));

app.post('/api/webhooks/alipay', asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  const userId = sanitizeText(req.body?.passback_params?.userId || req.body?.userId, 80);
  const planId = sanitizeText(req.body?.passback_params?.planId || req.body?.planId, 30).toLowerCase();
  const cycle = sanitizeText(req.body?.passback_params?.cycle || req.body?.cycle, 30).toLowerCase();
  const status = sanitizeText(req.body?.trade_status || req.body?.status, 30).toLowerCase() || 'succeeded';
  if (userId) applyWebhookSubscriptionUpdate(userId, planId || 'free', cycle || 'monthly', 'alipay', status);
  return res.json({ success: true, received: true });
}));

app.get('/', (req, res) => {
  if (hasFrontendDist) {
    return res.sendFile(frontendIndexFile);
  }
  res.type('html').send(
    '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>需求梳理后端</title></head><body><h1>需求梳理 API</h1><p>请先构建并部署前端，或本地访问 <a href="http://localhost:5173">http://localhost:5173</a>。</p><p><a href="/api/health">/api/health</a></p></body></html>'
  );
});

app.get('/api/health', (req, res) => {
  res.set(jsonHeader);
  res.json({
    ok: true,
    envProfile: APP_ENV_PROFILE,
    authRequired: AUTH_REQUIRED,
    anonQuotaEnforced: ANON_QUOTA_ENFORCED,
    sentry: Boolean(SENTRY_DSN),
    frontendDist: hasFrontendDist,
    modelV3: MODEL_V3,
    modelR1: MODEL_R1,
    queueLength: generationQueue.length,
    reviseConsistencyQueueLength: reviseConsistencyQueue.length,
    users: usersById.size,
  });
});

app.get('/api/ready', (req, res) => {
  res.set(jsonHeader);
  const key = (process.env.LLM_API_KEY || '').trim();
  const checks = {
    llmKeyLoaded: Boolean(key && key.startsWith('sk-')),
    userStoreWritable: true,
    jobStoreWritable: true,
  };
  try {
    ensureDirFor(USER_STORE_FILE);
    fs.accessSync(path.dirname(USER_STORE_FILE), fs.constants.W_OK);
  } catch {
    checks.userStoreWritable = false;
  }
  try {
    ensureDirFor(JOB_STORE_FILE);
    fs.accessSync(path.dirname(JOB_STORE_FILE), fs.constants.W_OK);
  } catch {
    checks.jobStoreWritable = false;
  }
  const ready = checks.llmKeyLoaded && checks.userStoreWritable && checks.jobStoreWritable;
  return res.status(ready ? 200 : 503).json({ success: ready, checks });
});

/** Phase1：生成澄清问题 */
app.post('/api/clarify', attachOptionalAuth, attachPlanInfo, asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  const userRequirement = sanitizeText(req.body?.userRequirement, MAX_REQUIREMENT_LENGTH);
  const scenario = sanitizeText(req.body?.scenario, MAX_SCENARIO_LENGTH);
  if (!userRequirement) {
    return res.status(400).json({ success: false, message: '缺少 userRequirement' });
  }
  try {
    const content = await requestLLMWithBudgetAndFallback(
      [
        { role: 'system', content: CLARIFY_SYSTEM },
        { role: 'user', content: buildClarifyUser(userRequirement, scenario) },
      ],
      { model: MODEL_V3, fallbackModel: MODEL_V3_FALLBACK || MODEL_R1, timeout_ms: 45000 },
      { allowFallback: true, fallbackAttempts: 0, maxFallbackAttempts: 1 }
    );
    const parsed = parseClarifyResponse(content);
    const questions = ensureClarifyQuestions(parsed);
    const planInfo = resolveRequestPlanInfo(req);
    return res.json({
      success: true,
      questions,
      plan: planInfo.plan,
      quotaRemaining: planInfo.quotaRemaining,
      entitlements: planInfo.entitlements,
    });
  } catch (e) {
    console.error('[clarify]', e);
    const questions = ensureClarifyQuestions([]);
    const planInfo = resolveRequestPlanInfo(req);
    return res.json({
      success: true,
      questions,
      plan: planInfo.plan,
      quotaRemaining: planInfo.quotaRemaining,
      entitlements: planInfo.entitlements,
    });
  }
}));

/** Phase2 推理 + Phase3 生成 PRD */
app.post('/api/document/generate', attachOptionalAuth, attachPlanInfo, asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  const userRequirement = sanitizeText(req.body?.userRequirement, MAX_REQUIREMENT_LENGTH);
  const answers = sanitizeClarificationAnswers(req.body?.clarificationAnswers);
  const scenario = sanitizeText(req.body?.scenario, MAX_SCENARIO_LENGTH);
  if (!userRequirement) {
    return res.status(400).json({ success: false, message: '缺少 userRequirement' });
  }
  const userId = req.authUser?.id;
  const estimatedTokens =
    estimateTokensFromText(userRequirement)
    + estimateTokensFromText(scenario)
    + estimateTokensFromText(JSON.stringify(answers || []));
  if (userId) {
    try {
      enforceQuota(userId, 'generate', estimatedTokens);
    } catch (error) {
      return res.status(402).json({
        success: false,
        code: error?.code || 'monthly_quota_exceeded',
        message: error?.message || '本月免费额度已用完，请开通月订阅',
        plan: req.planInfo?.plan,
        quotaRemaining: getQuotaRemaining(userId),
        entitlements: req.planInfo?.entitlements,
      });
    }
    consumeQuota(userId, 'generate', estimatedTokens);
  } else {
    try {
      enforceAnonQuota(req, 'generate', estimatedTokens);
      consumeAnonQuota(req, 'generate', estimatedTokens);
    } catch (error) {
      const planInfo = resolveRequestPlanInfo(req);
      return res.status(402).json({
        success: false,
        code: error?.code || 'trial_exhausted',
        message: error?.message || '匿名试用额度已用完，请登录继续',
        plan: planInfo.plan,
        quotaRemaining: planInfo.quotaRemaining,
        entitlements: planInfo.entitlements,
      });
    }
  }
  const job = enqueueGenerationJob({
    userId,
    userRequirement,
    answers,
    scenario,
  });
  const planInfo = resolveRequestPlanInfo(req);
  return res.status(202).json({
    success: true,
    jobId: job.id,
    status: job.status,
    lifecycle: job.lifecycle,
    stage: job.stage,
    outputLevel: job.outputLevel,
    progress: job.progress,
    stageProgress: job.stageProgress,
    overallProgress: job.overallProgress,
    step: job.step,
    elapsedMs: job.elapsedMs,
    remainingMs: job.remainingMs,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    lastError: job.lastError,
    document: job.latestDocumentSnapshot || '',
    fallbackAttempts: job.fallbackAttempts,
    missingSections: job.missingSections,
    missingSectionIds: job.missingSectionIds || [],
    invalidSectionIds: job.invalidSectionIds || [],
    completionScore: Number.isFinite(job.completionScore) ? job.completionScore : 0,
    qualityWarnings: Array.isArray(job.qualityWarnings) ? job.qualityWarnings : [],
    plan: planInfo.plan,
    quotaRemaining: userId ? getQuotaRemaining(userId) : planInfo.quotaRemaining,
    entitlements: planInfo.entitlements,
  });
}));

app.get('/api/document/generate/:jobId', attachOptionalAuth, attachPlanInfo, asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  cleanupGenerationJobs();
  const jobId = sanitizeText(req.params?.jobId, 80);
  const job = generationJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ success: false, message: '任务不存在或已过期' });
  }
  if (AUTH_REQUIRED && job?.payload?.userId && req.authUser?.id !== job.payload.userId) {
    return res.status(403).json({ success: false, message: '无权访问该任务' });
  }
  const now = Date.now();
  const elapsedMs = Math.max(now - job.createdAt, 0);
  const remainingMs = job.deadlineAt ? Math.max(job.deadlineAt - now, 0) : 0;

  const planInfo = resolveRequestPlanInfo(req);
  const base = {
    success: true,
    jobId: job.id,
    status: job.status,
    lifecycle: job.lifecycle,
    stage: job.stage,
    outputLevel: job.outputLevel,
    progress: job.progress,
    stageProgress: job.stageProgress ?? 0,
    overallProgress: job.overallProgress ?? job.progress,
    step: job.step,
    elapsedMs,
    remainingMs,
    attempt: job.attempt ?? 0,
    maxAttempts: job.maxAttempts ?? GENERATE_STAGE_MAX_ATTEMPTS,
    lastError: job.lastError || '',
    fallbackAttempts: job.fallbackAttempts,
    missingSections: job.missingSections,
    missingSectionIds: job.missingSectionIds || [],
    invalidSectionIds: job.invalidSectionIds || [],
    completionScore: Number.isFinite(job.completionScore) ? job.completionScore : 0,
    qualityWarnings: Array.isArray(job.qualityWarnings) ? job.qualityWarnings : [],
    document: job.latestDocumentSnapshot || job.document || '',
    plan: planInfo.plan,
    quotaRemaining: req.authUser?.id ? getQuotaRemaining(req.authUser.id) : planInfo.quotaRemaining,
    entitlements: planInfo.entitlements,
  };

  if (job.status === 'completed') {
    return res.json({ ...base, document: job.document });
  }
  if (job.status === 'failed') {
    return res.json({ ...base, message: job.message || '生成失败' });
  }

  let queuePosition = -1;
  if (job.status === 'queued') {
    queuePosition = generationQueue.indexOf(job.id) + 1;
  }
  return res.json({ ...base, ...(queuePosition > 0 ? { queuePosition } : {}) });
}));

app.post('/api/document/generate/:jobId/retry-stage', attachOptionalAuth, attachPlanInfo, asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  cleanupGenerationJobs();
  const jobId = sanitizeText(req.params?.jobId, 80);
  const requested = sanitizeText(req.body?.stage, 40);
  const allowed = new Set(['draft', 'complete', 'consistency']);
  const requestedStage = allowed.has(requested) ? requested : '';
  const job = generationJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ success: false, message: '任务不存在或已过期' });
  }
  if (AUTH_REQUIRED && job?.payload?.userId && req.authUser?.id !== job.payload.userId) {
    return res.status(403).json({ success: false, message: '无权重试该任务' });
  }
  if (job.status === 'running' || job.status === 'queued') {
    return res.json({ success: true, jobId: job.id, status: job.status, message: '任务执行中，无需重试' });
  }

  const nextStage =
    requestedStage ||
    (
      job.stage === 'running_complete' ||
      job.stage === 'running_segment_4_6' ||
      job.stage === 'running_segment_7_9' ||
      job.stage === 'running_consistency_json' ||
      job.stage === 'completed_partial'
        ? 'complete'
        : 'draft'
    );
  const now = Date.now();
  updateGenerationJob(jobId, {
    status: 'queued',
    lifecycle: `running_${nextStage}`,
    stage: `running_${nextStage}`,
    step: `准备重试阶段：${nextStage}`,
    forcedStage: nextStage,
    message: '',
    attempt: 0,
    lastError: '',
    deadlineAt: now + GEN_TOTAL_BUDGET_MS,
    createdAt: now,
  });
  generationQueue.push(jobId);
  schedulePersistJobs();
  processGenerationQueue();
  return res.json({ success: true, jobId: job.id, status: 'queued', stage: `running_${nextStage}`, forcedStage: nextStage });
}));

app.post('/api/document/generate/:jobId/continue', attachOptionalAuth, attachPlanInfo, asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  cleanupGenerationJobs();
  const jobId = sanitizeText(req.params?.jobId, 80);
  const job = generationJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ success: false, message: '任务不存在或已过期' });
  }
  if (AUTH_REQUIRED && job?.payload?.userId && req.authUser?.id !== job.payload.userId) {
    return res.status(403).json({ success: false, message: '无权继续该任务' });
  }
  if (job.status === 'running' || job.status === 'queued') {
    return res.json({ success: true, jobId: job.id, status: job.status, message: '任务执行中' });
  }
  const now = Date.now();
  updateGenerationJob(jobId, {
    status: 'queued',
    lifecycle: 'running_complete',
    stage: 'running_complete',
    step: '准备继续补齐',
    forcedStage: 'complete',
    message: '',
    attempt: 0,
    lastError: '',
    deadlineAt: now + GEN_TOTAL_BUDGET_MS,
    createdAt: now,
  });
  generationQueue.push(jobId);
  schedulePersistJobs();
  processGenerationQueue();
  return res.json({ success: true, jobId: job.id, status: 'queued', stage: 'running_complete', forcedStage: 'complete' });
}));

/** Phase4：按标注修订 */
app.post('/api/document/revise', attachOptionalAuth, attachPlanInfo, asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  const document = sanitizeText(req.body?.document, 120000);
  if (!document) {
    return res.status(400).json({ success: false, message: '缺少 document' });
  }
  const list = sanitizeAnnotations(req.body?.annotations);
  if (list.length === 0) {
    return res.json({ success: true, document });
  }
  try {
    validateRevisionAnnotations(list);
  } catch (err) {
    return res.status(400).json({ success: false, message: err?.message || '标注参数错误' });
  }
  const userId = req.authUser?.id;
  const estimatedTokens =
    estimateTokensFromText(document)
    + estimateTokensFromText(JSON.stringify(list || []));
  if (userId) {
    try {
      enforceQuota(userId, 'revise', estimatedTokens);
    } catch (error) {
      return res.status(402).json({
        success: false,
        code: error?.code || 'monthly_quota_exceeded',
        message: error?.message || '本月免费额度已用完，请开通月订阅',
        plan: req.planInfo?.plan,
        quotaRemaining: getQuotaRemaining(userId),
        entitlements: req.planInfo?.entitlements,
      });
    }
    consumeQuota(userId, 'revise', estimatedTokens);
  } else {
    try {
      enforceAnonQuota(req, 'revise', estimatedTokens);
      consumeAnonQuota(req, 'revise', estimatedTokens);
    } catch (error) {
      const planInfo = resolveRequestPlanInfo(req);
      return res.status(402).json({
        success: false,
        code: error?.code || 'trial_exhausted',
        message: error?.message || '匿名试用修订次数已用完，请登录继续',
        plan: planInfo.plan,
        quotaRemaining: planInfo.quotaRemaining,
        entitlements: planInfo.entitlements,
      });
    }
  }

  try {
    const applied = await requestLLMWithBudgetAndFallback(
      [
        { role: 'system', content: REVISE_APPLY_SYSTEM },
        { role: 'user', content: buildReviseApplyUser(document, list) },
      ],
      {
        model: REVISE_APPLY_MODEL,
        fallbackModel: REVISE_APPLY_FALLBACK_MODEL,
        stream: false,
        timeout_ms: REVISE_APPLY_MAX_MS,
      },
      { allowFallback: true, fallbackAttempts: 0, maxFallbackAttempts: 1 }
    );
    const appliedDoc = normalizePrimarySectionNumbers(typeof applied === 'string' ? applied.trim() : '');
    if (!appliedDoc) return res.status(500).json({ success: false, message: '修订结果为空' });
    const planInfo = resolveRequestPlanInfo(req);
    return res.json({
      success: true,
      mode: 'local_only',
      document: appliedDoc,
      revisionReport: {
        applied: list.length,
        consistencyUpdated: false,
        linkedUpdates: [],
        mode: 'constrained_global_consistency',
      },
      plan: planInfo.plan,
      quotaRemaining: userId ? getQuotaRemaining(userId) : planInfo.quotaRemaining,
      entitlements: planInfo.entitlements,
    });
  } catch (e) {
    console.error('[revise]', e);
    const msg = e?.message || String(e) || '修订失败';
      const fallback = applyLocalRevisionFallback(document, list);
      if (fallback.used) {
      const planInfo = resolveRequestPlanInfo(req);
      return res.json({
        success: true,
        degraded: true,
        mode: 'local_only',
        message: `修订模型超时或失败，已返回规则兜底版本：${msg}`,
        document: normalizePrimarySectionNumbers(fallback.document),
        revisionReport: {
          applied: fallback.applied,
          consistencyUpdated: false,
          linkedUpdates: [],
          mode: 'constrained_global_consistency',
        },
        plan: planInfo.plan,
        quotaRemaining: userId ? getQuotaRemaining(userId) : planInfo.quotaRemaining,
        entitlements: planInfo.entitlements,
      });
    }
    return res.status(500).json({ success: false, message: msg });
  }
}));

app.post('/api/document/revise/repair', attachOptionalAuth, attachPlanInfo, asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  const document = sanitizeText(req.body?.document, 120000);
  const list = sanitizeAnnotations(req.body?.annotations);
  if (!document) {
    return res.status(400).json({ success: false, message: '缺少 document' });
  }
  const userId = req.authUser?.id;
  const affectedSections = getAffectedSections(document, list);
  const job = enqueueReviseConsistencyJob({
    userId,
    appliedDocument: document,
    annotations: list,
    affectedSections,
  });
  return res.json({
    success: true,
    repairJobId: job.id,
    status: job.status,
    stage: job.stage,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    elapsedMs: job.elapsedMs,
    remainingMs: job.remainingMs,
    message: '全篇修复任务已创建，正在后台处理',
  });
}));

app.get(['/api/document/revise/repair/:jobId', '/api/document/revise/:jobId'], attachOptionalAuth, attachPlanInfo, asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  cleanupReviseConsistencyJobs();
  const jobId = sanitizeText(req.params?.jobId, 80);
  const job = reviseConsistencyJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ success: false, message: '联动任务不存在或已过期' });
  }
  if (AUTH_REQUIRED && job?.payload?.userId && req.authUser?.id !== job.payload.userId) {
    return res.status(403).json({ success: false, message: '无权访问该联动任务' });
  }
  const now = Date.now();
  const elapsedMs = Math.max(now - job.createdAt, 0);
  const remainingMs = job.deadlineAt ? Math.max(job.deadlineAt - now, 0) : 0;
  const planInfo = resolveRequestPlanInfo(req);
  return res.json({
    success: true,
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    step: job.step,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    elapsedMs,
    remainingMs,
    linkedUpdates: job.linkedUpdates,
    candidateDocument: (job.status === 'completed' || job.status === 'completed_degraded')
      ? job.candidateDocument
      : undefined,
    message: job.message || undefined,
    plan: planInfo.plan,
    quotaRemaining: req.authUser?.id ? getQuotaRemaining(req.authUser.id) : planInfo.quotaRemaining,
    entitlements: planInfo.entitlements,
  });
}));

app.post(['/api/document/revise/repair/:jobId/retry', '/api/document/revise/:jobId/retry'], attachOptionalAuth, attachPlanInfo, asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  cleanupReviseConsistencyJobs();
  const jobId = sanitizeText(req.params?.jobId, 80);
  const job = reviseConsistencyJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ success: false, message: '联动任务不存在或已过期' });
  }
  if (AUTH_REQUIRED && job?.payload?.userId && req.authUser?.id !== job.payload.userId) {
    return res.status(403).json({ success: false, message: '无权重试该联动任务' });
  }
  if (job.status === 'running' || job.status === 'queued') {
    return res.json({
      success: true,
      jobId: job.id,
      status: job.status,
      message: '任务正在执行中，无需重试',
    });
  }
  const now = Date.now();
  updateReviseConsistencyJob(jobId, {
    status: 'queued',
    step: '用户触发重试，已重置预算并等待执行',
    attempt: 0,
    deadlineAt: now + REVISE_TOTAL_BUDGET_MS,
    createdAt: now,
    message: '',
    linkedUpdates: [],
    candidateDocument: '',
  });
  if (!reviseConsistencyQueue.includes(jobId)) {
    reviseConsistencyQueue.push(jobId);
  }
  schedulePersistJobs();
  processReviseConsistencyQueue();
  const refreshed = reviseConsistencyJobs.get(jobId);
  return res.json({
    success: true,
    jobId: job.id,
    status: 'queued',
    stage: refreshed?.stage || job.stage,
    attempt: refreshed?.attempt ?? 0,
    maxAttempts: refreshed?.maxAttempts || job.maxAttempts,
    elapsedMs: refreshed?.elapsedMs ?? 0,
    remainingMs: refreshed?.remainingMs ?? REVISE_TOTAL_BUDGET_MS,
  });
}));

app.post(['/api/document/revise/repair/:jobId/apply', '/api/document/revise/:jobId/apply'], attachOptionalAuth, attachPlanInfo, asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  cleanupReviseConsistencyJobs();
  const jobId = sanitizeText(req.params?.jobId, 80);
  const job = reviseConsistencyJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ success: false, message: '联动任务不存在或已过期' });
  }
  if (AUTH_REQUIRED && job?.payload?.userId && req.authUser?.id !== job.payload.userId) {
    return res.status(403).json({ success: false, message: '无权应用该联动任务' });
  }
  if (job.status !== 'completed' && job.status !== 'completed_degraded') {
    return res.status(409).json({ success: false, message: '联动任务尚未完成，无法应用' });
  }
  updateReviseConsistencyJob(jobId, {
    applied: true,
    step: '联动版本已被用户应用',
  });
  return res.json({
    success: true,
    jobId: job.id,
    applied: true,
    document: job.candidateDocument,
    linkedUpdates: job.linkedUpdates,
  });
}));

app.post('/api/document/export', requireAuth, attachPlanInfo, asyncRoute(async (req, res) => {
  res.set(jsonHeader);
  const document = sanitizeText(req.body?.document, 120000);
  const title = sanitizeText(req.body?.title, 120) || '需求文档';
  if (!document) {
    return res.status(400).json({ success: false, code: 'invalid_params', message: '缺少 document' });
  }
  const canDownload = Boolean(req.planInfo?.entitlements?.canDownload);
  if (!canDownload) {
    return res.status(402).json({
      success: false,
      code: 'subscription_required',
      message: '下载功能需开通月订阅',
      plan: req.planInfo?.plan,
      quotaRemaining: req.planInfo?.quotaRemaining,
      entitlements: req.planInfo?.entitlements,
    });
  }
  return res.json({
    success: true,
    title,
    document,
    contentType: 'text/markdown;charset=utf-8',
  });
}));

if (hasFrontendDist) {
  app.use(express.static(frontendDistDir));
  app.get(/^(?!\/api(?:\/|$)).*/, (req, res) => {
    res.sendFile(frontendIndexFile);
  });
}

app.use((err, req, res, next) => {
  console.error('[未捕获错误]', err);
  if (!res.headersSent) {
    res.set(jsonHeader);
    let msg = err?.message || String(err) || 'Internal Server Error';
    if (msg === 'Internal Server Error') {
      msg = '服务器内部错误，请查看运行后端的终端里的报错信息';
    }
    res.status(500).json({
      success: false,
      ...(err?.code ? { code: err.code } : {}),
      message: msg,
    });
  }
});

const key = (process.env.LLM_API_KEY || '').replace(/\r?\n/g, '').trim();
if (!key) {
  console.warn('未检测到 LLM_API_KEY，请在 backend/.env 中配置。');
} else if (!key.startsWith('sk-')) {
  console.warn('LLM_API_KEY 应以 sk- 开头，当前长度:', key.length);
} else {
  console.log('LLM_API_KEY 已加载，长度:', key.length);
}

if (!JWT_SECRET || JWT_SECRET === 'change-this-secret-in-prod') {
  console.warn('JWT_SECRET 使用默认值，生产环境请务必设置强随机值。');
}
if (SENTRY_DSN) {
  console.log('SENTRY_DSN 已配置（当前版本仅输出结构化错误日志，建议接入 SDK）。');
}

loadPlatformState();
loadQueueState();
processGenerationQueue();
processReviseConsistencyQueue();

process.on('SIGINT', () => {
  persistPlatformState();
  persistQueueState();
  process.exit(0);
});
process.on('SIGTERM', () => {
  persistPlatformState();
  persistQueueState();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
