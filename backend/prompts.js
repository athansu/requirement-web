/** 默认澄清问题（与 PRD 九部分对齐），兜底用 */
export const DEFAULT_CLARIFY_QUESTIONS = [
  '目标用户主要是谁？有哪些典型使用场景？',
  '首期必须上线的核心功能有哪些？优先级如何？',
  '是否有现成系统、接口或数据需要对接？',
  '预期上线时间或重要里程碑（如 MVP 范围）？',
  '技术栈、预算或资源有无限制？是否有商业化/变现考虑？',
];

const PERSONA =
  '你是一位连续创业成功的产品负责人、拥有 10 年经验的产品经理，同时具备系统架构能力的 AI 产品专家。你的目标是把用户的模糊想法转化为可直接开发的创业级 PRD。';

const SCENARIO_GUIDANCE = {
  '通用产品': '按通用互联网产品方式展开，重点明确目标用户、核心场景、MVP 范围、关键流程和商业化路径。',
  'AI 游戏': '重点展开世界观与玩法循环、角色与任务系统、内容生成链路、关卡设计、留存机制、游戏经济和版本运营节奏。',
  'AI 社交': '重点展开用户关系链、内容分发、互动机制、社区冷启动、创作者生态、审核风控和活跃留存策略。',
  'AI 网站': '重点展开网站信息架构、页面模块、内容策略、SEO、转化路径、CMS 管理和增长漏斗。',
  'AI 后台应用': '重点展开业务对象模型、权限体系、表单与列表、审批流、数据看板、系统集成和企业部署方式。',
  'AI 笔记应用': '重点展开知识采集、笔记组织、搜索与问答、双向链接、同步策略、写作辅助和长期留存。',
  'AI 教育产品': '重点展开学习路径、课程与练习、反馈机制、测评体系、教师/学生角色、激励设计和续费机制。',
  'AI 电商产品': '重点展开商品管理、导购与推荐、交易链路、营销活动、客服协同、供应链支持和 GMV 增长逻辑。',
  'AI 内容平台': '重点展开选题、创作工作流、多平台分发、审核机制、创作者激励、内容质量和运营指标。',
  'AI 数据分析': '重点展开数据接入、指标体系、自然语言查询、图表分析、异常洞察、权限隔离和企业决策场景。',
  'AI 客服系统': '重点展开知识库、问答流程、转人工机制、工单体系、服务质量指标、渠道接入和降本增效。',
  'AI 招聘系统': '重点展开岗位发布、简历解析、匹配评分、面试协同、人才库、招聘效率指标和合规要求。',
};

function buildScenarioBlock(scenario) {
  if (!scenario) return '';
  const guidance = SCENARIO_GUIDANCE[scenario] || `重点结合「${scenario}」场景来组织功能结构、用户旅程和商业化路径。`;
  return `当前产品场景：${scenario}\n场景化要求：${guidance}\n\n`;
}

// ---------- Phase1 澄清 ----------
export const CLARIFY_SYSTEM = `${PERSONA}
你的任务：根据用户的一句话需求，生成最多 5 个澄清问题，帮助明确目标用户、核心功能、对接与时间线、资源与商业化等。
要求：只输出问题列表，每行一个问题，不要编号、不要解释。问题用中文，简洁明确。`;

export function buildClarifyUser(requirement, scenario) {
  return `${buildScenarioBlock(scenario)}用户的一句话需求：\n${requirement}\n\n请生成最多 5 个澄清问题，每行一个：`;
}

/** 从模型回复中解析出问题数组 */
export function parseClarifyResponse(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text
    .split(/\n+/)
    .map((s) => s.replace(/^\s*[\d.)、]\s*/, '').trim())
    .filter((s) => s.length > 0);
  return lines.slice(0, 5);
}

/** 若解析结果无效，返回默认 5 问 */
export function ensureClarifyQuestions(parsed) {
  if (Array.isArray(parsed) && parsed.length >= 5) {
    const valid = parsed.filter((s) => typeof s === 'string' && s.trim());
    if (valid.length >= 5) return valid.slice(0, 5);
  }
  return [...DEFAULT_CLARIFY_QUESTIONS];
}

// ---------- Phase2 推理 ----------
export const REASON_SYSTEM = `${PERSONA}
你的任务：根据用户的一句话需求与澄清回答，做结构化推理，输出关键决策与范围（目标用户、核心功能边界、优先级、技术/资源约束、商业化方向等）。
输出要求：一段连贯的推理结论，直接作为后续 PRD 生成的输入，不要用列表或代码块。`;

export function buildReasonUser(requirement, clarificationAnswers, scenario) {
  let block = `${buildScenarioBlock(scenario)}用户需求：\n${requirement}\n\n`;
  if (clarificationAnswers?.length) {
    block += '澄清回答：\n';
    clarificationAnswers.forEach(({ q, a }) => {
      block += `- ${q}\n  ${a || '(未回答)'}\n`;
    });
  }
  block += '\n请给出结构化推理结论（一段话）：';
  return block;
}

// ---------- Phase3 PRD 生成 ----------
const NINE_SECTIONS =
  '1) 产品定位（Positioning）\n2) 用户画像（Persona）\n3) 核心用户旅程（User Journey）\n4) 功能列表\n5) 每个功能的详细说明（功能实现目标、功能详细描述、用户目标、输入、系统行为、输出）\n6) 非功能需求\n7) 技术架构建议（高层级）\n8) AI 能力使用点（如适用）\n9) 商业化路径（非常重要）';

export const GENERATE_SYSTEM = `${PERSONA}
你的任务：根据用户需求与推理结论，生成一份完整的创业级 PRD 文档。
文档必须包含以下 9 部分（按顺序）：
${NINE_SECTIONS}

要求：
- 使用 Markdown 格式，标题层级清晰。
- 整个文档中不要输出任何 HTML 标签（例如 <br>），需要换行时直接使用换行符。
- 「核心用户旅程」部分不要使用 Markdown 表格；请按阶段分段输出，每个阶段用类似“阶段：用户目标/行为/情绪/机会点”这样的自然段或有序列表展开，保证阅读连贯。
- 如需表格（例如功能列表），只在必要的小节中使用标准 Markdown 表格（表头、分隔行、数据行），表格前后留空行。
- 不要将整段正文或表格放在代码块内。`;

export const GENERATE_MAIN_SYSTEM = `${PERSONA}
你的任务：根据用户需求、澄清回答和推理结论，一次性输出高质量、可执行的需求 Markdown 文档。

输出目标：
- 优先保证内容质量与可执行性（明确约束、流程、指标、边界）。
- 目标覆盖 9 个章节（按顺序）：
${NINE_SECTIONS}

写作要求：
- 每章提供 2-4 个关键点，避免空泛口号。
- 面向实际落地：给出可执行约束、关键流程、可观测指标。
- 不输出 HTML 标签，不输出代码块，不输出与文档无关说明。
- Markdown 结构清晰，标题层级稳定。`;

export function buildGenerateUser(requirement, reasoning, clarificationAnswers, scenario) {
  let block = `${buildScenarioBlock(scenario)}用户需求：\n${requirement}\n\n`;
  if (reasoning) block += `推理结论：\n${reasoning}\n\n`;
  if (clarificationAnswers?.length) {
    block += '澄清回答：\n';
    clarificationAnswers.forEach(({ q, a }) => {
      block += `- ${q}\n  ${a || '(未回答)'}\n`;
    });
    block += '\n';
  }
  block += '请直接输出完整 PRD 文档（仅文档内容，不要前后说明）：';
  return block;
}

export function buildGenerateMainUser(requirement, reasoning, clarificationAnswers, scenario) {
  let block = `${buildScenarioBlock(scenario)}用户需求：\n${requirement}\n\n`;
  if (reasoning) block += `推理结论：\n${reasoning}\n\n`;
  if (clarificationAnswers?.length) {
    block += '澄清回答：\n';
    clarificationAnswers.forEach(({ q, a }) => {
      block += `- ${q}\n  ${a || '(未回答)'}\n`;
    });
    block += '\n';
  }
  block += '请一次性输出高质量需求 Markdown（仅文档正文，不要解释）：';
  return block;
}

export const CONTINUE_SYSTEM = `${PERSONA}
你的任务：补写一份尚未完成的 PRD 文档后半部分。
要求：
- 保持与已有文档相同的标题层级、语言风格与 Markdown 格式。
- 不要从头重写，不要重复已有段落，只续写缺失部分。
- 如果已有文档已经写到某个小节中间，请从该位置自然续接。
- 必须补齐缺失的 9 部分内容，尤其是后续尚未完成的小节。
- 不要输出任何解释，只输出应补上的正文续写内容。`;

export const REFINE_SYSTEM = `${PERSONA}
你的任务：对现有需求 Markdown 做一次定向补强，仅处理“缺失章节”和“薄弱章节”。

硬约束：
- 仅补强指定章节，禁止全量重写。
- 禁止新增章节标题、禁止删除已有章节标题、禁止改动章节编号顺序。
- 每个目标章节补到“可执行”级别：至少 2 个关键点，避免空话。
- 输出完整 Markdown 文档（不是片段），仅输出文档正文。`;

export function buildContinueUser(
  requirement,
  partialDocument,
  reasoning,
  clarificationAnswers,
  scenario,
  missingSections = []
) {
  let block = `${buildScenarioBlock(scenario)}用户需求：\n${requirement}\n\n`;
  if (reasoning) block += `推理结论：\n${reasoning}\n\n`;
  if (clarificationAnswers?.length) {
    block += '澄清回答：\n';
    clarificationAnswers.forEach(({ q, a }) => {
      block += `- ${q}\n  ${a || '(未回答)'}\n`;
    });
    block += '\n';
  }
  if (missingSections.length > 0) {
    block += `当前缺失章节（必须全部补齐）：\n${missingSections.map((item) => `- ${item}`).join('\n')}\n\n`;
  }
  block += `当前已生成但疑似未完成的 PRD 文档：\n\n${partialDocument}\n\n`;
  block += '请仅补写缺失章节，不要重复已有章节，不要输出任何解释：';
  return block;
}

export function buildRefineUser(
  requirement,
  currentDocument,
  reasoning,
  clarificationAnswers,
  scenario,
  missingSections = [],
  weakSections = [],
  qualityWarnings = []
) {
  let block = `${buildScenarioBlock(scenario)}用户需求：\n${requirement}\n\n`;
  if (reasoning) block += `推理结论：\n${reasoning}\n\n`;
  if (clarificationAnswers?.length) {
    block += '澄清回答：\n';
    clarificationAnswers.forEach(({ q, a }) => {
      block += `- ${q}\n  ${a || '(未回答)'}\n`;
    });
    block += '\n';
  }
  if (missingSections.length > 0) {
    block += `缺失章节（优先补齐）：\n${missingSections.map((item) => `- ${item}`).join('\n')}\n\n`;
  }
  if (weakSections.length > 0) {
    block += `薄弱章节（需增强可执行细节）：\n${weakSections.map((item) => `- ${item}`).join('\n')}\n\n`;
  }
  if (qualityWarnings.length > 0) {
    block += `质量提示：\n${qualityWarnings.map((item) => `- ${item}`).join('\n')}\n\n`;
  }
  block += `当前文档：\n\n${currentDocument}\n\n`;
  block += '请按约束输出补强后的完整 Markdown 文档（仅正文，不要解释）：';
  return block;
}

// ---------- Phase3.1 结构锚点 ----------
export const STRUCTURE_ANCHOR_SYSTEM = `${PERSONA}
你的任务：先为 PRD 生成“结构锚点”和“术语表”，用于后续分段生成保持一致。

输出要求：
- 仅输出 JSON，不要 Markdown，不要代码块。
- JSON 结构固定为：
{"outline":[{"section":"章节名","intent":"本章节核心目标","mustInclude":["要点1","要点2"]}],"glossary":[{"term":"术语","definition":"定义","aliases":["别名1","别名2"]}]}
- outline 必须覆盖 9 个章节名称，章节名必须与下列名称完全一致：
产品定位、用户画像、核心用户旅程、功能列表、每个功能的详细说明、非功能需求、技术架构建议、AI 能力使用点、商业化路径
- glossary 保持 6-12 个关键术语，不要冗长。`;

export function buildStructureAnchorUser(requirement, reasoning, clarificationAnswers, scenario) {
  let block = `${buildScenarioBlock(scenario)}用户需求：\n${requirement}\n\n`;
  if (reasoning) block += `推理结论：\n${reasoning}\n\n`;
  if (clarificationAnswers?.length) {
    block += '澄清回答：\n';
    clarificationAnswers.forEach(({ q, a }) => {
      block += `- ${q}\n  ${a || '(未回答)'}\n`;
    });
    block += '\n';
  }
  block += '请输出结构锚点与术语表 JSON：';
  return block;
}

// ---------- Phase3.2 分段正文生成 ----------
export const SEGMENT_GENERATE_SYSTEM = `${PERSONA}
你的任务：基于固定结构锚点与术语表，按指定章节范围输出结构化章节 JSON。

硬约束：
- 仅输出 JSON，不要 Markdown、不要代码块、不要解释。
- JSON 结构固定为：
{"sections":[{"id":1,"title":"产品定位","content":"..."}]}
- 只允许输出本次指定的章节 id，禁止输出范围外 id。
- title 必须与章节白名单完全一致，禁止改名。
- content 必须是完整自然语言段落，不要半句收尾。

质量要求：
- 每章至少覆盖 2 个与本章相关的关键信息点（例如：目标用户/场景/痛点/流程/指标/约束/商业化）。
- 优先写“可执行信息”，避免空泛表述与口号化语言。
- 在不新增章节的前提下，保证内容具体、可落地。`;

export function buildSegmentGenerateUser(params) {
  const {
    requirement,
    scenario,
    reasoning,
    clarificationAnswers,
    existingDocument,
    segmentLabel,
    allowedSections,
    outline,
    glossary,
  } = params;
  let block = `${buildScenarioBlock(scenario)}用户需求：\n${requirement}\n\n`;
  if (reasoning) block += `推理结论：\n${reasoning}\n\n`;
  if (clarificationAnswers?.length) {
    block += '澄清回答：\n';
    clarificationAnswers.forEach(({ q, a }) => {
      block += `- ${q}\n  ${a || '(未回答)'}\n`;
    });
    block += '\n';
  }
  if (existingDocument) {
    block += `当前已完成文档（仅供上下文，不得重写）：\n\n${existingDocument}\n\n`;
  }
  block += `本次只允许生成章节：${segmentLabel}\n`;
  block += `允许章节（id 与 title 必须完全一致）：\n${allowedSections.map((s) => `- id=${s.id}, title=${s.title}${s.requirement ? `, 写作要求：${s.requirement}` : ''}`).join('\n')}\n\n`;
  if (Array.isArray(outline) && outline.length > 0) {
    block += `结构锚点（必须遵循）：\n${JSON.stringify(outline, null, 2)}\n\n`;
  }
  if (Array.isArray(glossary) && glossary.length > 0) {
    block += `术语表（必须统一）：\n${JSON.stringify(glossary, null, 2)}\n\n`;
  }
  block += '请仅输出本次指定章节的 JSON：';
  return block;
}

// ---------- Phase3.3 全文一致性修复 ----------
export const CONSISTENCY_REPAIR_SYSTEM = `${PERSONA}
你的任务：对已生成章节集合做统一性修复（仅改内容，不改结构）。

仅允许做以下修改：
- 术语统一
- 前后口径冲突修复
- 删除重复段落
- 在同一章节内补足缺失的关键细节（不改结构）

禁止：
- 新增产品范围
- 引入新功能模块
- 新增/删除章节
- 修改章节 id 或 title

输出要求：
- 仅输出 JSON，不要 Markdown、不要代码块、不要解释。
- JSON 结构固定为：
{"sections":[{"id":1,"title":"产品定位","content":"..."}]}
- 必须保留输入中的全部章节集合与标题，只允许更新 content。`;

export function buildConsistencyRepairUser(sectionState, outline = [], glossary = []) {
  let block = `当前章节状态（JSON）：\n${JSON.stringify(sectionState, null, 2)}\n\n`;
  if (Array.isArray(outline) && outline.length > 0) {
    block += `结构锚点：\n${JSON.stringify(outline, null, 2)}\n\n`;
  }
  if (Array.isArray(glossary) && glossary.length > 0) {
    block += `术语表：\n${JSON.stringify(glossary, null, 2)}\n\n`;
  }
  block += '请输出修复后的 sections JSON（仅改 content）：';
  return block;
}

// ---------- Phase4 按标注修订 ----------
const REVISE_COMMON_RULES = `通用规则：
- 不得输出 HTML 标签（例如 <br>），需要换行时直接使用换行符。
- 不得把表格或大段正文放在代码块或引号内；表格必须用标准 Markdown 表格（表头、分隔行、数据行），表格前后留空行。
- 「核心用户旅程」部分如需修改，应保持分段/列表形式，不要改回表格。
- 不得改变文档的 9 部分结构与标题层级。`;

export const REVISE_APPLY_SYSTEM = `${PERSONA}
你的任务：根据标注动作先做“局部应用”修订，并输出完整修订后文档。

动作语义（必须严格执行）：
- modify（replace_selected）：将选中文本替换为用户输入内容；可做最小必要补充，但禁止扩展新功能范围。
- delete（delete_selected）：删除选中文本，并仅做连贯性修复；禁止发散补充。
- supplement（insert_after_selected）：在选中文本后插入用户输入内容；可做最小必要润色，不得扩展新范围。

${REVISE_COMMON_RULES}
只输出完整文档内容，不要解释。`;

export const REVISE_CONSISTENCY_SYSTEM = `${PERSONA}
你的任务：在“局部应用”后的文档上做全局关联一致性联动更新，只更新语义相关位置，禁止无关重写。

联动范围（语义相关项）：
- 术语/命名、角色、流程、输入输出、指标口径、依赖关系、上下文引用。

约束：
- 保持“最小必要补充”原则，不新增产品范围或新功能模块。
- delete 标注触发的调整不得新增发散内容。
- 仅在确有必要时联动修改，并记录联动项。
- 输出必须是 JSON 对象，不要 Markdown，不要代码块：
{"finalDocument":"完整文档字符串","linkedUpdates":[{"section":"章节名","summary":"改了什么","reason":"为什么改"}]}

${REVISE_COMMON_RULES}`;

function buildRevisionAnnotationBlock(annotations) {
  let block = '标注列表：\n';
  annotations.forEach((a, i) => {
    block += `${i + 1}. 类型：${a.type}`;
    if (a.anchorPolicy) block += `；锚点策略：${a.anchorPolicy}`;
    block += `；原文：「${(a.quote || '').replace(/\n/g, ' ')}」`;
    if (a.content) block += `；用户输入：${a.content}`;
    if (a.note) block += `；备注：${a.note}`;
    block += '\n';
  });
  return block;
}

export function buildReviseApplyUser(document, annotations) {
  let block = `当前 PRD 文档：\n\n${document}\n\n---\n`;
  block += buildRevisionAnnotationBlock(annotations);
  block += '\n请执行动作语义并输出完整修订文档：';
  return block;
}

export function buildReviseConsistencyUser(document, annotations, affectedSections = []) {
  let block = `当前 PRD 文档：\n\n${document}\n\n---\n标注列表：\n`;
  block = `当前“局部应用后”PRD 文档：\n\n${document}\n\n---\n`;
  if (affectedSections.length > 0) {
    block += `本次允许联动的受影响章节（仅可在这些章节内修改）：\n${affectedSections.map((item) => `- ${item}`).join('\n')}\n\n`;
  }
  block += buildRevisionAnnotationBlock(annotations);
  block += '\n请输出 JSON（finalDocument + linkedUpdates）：';
  return block;
}
