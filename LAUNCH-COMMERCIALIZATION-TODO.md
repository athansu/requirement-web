# 上线后商业化执行清单（Paddle + .ai + SEO）

## P0（上线前必须完成）

### 1. `.ai` 域名与 DNS
- 购买主域名（建议：`requirement-web.ai`）。
- DNS：
  - `www` -> Vercel CNAME
  - `api` -> Railway CNAME
  - 裸域 `@` -> 301 到 `https://www.requirement-web.ai`
- 前端域名切换后更新后端变量：`CORS_ORIGIN=https://www.requirement-web.ai`

### 2. Paddle 收款闭环
- 在 Paddle Dashboard 创建：
  - CNY 月付商品（¥9.9）
  - USD 月付商品（$3.99）
- 配置后端变量：
  - `PADDLE_ENV`
  - `PADDLE_API_KEY`
  - `PADDLE_WEBHOOK_SECRET`
  - `PADDLE_PRICE_ID_CNY`
  - `PADDLE_PRICE_ID_USD`
  - `PADDLE_SUCCESS_URL`
  - `PADDLE_CANCEL_URL`
- Webhook URL：`https://api.<你的域名>/api/webhooks/paddle`
- 验证事件：
  - `transaction.completed`
  - `subscription.created`
  - `subscription.updated`
  - `subscription.canceled`

### 3. 导出门禁验收
- 匿名生成/修订可用。
- 点击导出：
  - 未登录 -> 弹登录
  - 已登录未订阅 -> 弹支付
  - 支付成功后自动继续导出

### 4. 法务页上线
- `用户协议`：`/legal/terms.html`
- `隐私政策`：`/legal/privacy.html`
- `退款说明`：`/legal/refund.html`
- `联系邮箱`：`/legal/contact.html`

### 5. 可观测
- 结构化日志字段验收：`requestId / userId / jobId / paymentSessionId`
- 打开错误监控（Sentry）。

---

## P1（上线后 1-2 周）

### 1. 内容矩阵
- 每周发布：
  - 3 篇案例
  - 2 篇关键词文章
  - 1 个模板
- 已有入口：
  - `/content/features.html`
  - `/content/templates.html`
  - `/content/cases.html`

### 2. 漏斗指标
- 前端埋点：`visit/start_generate/enter_editor/click_export/login_success`
- 后端埋点：`checkout_start/checkout_success/export_success`
- 查看接口：`GET /api/events/funnel?day=YYYY-MM-DD`

---

## P2（上线后 3-4 周）

### 1. 持久化账单与权益
- 引入托管 DB（Neon/Postgres）存订阅状态、Webhook 事件、导出记录。
- Webhook 幂等键改用数据库唯一约束。

### 2. A/B 转化实验
- 导出弹窗文案：价值导向 vs 折扣导向。
- 首次生成后引导文案：如何直接投喂 AI Coding IDE。

### 3. 英文站
- 最小范围：首页、价格页、FAQ 三页英文版。
- 保持 URL 可索引并提交 Search Console。

