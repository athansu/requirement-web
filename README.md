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

## 关键环境变量

后端环境变量放在 `backend/.env`：

- `LLM_API_KEY`：必填
- `LLM_BASE_URL`：可选，默认 `https://api.deepseek.com`
- `LLM_MODEL_V3`
- `LLM_MODEL_R1`
- `LLM_MODEL_V3_FALLBACK`：V3 主模型异常时的备用模型
- `LLM_MODEL_R1_FALLBACK`：R1 主模型异常时的备用模型
- `LLM_TIMEOUT_MS`：单次模型请求超时，默认 300000
- `REASONING_TIMEOUT_MS`：推理阶段超时，默认 90000
- `GENERATE_TIMEOUT_MS`：主生成阶段超时，默认 180000
- `CONTINUE_TIMEOUT_MS`：自动续写阶段超时，默认 120000
- `GENERATE_MAX_TOKENS`：主生成 token 上限，默认 4096
- `AUTO_CONTINUE_INCOMPLETE`：未完成自动续写，默认开启（`1`）
- `AUTO_CONTINUE_BUDGET_MS`：自动续写触发的总耗时预算，默认 210000
- `GENERATE_JOB_TTL_MS`：生成任务结果保留时长，默认 1800000
- `MAX_GENERATE_JOBS`：内存队列最多保留任务数，默认 200
- `CORS_ORIGIN`：前后端分离部署时可配置允许的来源，多个值用逗号分隔
- `AUTH_REQUIRED`：是否强制鉴权（默认 `1`）
- `JWT_SECRET`：访问令牌签名密钥（生产必填强随机）
- `ACCESS_TOKEN_TTL_MS` / `REFRESH_TOKEN_TTL_MS`：登录态有效期
- `SENTRY_DSN`：监控占位配置（当前版本输出结构化日志）

前端可选环境变量：

- `VITE_API_BASE`：默认 `/api`
- `VITE_API_TIMEOUT_MS`：默认 300000
- `VITE_CLARIFY_TIMEOUT_MS`：澄清问题请求超时，默认 45000
- `VITE_CREATE_JOB_TIMEOUT_MS`：创建生成任务请求超时，默认 15000

## 新增 API 能力（SaaS 基础版）

- 认证：`POST /api/auth/register|login|refresh|logout`、`GET /api/auth/me`
- 匿名试用：`POST /api/trial/claim`、`POST /api/trial/generate`
- 计费：`GET /api/billing/plans|subscription|invoices`、`POST /api/billing/subscription|checkout-session`
- 月订阅快捷下单：`POST /api/subscription/checkout`
- 支付回调占位：`POST /api/webhooks/stripe|wechatpay|alipay`
- 用量：`GET /api/usage`
- 健康检查：`GET /api/health`、`GET /api/ready`

说明：现有 `generate/revise` 接口已接入鉴权与月配额校验，并返回 `plan`、`quotaRemaining`、`entitlements` 字段；下载接口 `POST /api/document/export` 需月订阅。
