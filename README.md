# Requirement Website

一个用于把一句话需求整理为 PRD 的前后端项目。

## 项目结构

- `frontend`：React + Vite + TypeScript
- `backend`：Node.js + Express + OpenAI 兼容接口

## 本地开发

```bash
npm run dev:backend
npm run dev:frontend
```

- 前端默认运行在 `http://localhost:5173`
- 后端默认运行在 `http://localhost:3001`

## 生产构建

```bash
npm run build
npm start
```

生产模式下，后端会优先托管 `frontend/dist`，因此可以作为单服务部署。

## 关键环境变量（按当前代码）

后端环境变量放在 `backend/.env`。生产至少配置：

- `APP_ENV_PROFILE=prod`
- `LLM_API_KEY`（必填）
- `JWT_SECRET`（必填，强随机）
- `CORS_ORIGIN=https://你的前端域名`
- `AUTH_REQUIRED=1`

### 生成链路（质量与长度）

- `LLM_MODEL_V3` / `LLM_MODEL_R1`
- `LLM_MODEL_V3_FALLBACK` / `LLM_MODEL_R1_FALLBACK`
- `LLM_TIMEOUT_MS`（单次模型请求超时，默认 `480000`）
- `LLM_MAX_TOKENS_CAP`（模型安全上限，默认 `8192`）
- `MAX_OUTPUT_TOKENS`（业务请求值，默认 `12288`，会被 cap 自动截断）
- `QUALITY_MIN_FINAL_CHARS`（默认 `4500`）
- `FINAL_COMPLETION_SCORE_THRESHOLD`（默认 `80`）

### 预算与重试

- `GEN_TOTAL_BUDGET_MS`（默认 `480000`）
- `REASON_MAX_MS`（默认 `180000`）
- `GENERATE_MAX_MS`（默认 `360000`）
- `DRAFT_MAX_MS`（默认 `180000`）
- `MAX_FALLBACK_ATTEMPTS_PER_JOB`（默认 `2`）
- `SAFETY_MARGIN_MS`（默认 `15000`）

### 修订链路

- `REVISE_TOTAL_BUDGET_MS`（默认 `180000`）
- `REVISE_APPLY_MAX_MS`（默认 `240000`）
- `REVISE_CONSISTENCY_MAX_MS`（默认 `160000`）
- `REVISE_CONSISTENCY_MAX_ATTEMPTS`（默认 `2`）

### 鉴权、配额、支付

- `ACCESS_TOKEN_TTL_MS` / `REFRESH_TOKEN_TTL_MS`
- `ANON_QUOTA_ENFORCED`（`dev/test` 建议 `0`，`prod` 建议 `1`）
- `PADDLE_ENV`（`sandbox` 或 `live`）
- `PADDLE_API_KEY`
- `PADDLE_WEBHOOK_SECRET`
- `PADDLE_PRICE_ID_CNY`
- `PADDLE_PRICE_ID_USD`
- `PADDLE_SUCCESS_URL` / `PADDLE_CANCEL_URL`
- `SENTRY_DSN`（可选）

前端可选环境变量（Vercel）：

- `VITE_API_BASE`（例如 `https://your-backend.up.railway.app/api`）
- `VITE_API_TIMEOUT_MS`（默认 `300000`）
- `VITE_CLARIFY_TIMEOUT_MS`（默认 `45000`）
- `VITE_CREATE_JOB_TIMEOUT_MS`（默认 `15000`）
- `VITE_JOB_STATUS_TIMEOUT_MS`（默认 `15000`）
- `VITE_GENERATE_MAX_WAIT_MS`（默认 `540000`）
- `VITE_HOME_STATE_TTL_MS`（默认 `1200000`）

## 新增 API 能力（SaaS 基础版）

- 认证：`POST /api/auth/register|login|refresh|logout`、`GET /api/auth/me`
- 匿名试用：`POST /api/trial/claim`、`POST /api/trial/generate`
- 计费：`GET /api/billing/plans|subscription|invoices`、`POST /api/billing/subscription|checkout-session`
- 月订阅快捷下单：`POST /api/subscription/checkout`
- 支付回调：`POST /api/webhooks/paddle`
- 用量：`GET /api/usage`
- 漏斗事件：`POST /api/events`、`GET /api/events/funnel`
- 健康检查：`GET /api/health`、`GET /api/ready`

说明：现有 `generate/revise` 接口已接入鉴权与月配额校验，并返回 `plan`、`quotaRemaining`、`entitlements` 字段；下载接口 `POST /api/document/export` 需月订阅。

## 上线前快速检查（建议每次发布都跑）

```bash
npm run check
npm run build
```

线上验证：

- `GET /api/health`：确认 `ok=true` 且 `maxOutputTokens` 合理（当前 DeepSeek 推荐 `8192`）
- `GET /api/ready`：确认依赖可用
- 端到端冒烟：输入 -> 澄清 -> 生成 -> 标注修订 -> 下载门禁
