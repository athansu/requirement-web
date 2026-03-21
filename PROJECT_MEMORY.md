# 需求梳理网站 · 项目记忆摘要

> 供后续会话或协作快速恢复上下文，避免重复决策。

---

## 一、产品定位与目标

- **定位**：把用户的「模糊想法」转化为【可直接开发的创业级 PRD】的 AI 辅助工具。
- **人设（Prompt）**：连续创业成功的产品负责人 + 10 年经验产品经理 + 具备系统架构能力的 AI 产品专家。
- **类型**：工具型产品（AI 增强的文档生成与修订），非平台/SaaS。

---

## 二、核心用户流程

1. **输入**：用户输入一句话需求。
2. **Phase1 提问**：大模型根据描述生成最多 5 个澄清问题；用户可选择作答或跳过。
3. **Phase2 推理**：大模型根据「需求 + 澄清回答」做结构化推理，输出关键决策与范围。
4. **Phase3 PRD**：大模型根据「需求 + 回答 + 推理结论」生成完整创业级 PRD。
5. **文档页**：用户可对文档做选区标注（修改/删除/补充），点击「按标注修订」由大模型修订整份文档。
6. **导出**：支持导出 .md 文件。

---

## 三、大模型使用策略（四阶段）

| 阶段       | 用途           | 模型           | 说明 |
|------------|----------------|----------------|------|
| Phase1 提问 | 生成澄清问题   | DeepSeek V3（deepseek-chat） | 快速、直接 |
| Phase2 推理 | 需求+回答 → 推理结论 | DeepSeek R1（deepseek-reasoner） | 链式思考 |
| Phase3 PRD  | 生成完整 PRD   | DeepSeek V3    | 详尽写作 |
| Phase4 校验 | 按标注修订文档 | DeepSeek R1    | 推理式修订 |

- 环境变量：`LLM_MODEL_V3`、`LLM_MODEL_R1`（可选，默认 deepseek-chat / deepseek-reasoner）；`LLM_BASE_URL`、`LLM_API_KEY` 在 `backend/.env`。
- 当前默认使用 DeepSeek；曾切换过 Google Gemini（因网络/代理问题放弃），保留代理能力（`LLM_PROXY`）。

---

## 四、PRD 文档必须包含的 9 部分

1. 产品定位（Positioning）  
2. 用户画像（Persona）  
3. 核心用户旅程（User Journey）  
4. 功能列表  
5. 每个功能的详细说明（功能实现目标、功能详细描述、用户目标、输入、系统行为、输出）  
6. 非功能需求  
7. 技术架构建议（高层级）  
8. AI 能力使用点（如适用）  
9. 商业化路径（非常重要）

---

## 五、澄清问题的实现决策

- **后端**：用户点「下一步」后，**先调用大模型**（Phase1 V3）根据一句话需求生成澄清问题；解析响应得到字符串数组。若解析失败或结果无效（空、不足 5 条、含空串），则**兜底返回默认 5 问**（`DEFAULT_CLARIFY_QUESTIONS`）。
- **前端**：进入澄清步骤后，**始终用本地固定的 5 个问题**（`FALLBACK_QUESTIONS`）展示，不依赖接口返回的文案。这样无论接口返回什么，用户都能看到完整的 5 条问题，避免「只有输入框、没有问题」的展示问题。
- **默认 5 问**（与 PRD 九部分对齐）：目标用户与典型场景、首期核心功能与优先级、现成系统/接口/数据对接、上线时间或 MVP 里程碑、技术栈/预算/资源/商业化考虑。

---

## 六、技术栈与结构

- **前端**：React (Vite) + TypeScript，`requirement-website/frontend`；首页（Home）、文档页（DocumentPage）、文档视图（DocumentView）、标注列表（AnnotationList）；API 代理到后端 `/api`。
- **后端**：Node + Express，`requirement-website/backend`；`server.js` 提供 `POST /api/clarify`、`POST /api/document/generate`、`POST /api/document/revise`；`llm.js` 为 OpenAI 兼容 HTTP 调用（支持 `options.model` 与代理）；`prompts.js` 为各阶段 System/User 提示词。
- **编码**：LLM 响应用 `Buffer.concat(chunks).toString('utf8')` 避免 chunk 边界导致中文乱码；接口返回 `Content-Type: application/json; charset=utf-8`。

---

## 七、已做过的修复与优化（避免重复踩坑）

- **文档修订**：禁止把表格或大段正文放在代码块/引号内；要求表格用标准 Markdown 表格语法，前后留空行。
- **标注气泡**：气泡 `top` 做视口内约束，避免页面底部被遮挡无法点击；工具栏/气泡的 mouseUp 做 stopPropagation，避免点击按钮时选区被清空。
- **右侧标注栏**：固定占屏比例（flex: 0 0 28%，min/max width），不随内容伸缩。
- **根路径**：后端 `GET /` 返回简单说明页，引导用户访问前端（如 localhost:5173），避免「Cannot GET /」困惑。
- **API Key**：从 `server.js` 所在目录加载 `backend/.env`；启动时检测并提示是否已加载 Key；Key 需写在同一行且无多余空格（避免磁盘上值为空）。

---

## 八、启动方式

- 后端：`cd requirement-website/backend && npm run start`（默认 3001）。
- 前端：`cd requirement-website/frontend && npm run dev`（默认 5173，代理 /api 到 3001）。
- 使用：浏览器打开前端地址，输入一句话需求 → 获取澄清问题（固定 5 问）→ 作答或跳过 → 生成文档 → 可标注修订、导出 .md。

---

## 九、与项目无关的说明

- **web-demo**：与 requirement-website 无关，为同仓库下其他 demo。
- 若需「创业级 PRD 流程」的 Phase1–3 产品设计讨论（理解、拆解、MVP PRD 输出），可单独进行，不写进本代码库。

---

*最后更新：基于当前代码与对话决策整理。*
