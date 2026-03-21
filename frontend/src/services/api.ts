const API_BASE = import.meta.env.VITE_API_BASE?.trim() || '/api';
const API_TIMEOUT_MS = Math.max(Number(import.meta.env.VITE_API_TIMEOUT_MS) || 300000, 1000);
const CLARIFY_TIMEOUT_MS = Math.max(Number(import.meta.env.VITE_CLARIFY_TIMEOUT_MS) || 45000, 3000);
const CREATE_JOB_TIMEOUT_MS = Math.max(Number(import.meta.env.VITE_CREATE_JOB_TIMEOUT_MS) || 15000, 3000);
const JOB_STATUS_TIMEOUT_MS = Math.max(Number(import.meta.env.VITE_JOB_STATUS_TIMEOUT_MS) || 15000, 3000);
const AUTH_STORAGE_KEY = 'requirement-website.auth.v1';
const DEVICE_FINGERPRINT_KEY = 'requirement-website.device-fingerprint.v1';
const ANON_FRIENDLY_PATHS = [
  '/clarify',
  '/document/generate',
  '/document/revise',
];

type StoredAuth = {
  accessToken: string;
  refreshToken: string;
};

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function readStoredAuth(): StoredAuth | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAuth>;
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
  } catch {
    return null;
  }
}

let authState: StoredAuth | null = readStoredAuth();

function getOrCreateDeviceFingerprint(): string {
  if (typeof window === 'undefined') return '';
  const existing = window.localStorage.getItem(DEVICE_FINGERPRINT_KEY);
  if (existing) return existing;
  const generated = `fp_${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
  window.localStorage.setItem(DEVICE_FINGERPRINT_KEY, generated);
  return generated;
}

export function getAuthTokens() {
  return authState;
}

export function setAuthTokens(next: StoredAuth | null) {
  authState = next;
  if (typeof window === 'undefined') return;
  if (!next) {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(next));
}

async function post<T>(path: string, body: object, timeoutMs = API_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  const hasAuth = Boolean(authState?.accessToken);
  const canRetryWithoutAuth = hasAuth && ANON_FRIENDLY_PATHS.some((prefix) => path.startsWith(prefix));
  const fingerprint = getOrCreateDeviceFingerprint();
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(fingerprint ? { 'x-device-fingerprint': fingerprint } : {}),
        ...(authState?.accessToken ? { Authorization: `Bearer ${authState.accessToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`请求超时，超过 ${timeoutMs}ms 仍未完成。复杂场景建议稍后重试，或缩小首版需求范围。`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
  if (res.status === 401 && canRetryWithoutAuth) {
    res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(fingerprint ? { 'x-device-fingerprint': fingerprint } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  }
  const text = await res.text();
  let data: { message?: string; code?: string } = {};
  try {
    data = JSON.parse(text) as { message?: string; code?: string };
  } catch {
    if (!res.ok && text) {
      const snippet = text.slice(0, 200).replace(/\s+/g, ' ');
      throw new ApiError(`服务器错误 (${res.status})：${snippet || res.statusText}`, res.status);
    }
  }
  if (res.status === 401) {
    setAuthTokens(null);
  }
  if (!res.ok) throw new ApiError(data.message || res.statusText || text?.slice(0, 100) || '请求失败', res.status, data.code);
  return data as T;
}

async function get<T>(path: string, timeoutMs = JOB_STATUS_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  const hasAuth = Boolean(authState?.accessToken);
  const canRetryWithoutAuth = hasAuth && ANON_FRIENDLY_PATHS.some((prefix) => path.startsWith(prefix));
  const fingerprint = getOrCreateDeviceFingerprint();
  try {
    res = await fetch(`${API_BASE}${path}`, {
      signal: controller.signal,
      headers: {
        ...(fingerprint ? { 'x-device-fingerprint': fingerprint } : {}),
        ...(authState?.accessToken ? { Authorization: `Bearer ${authState.accessToken}` } : {}),
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`请求超时，超过 ${timeoutMs}ms 仍未完成`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
  if (res.status === 401 && canRetryWithoutAuth) {
    res = await fetch(`${API_BASE}${path}`, {
      signal: controller.signal,
      headers: fingerprint ? { 'x-device-fingerprint': fingerprint } : undefined,
    });
  }
  const text = await res.text();
  let data: { message?: string; code?: string } = {};
  try {
    data = JSON.parse(text) as { message?: string; code?: string };
  } catch {
    if (!res.ok) {
      throw new ApiError(`请求失败 (${res.status})`, res.status);
    }
  }
  if (res.status === 401) {
    setAuthTokens(null);
  }
  if (!res.ok) throw new ApiError(data.message || '请求失败', res.status, data.code);
  return data as T;
}

export interface ClarifyRes {
  success: boolean;
  questions?: string[];
  plan?: string;
  quotaRemaining?: {
    generateRemaining: number;
    reviseRemaining: number;
    tokenRemaining: number;
    period: string;
  };
  entitlements?: {
    canDownload: boolean;
    canGenerate: boolean;
    canRevise: boolean;
  };
  message?: string;
}

export interface GenerateRes {
  success: boolean;
  document?: string;
  message?: string;
  plan?: string;
  quotaRemaining?: {
    generateRemaining: number;
    reviseRemaining: number;
    tokenRemaining: number;
    period: string;
  };
  entitlements?: {
    canDownload: boolean;
    canGenerate: boolean;
    canRevise: boolean;
  };
}

export interface GenerateJobCreateRes {
  success: boolean;
  jobId?: string;
  status?: 'queued' | 'running' | 'completed' | 'failed';
  lifecycle?: 'queued' | 'running_draft' | 'running_complete' | 'running_consistency' | 'completed_final' | 'completed_partial' | 'failed_fatal';
  stage?: string;
  outputLevel?: 'draft' | 'partial' | 'final';
  progress?: number;
  stageProgress?: number;
  overallProgress?: number;
  step?: string;
  elapsedMs?: number;
  remainingMs?: number;
  attempt?: number;
  maxAttempts?: number;
  lastError?: string;
  fallbackAttempts?: number;
  missingSections?: string[];
  document?: string;
  message?: string;
  plan?: string;
  quotaRemaining?: {
    generateRemaining: number;
    reviseRemaining: number;
    tokenRemaining: number;
    period: string;
  };
  entitlements?: {
    canDownload: boolean;
    canGenerate: boolean;
    canRevise: boolean;
  };
}

export interface GenerateJobStatusRes {
  success: boolean;
  jobId?: string;
  status?: 'queued' | 'running' | 'completed' | 'failed';
  lifecycle?: 'queued' | 'running_draft' | 'running_complete' | 'running_consistency' | 'completed_final' | 'completed_partial' | 'failed_fatal';
  stage?: string;
  outputLevel?: 'draft' | 'partial' | 'final';
  progress?: number;
  stageProgress?: number;
  overallProgress?: number;
  step?: string;
  elapsedMs?: number;
  remainingMs?: number;
  attempt?: number;
  maxAttempts?: number;
  lastError?: string;
  fallbackAttempts?: number;
  missingSections?: string[];
  document?: string;
  queuePosition?: number;
  message?: string;
  plan?: string;
  quotaRemaining?: {
    generateRemaining: number;
    reviseRemaining: number;
    tokenRemaining: number;
    period: string;
  };
  entitlements?: {
    canDownload: boolean;
    canGenerate: boolean;
    canRevise: boolean;
  };
}

export interface GenerateJobActionRes {
  success: boolean;
  jobId?: string;
  status?: 'queued' | 'running' | 'completed' | 'failed';
  stage?: string;
  forcedStage?: 'draft' | 'complete' | 'consistency';
  message?: string;
  plan?: string;
  quotaRemaining?: {
    generateRemaining: number;
    reviseRemaining: number;
    tokenRemaining: number;
    period: string;
  };
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface AuthRes {
  success: boolean;
  user?: AuthUser;
  accessToken?: string;
  refreshToken?: string;
  plan?: string;
  planName?: string;
  limits?: {
    monthlyGenerate: number;
    monthlyRevise: number;
    monthlyTokens: number;
    maxConcurrentJobs: number;
    perMinRequests: number;
  };
  entitlements?: {
    canDownload: boolean;
    canGenerate: boolean;
    canRevise: boolean;
  };
  subscription?: {
    userId: string;
    planId: string;
    cycle: 'monthly';
    status: 'none' | 'active' | 'past_due' | 'canceled';
    renewAt: string | null;
    startedAt: string | null;
    updatedAt: string | null;
  };
  quotaRemaining?: {
    generateRemaining: number;
    reviseRemaining: number;
    tokenRemaining: number;
    period: string;
  };
  message?: string;
}

export interface BillingPlansRes {
  success: boolean;
  plans: {
    id: string;
    name: string;
    cycle: string[];
    priceCny: { monthly: number; yearly: number };
    priceUsd: { monthly: number; yearly: number };
    limits: {
      monthlyGenerate: number;
      monthlyRevise: number;
      monthlyTokens: number;
      maxConcurrentJobs: number;
      perMinRequests: number;
    };
  }[];
}

export interface UsageRes {
  success: boolean;
  period: string;
  usage: {
    period: string;
    userId: string;
    generateCount: number;
    reviseCount: number;
    tokenCount: number;
  };
  quotaRemaining: {
    generateRemaining: number;
    reviseRemaining: number;
    tokenRemaining: number;
    period: string;
  };
  plan: string;
  limits: {
    monthlyGenerate: number;
    monthlyRevise: number;
    monthlyTokens: number;
    maxConcurrentJobs: number;
    perMinRequests: number;
  };
  entitlements: {
    canDownload: boolean;
    canGenerate: boolean;
    canRevise: boolean;
  };
}

export interface ReviseRes {
  success: boolean;
  code?: string;
  mode?: 'local_only';
  document?: string;
  revisionReport?: {
    applied: number;
    consistencyUpdated: boolean;
    linkedUpdates: { section: string; summary: string; reason?: string }[];
    mode: 'constrained_global_consistency';
  };
  plan?: string;
  quotaRemaining?: {
    generateRemaining: number;
    reviseRemaining: number;
    tokenRemaining: number;
    period: string;
  };
  entitlements?: {
    canDownload: boolean;
    canGenerate: boolean;
    canRevise: boolean;
  };
  message?: string;
}

export interface ReviseConsistencyJobStatusRes {
  success: boolean;
  jobId?: string;
  status?: 'queued' | 'running' | 'completed' | 'completed_degraded' | 'failed';
  stage?: 'consistency';
  step?: string;
  attempt?: number;
  maxAttempts?: number;
  elapsedMs?: number;
  remainingMs?: number;
  linkedUpdates?: { section: string; summary: string; reason?: string }[];
  candidateDocument?: string;
  message?: string;
}

export interface ReviseRepairJobCreateRes {
  success: boolean;
  repairJobId?: string;
  status?: 'queued' | 'running' | 'completed' | 'completed_degraded' | 'failed';
  stage?: 'consistency';
  attempt?: number;
  maxAttempts?: number;
  elapsedMs?: number;
  remainingMs?: number;
  message?: string;
}

export interface ReviseConsistencyApplyRes {
  success: boolean;
  code?: string;
  jobId?: string;
  applied?: boolean;
  document?: string;
  linkedUpdates?: { section: string; summary: string; reason?: string }[];
  message?: string;
}

export interface TrialClaimRes {
  success: boolean;
  code?: string;
  anonTrialToken?: string;
  expiresInMs?: number;
  message?: string;
}

export interface TrialGenerateRes {
  success: boolean;
  code?: string;
  document?: string;
  outputLevel?: 'preview';
  plan?: string;
  quotaRemaining?: {
    generateRemaining: number;
    reviseRemaining: number;
    tokenRemaining: number;
    period: string;
  };
  entitlements?: {
    canDownload: boolean;
    canGenerate: boolean;
    canRevise: boolean;
  };
  message?: string;
}

export interface SubscriptionCheckoutRes {
  success: boolean;
  code?: string;
  sessionId?: string;
  provider?: string;
  planId?: string;
  cycle?: 'monthly';
  checkoutUrl?: string;
  message?: string;
}

export function getClarificationQuestions(userRequirement: string, scenario?: string): Promise<ClarifyRes> {
  return post<ClarifyRes>('/clarify', {
    userRequirement,
    ...(scenario ? { scenario } : {}),
  }, CLARIFY_TIMEOUT_MS);
}

export function generateDocument(
  userRequirement: string,
  clarificationAnswers?: { q: string; a: string }[],
  scenario?: string
): Promise<GenerateJobCreateRes> {
  return post<GenerateJobCreateRes>('/document/generate', {
    userRequirement,
    ...(clarificationAnswers?.length ? { clarificationAnswers } : {}),
    ...(scenario ? { scenario } : {}),
  }, CREATE_JOB_TIMEOUT_MS);
}

export async function getGenerateJobStatus(jobId: string): Promise<GenerateJobStatusRes> {
  return get<GenerateJobStatusRes>(`/document/generate/${encodeURIComponent(jobId)}`, JOB_STATUS_TIMEOUT_MS);
}

export function retryGenerateJobStage(
  jobId: string,
  stage?: 'draft' | 'complete' | 'consistency'
): Promise<GenerateJobActionRes> {
  return post<GenerateJobActionRes>(`/document/generate/${encodeURIComponent(jobId)}/retry-stage`, {
    ...(stage ? { stage } : {}),
  });
}

export function continueGenerateJob(jobId: string): Promise<GenerateJobActionRes> {
  return post<GenerateJobActionRes>(`/document/generate/${encodeURIComponent(jobId)}/continue`, {});
}

export function reviseDocument(
  document: string,
  annotations: {
    type: string;
    quote: string;
    content?: string;
    note?: string;
    anchorPolicy?: 'replace_selected' | 'delete_selected' | 'insert_after_selected';
  }[]
): Promise<ReviseRes> {
  return post<ReviseRes>('/document/revise', { document, annotations });
}

export async function getReviseConsistencyJobStatus(jobId: string): Promise<ReviseConsistencyJobStatusRes> {
  return get<ReviseConsistencyJobStatusRes>(`/document/revise/repair/${encodeURIComponent(jobId)}`, JOB_STATUS_TIMEOUT_MS);
}

export function retryReviseConsistencyJob(jobId: string): Promise<ReviseConsistencyJobStatusRes> {
  return post<ReviseConsistencyJobStatusRes>(`/document/revise/repair/${encodeURIComponent(jobId)}/retry`, {});
}

export function applyReviseConsistencyJob(jobId: string): Promise<ReviseConsistencyApplyRes> {
  return post<ReviseConsistencyApplyRes>(`/document/revise/repair/${encodeURIComponent(jobId)}/apply`, {});
}

export function createReviseRepairJob(
  document: string,
  annotations: {
    type: string;
    quote: string;
    content?: string;
    note?: string;
    anchorPolicy?: 'replace_selected' | 'delete_selected' | 'insert_after_selected';
  }[]
): Promise<ReviseRepairJobCreateRes> {
  return post<ReviseRepairJobCreateRes>('/document/revise/repair', { document, annotations });
}

export async function register(email: string, password: string, name?: string): Promise<AuthRes> {
  const res = await post<AuthRes>('/auth/register', { email, password, ...(name ? { name } : {}) }, API_TIMEOUT_MS);
  if (res.success && res.accessToken && res.refreshToken) {
    setAuthTokens({ accessToken: res.accessToken, refreshToken: res.refreshToken });
  }
  return res;
}

export async function login(email: string, password: string): Promise<AuthRes> {
  const res = await post<AuthRes>('/auth/login', { email, password }, API_TIMEOUT_MS);
  if (res.success && res.accessToken && res.refreshToken) {
    setAuthTokens({ accessToken: res.accessToken, refreshToken: res.refreshToken });
  }
  return res;
}

export async function refreshAuth(): Promise<AuthRes> {
  const refreshToken = authState?.refreshToken;
  if (!refreshToken) throw new Error('未登录');
  const res = await post<AuthRes>('/auth/refresh', { refreshToken }, API_TIMEOUT_MS);
  if (res.success && res.accessToken && res.refreshToken) {
    setAuthTokens({ accessToken: res.accessToken, refreshToken: res.refreshToken });
  } else {
    setAuthTokens(null);
  }
  return res;
}

export async function logout(): Promise<void> {
  const refreshToken = authState?.refreshToken || '';
  try {
    await post<AuthRes>('/auth/logout', { refreshToken }, 8000);
  } catch {
    // ignore
  } finally {
    setAuthTokens(null);
  }
}

export function getMe(): Promise<AuthRes> {
  return get<AuthRes>('/auth/me', 12000);
}

export function getBillingPlans(): Promise<BillingPlansRes> {
  return get<BillingPlansRes>('/billing/plans', 12000);
}

export function getSubscription(): Promise<AuthRes> {
  return get<AuthRes>('/billing/subscription', 12000);
}

export function getUsage(): Promise<UsageRes> {
  return get<UsageRes>('/usage', 12000);
}

export function claimAnonTrial(fingerprint: string): Promise<TrialClaimRes> {
  return post<TrialClaimRes>('/trial/claim', { fingerprint }, 12000);
}

export function generateAnonTrial(
  anonTrialToken: string,
  fingerprint: string,
  userRequirement: string,
  scenario?: string
): Promise<TrialGenerateRes> {
  return post<TrialGenerateRes>('/trial/generate', {
    anonTrialToken,
    fingerprint,
    userRequirement,
    ...(scenario ? { scenario } : {}),
  }, API_TIMEOUT_MS);
}

export function createSubscriptionCheckout(provider: 'stripe' | 'wechatpay' | 'alipay' = 'stripe'): Promise<SubscriptionCheckoutRes> {
  return post<SubscriptionCheckoutRes>('/subscription/checkout', { provider }, 12000);
}

export interface ExportDocumentRes {
  success: boolean;
  code?: string;
  title?: string;
  document?: string;
  contentType?: string;
  message?: string;
}

export function exportDocument(document: string, title?: string): Promise<ExportDocumentRes> {
  return post<ExportDocumentRes>('/document/export', { document, ...(title ? { title } : {}) }, 12000);
}
