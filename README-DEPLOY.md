# README-DEPLOY

本文档用于把项目从本地开发推进到公网可用（含支付与下载门禁）。

## 1. 部署目标

- 域名可访问（HTTPS）
- 匿名可试用生成与修订
- 下载时触发登录与订阅校验
- 支付完成后可下载
- 核心链路可观测、可回滚

## 2. 环境分层

1. `dev/test`
- 目标：快速联调与功能验证
- 建议：`ANON_QUOTA_ENFORCED=0`

2. `staging`
- 目标：接近生产的真实压测
- 建议：开启匿名限次与真实限流，接入测试支付

3. `prod`
- 目标：真实用户与真实收款
- 要求：全量风控与鉴权开启，密钥全替换

## 3. 必备环境变量

以根目录 `.env.example` 为基准，至少确认以下项：

- 基础：`PORT` `APP_ENV_PROFILE` `CORS_ORIGIN`
- LLM：`LLM_API_KEY` `LLM_BASE_URL` `LLM_MODEL_V3` `LLM_MODEL_R1`
- 鉴权：`AUTH_REQUIRED` `JWT_SECRET`
- 邮件：`RESEND_API_KEY` `MAIL_FROM` `RESET_PASSWORD_URL_BASE`
- 支付：`PADDLE_ENV` `PADDLE_API_KEY` `PADDLE_WEBHOOK_SECRET` `PADDLE_PRICE_ID_CNY` `PADDLE_PRICE_ID_USD` `PADDLE_SUCCESS_URL` `PADDLE_CANCEL_URL`
- 可观测：`STRUCTURED_LOG` `SENTRY_DSN`
- 备份：`BACKUP_ENABLED` `BACKUP_INTERVAL_MS` `BACKUP_RETENTION_DAYS`

注意：生产环境不得使用默认 `JWT_SECRET`。

## 4. 本地打包与单机运行

```bash
npm install
npm run build
npm start
```

- 前端静态资源由后端托管。
- 默认访问：`http://localhost:3001`（同源 API）。

## 5. 生产发布建议流程

1. 构建产物
- 执行 `npm run build`，确认前后端构建通过。

2. 注入生产环境变量
- 使用平台密钥管理，不把真实密钥提交到仓库。

3. 启动新版本
- 单实例：先拉起新进程再切流。
- 多实例：滚动发布，逐台替换。

4. 运行冒烟
- 健康检查：
  - `GET /api/health`
  - `GET /api/ready`
- 主流程：
  - 首页输入 -> 澄清 -> 生成 -> 文档页修订
  - 下载触发登录
  - 免费用户触发订阅门禁
  - 支付完成后下载成功

5. 监控观察（发布后 30-60 分钟）
- 关注：5xx 比例、生成失败率、修订失败率、支付回调异常。

## 6. 回滚策略

触发条件（任一满足）：
- 主链路成功率 < 90%
- 支付不可用 > 10 分钟
- 高频 5xx 持续增长

回滚步骤：
1. 切回上一稳定版本
2. 保留当前日志与错误快照
3. 标记问题版本并停止继续放量

## 7. 数据备份与恢复（最小可用）

默认开启每日备份，文件路径：

- 用户与订阅状态：`backend/data/backups/platform-store.<timestamp>.json`
- 任务状态：`backend/data/backups/job-store.<timestamp>.json`

恢复步骤：

1. 停止后端进程。
2. 选择最近一份可用备份：
  - 复制 `platform-store.<timestamp>.json` 到 `backend/data/platform-store.json`
  - 复制 `job-store.<timestamp>.json` 到 `backend/data/job-store.json`
3. 启动后端并检查：
  - `GET /api/ready`
  - `GET /api/health`
4. 抽样验证登录、生成、导出权限。

## 8. 上线前验收清单

- [ ] `上线阻断清单.md` 中所有 P0 关闭
- [ ] 支付链路已接真实通道与回调
- [ ] 鉴权与下载门禁符合产品策略
- [ ] 法务页面可访问（协议/隐私/退款）
- [ ] 有值班与应急联系人

## 9. 当前架构限制（已知）

- 任务队列为内存态，服务重启后未完成任务会丢失。
- 若面向真实付费用户，建议下一阶段迁移为持久化任务队列（Redis/BullMQ 或数据库任务表）。
