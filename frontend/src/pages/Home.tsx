import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  getClarificationQuestions,
  generateDocument,
  getGenerateJobStatus,
  retryGenerateJobStage,
} from '../services/api';

const FALLBACK_QUESTIONS = [
  '目标用户主要是谁？有哪些典型使用场景？',
  '首期必须上线的核心功能有哪些？优先级如何？',
  '是否有现成系统、接口或数据需要对接？',
  '预期上线时间或重要里程碑（如 MVP 范围）？',
  '技术栈、预算或资源有无限制？是否有商业化/变现考虑？',
];

const HOME_FEATURES = [
  '先澄清再生成，减少 AI Coding IDE 中反复重写',
  '支持按标注修订与全篇修复，持续迭代 Markdown 需求',
  '导出 .md 后可直接回到 AI Coding IDE 继续开发',
];

const WORKFLOW_STEPS = [
  {
    title: '输入一句话需求',
    eta: '约 10-30 秒',
    desc: '描述产品方向、目标用户或核心功能。',
  },
  {
    title: '澄清问题与补充',
    eta: '约 30-90 秒（可跳过）',
    desc: '系统追问关键边界，帮助明确需求范围。',
  },
  {
    title: '生成需求 Markdown 初稿',
    eta: '约 2-8 分钟',
    desc: '按结构产出可编辑的需求 md，并自动补齐缺失章节。',
  },
  {
    title: '标注修订与联动',
    eta: '约 30-180 秒',
    desc: '你可继续修改、删除、补充，系统进行关联优化。',
  },
] as const;

const SCENARIOS = [
  '通用产品',
  'AI 游戏',
  'AI 社交',
  'AI 网站',
  'AI 后台应用',
  'AI 笔记应用',
  'AI 教育产品',
  'AI 电商产品',
  'AI 内容平台',
  'AI 数据分析',
  'AI 客服系统',
  'AI 招聘系统',
];

interface HomeProps {
  onGenerate: (userRequirement: string, document: string) => void;
}

type Step = 'input' | 'clarify' | 'generating';
type GenerateOutputLevel = 'draft' | 'partial' | 'final';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const HOME_STORAGE_KEY = 'requirement-website.home-state.v1';
const LOW_REMAINING_THRESHOLD_MS = 30000;
const POLL_INTERVAL_MS = 2500;
const POLL_INTERVAL_QUEUED_MS = 3500;
const GENERATE_MAX_WAIT_MS = Math.max(Number(import.meta.env.VITE_GENERATE_MAX_WAIT_MS) || 540000, 60000);
const ZERO_BUDGET_GRACE_MS = 30000;
const HOME_STATE_TTL_MS = Math.max(Number(import.meta.env.VITE_HOME_STATE_TTL_MS) || 20 * 60 * 1000, 60 * 1000);

function stageLabel(stage: string | undefined) {
  switch (stage) {
    case 'running_generate_main': return '主生成';
    case 'completed_final': return '最终完成';
    case 'completed_partial': return '可用初稿';
    case 'failed_fatal': return '任务失败';
    case 'queued': return '排队中';
    default: return '处理中';
  }
}

function formatMs(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return '0秒';
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min <= 0) return `${rem}秒`;
  return `${min}分${rem}秒`;
}

function getPollDelay(status: string | undefined) {
  if (status === 'queued') return POLL_INTERVAL_QUEUED_MS;
  return POLL_INTERVAL_MS;
}

interface PersistedHomeState {
  savedAt?: number;
  input: string;
  step: Step;
  questions: string[];
  answers: Record<number, string>;
  scenario: string;
  generateProgress: number;
  generateStepText: string;
  activeJobId: string;
  generateStage: string;
  generateLifecycle: string;
  outputLevel: GenerateOutputLevel;
  draftDocument: string;
  stageProgress: number;
  overallProgress: number;
  lastError: string;
  stageAttempt: number;
  stageMaxAttempts: number;
  generateRemainingMs: number;
  generateElapsedMs: number;
  fallbackAttempts: number;
  missingSections: string[];
  missingSectionIds: number[];
  invalidSectionIds: number[];
  weakSectionIds: number[];
  completionScore: number;
  qualityWarnings: string[];
}

function readHomeState(): PersistedHomeState {
  if (typeof window === 'undefined') {
    return {
      input: '',
      step: 'input',
      questions: [],
      answers: {},
      scenario: '通用产品',
      generateProgress: 0,
      generateStepText: '准备提交任务',
      activeJobId: '',
      generateStage: 'queued',
      generateLifecycle: 'queued',
      outputLevel: 'draft',
      draftDocument: '',
      stageProgress: 0,
      overallProgress: 0,
      lastError: '',
      stageAttempt: 0,
      stageMaxAttempts: 0,
      generateRemainingMs: 0,
      generateElapsedMs: 0,
      fallbackAttempts: 0,
      missingSections: [],
      missingSectionIds: [],
      invalidSectionIds: [],
      weakSectionIds: [],
      completionScore: 0,
      qualityWarnings: [],
    };
  }

  try {
    const raw = window.localStorage.getItem(HOME_STORAGE_KEY);
    if (!raw) {
      return {
        input: '',
        step: 'input',
        questions: [],
        answers: {},
        scenario: '通用产品',
        generateProgress: 0,
        generateStepText: '准备提交任务',
        activeJobId: '',
        generateStage: 'queued',
        generateLifecycle: 'queued',
        outputLevel: 'draft',
        draftDocument: '',
        stageProgress: 0,
        overallProgress: 0,
        lastError: '',
        stageAttempt: 0,
        stageMaxAttempts: 0,
        generateRemainingMs: 0,
        generateElapsedMs: 0,
        fallbackAttempts: 0,
        missingSections: [],
        missingSectionIds: [],
        invalidSectionIds: [],
        weakSectionIds: [],
        completionScore: 0,
        qualityWarnings: [],
      };
    }

    const parsed = JSON.parse(raw) as Partial<PersistedHomeState>;
    const isExpired = typeof parsed.savedAt === 'number' && Date.now() - parsed.savedAt > HOME_STATE_TTL_MS;
    const shouldResetGenerating =
      parsed.step === 'generating'
      && (
        isExpired
        || typeof parsed.activeJobId !== 'string'
        || !parsed.activeJobId.trim()
      );

    return {
      input: typeof parsed.input === 'string' ? parsed.input : '',
      step:
        shouldResetGenerating
          ? 'input'
          : parsed.step === 'clarify' || parsed.step === 'generating'
          ? parsed.step
          : 'input',
      questions: Array.isArray(parsed.questions)
        ? parsed.questions.filter((item): item is string => typeof item === 'string').slice(0, 5)
        : [],
      answers:
        parsed.answers && typeof parsed.answers === 'object'
          ? Object.fromEntries(
              Object.entries(parsed.answers).filter(
                ([key, value]) => /^\d+$/.test(key) && typeof value === 'string'
              )
            )
          : {},
      scenario:
        typeof parsed.scenario === 'string' && parsed.scenario.trim()
          ? parsed.scenario
          : '通用产品',
      generateProgress:
        typeof parsed.generateProgress === 'number' ? parsed.generateProgress : 0,
      generateStepText:
        typeof parsed.generateStepText === 'string' && parsed.generateStepText.trim()
          ? parsed.generateStepText
          : '准备提交任务',
      activeJobId: shouldResetGenerating ? '' : (typeof parsed.activeJobId === 'string' ? parsed.activeJobId : ''),
      generateStage: shouldResetGenerating ? 'queued' : (typeof parsed.generateStage === 'string' ? parsed.generateStage : 'queued'),
      generateLifecycle: shouldResetGenerating ? 'queued' : (typeof parsed.generateLifecycle === 'string' ? parsed.generateLifecycle : 'queued'),
      outputLevel:
        parsed.outputLevel === 'partial' || parsed.outputLevel === 'final'
          ? parsed.outputLevel
          : 'draft',
      draftDocument: shouldResetGenerating ? '' : (typeof parsed.draftDocument === 'string' ? parsed.draftDocument : ''),
      stageProgress: shouldResetGenerating ? 0 : (typeof parsed.stageProgress === 'number' ? parsed.stageProgress : 0),
      overallProgress: shouldResetGenerating ? 0 : (typeof parsed.overallProgress === 'number' ? parsed.overallProgress : 0),
      lastError: shouldResetGenerating ? '' : (typeof parsed.lastError === 'string' ? parsed.lastError : ''),
      stageAttempt: shouldResetGenerating ? 0 : (typeof parsed.stageAttempt === 'number' ? parsed.stageAttempt : 0),
      stageMaxAttempts: shouldResetGenerating ? 0 : (typeof parsed.stageMaxAttempts === 'number' ? parsed.stageMaxAttempts : 0),
      generateRemainingMs:
        shouldResetGenerating ? 0 : (typeof parsed.generateRemainingMs === 'number' ? parsed.generateRemainingMs : 0),
      generateElapsedMs:
        shouldResetGenerating ? 0 : (typeof parsed.generateElapsedMs === 'number' ? parsed.generateElapsedMs : 0),
      fallbackAttempts:
        shouldResetGenerating ? 0 : (typeof parsed.fallbackAttempts === 'number' ? parsed.fallbackAttempts : 0),
      missingSections: shouldResetGenerating
        ? []
        : Array.isArray(parsed.missingSections)
        ? parsed.missingSections.filter((item): item is string => typeof item === 'string')
        : [],
      missingSectionIds: shouldResetGenerating
        ? []
        : Array.isArray(parsed.missingSectionIds)
        ? parsed.missingSectionIds.filter((item): item is number => typeof item === 'number')
        : [],
      invalidSectionIds: shouldResetGenerating
        ? []
        : Array.isArray(parsed.invalidSectionIds)
        ? parsed.invalidSectionIds.filter((item): item is number => typeof item === 'number')
        : [],
      weakSectionIds: shouldResetGenerating
        ? []
        : Array.isArray(parsed.weakSectionIds)
        ? parsed.weakSectionIds.filter((item): item is number => typeof item === 'number')
        : [],
      completionScore:
        shouldResetGenerating ? 0 : (typeof parsed.completionScore === 'number' ? parsed.completionScore : 0),
      qualityWarnings: shouldResetGenerating
        ? []
        : Array.isArray(parsed.qualityWarnings)
        ? parsed.qualityWarnings.filter((item): item is string => typeof item === 'string')
        : [],
    };
  } catch {
    return {
      input: '',
      step: 'input',
      questions: [],
      answers: {},
      scenario: '通用产品',
      generateProgress: 0,
      generateStepText: '准备提交任务',
      activeJobId: '',
      generateStage: 'queued',
      generateLifecycle: 'queued',
      outputLevel: 'draft',
      draftDocument: '',
      stageProgress: 0,
      overallProgress: 0,
      lastError: '',
      stageAttempt: 0,
      stageMaxAttempts: 0,
      generateRemainingMs: 0,
      generateElapsedMs: 0,
      fallbackAttempts: 0,
      missingSections: [],
      missingSectionIds: [],
      invalidSectionIds: [],
      weakSectionIds: [],
      completionScore: 0,
      qualityWarnings: [],
    };
  }
}

export function Home({ onGenerate }: HomeProps) {
  const initialState = readHomeState();
  const pollingJobRef = useRef('');
  const [input, setInput] = useState(initialState.input);
  const [step, setStep] = useState<Step>(initialState.step);
  const [questions, setQuestions] = useState<string[]>(initialState.questions);
  const [answers, setAnswers] = useState<Record<number, string>>(initialState.answers);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [scenario, setScenario] = useState(initialState.scenario);
  const [generateProgress, setGenerateProgress] = useState(initialState.generateProgress);
  const [generateStepText, setGenerateStepText] = useState(initialState.generateStepText);
  const [activeJobId, setActiveJobId] = useState(initialState.activeJobId);
  const [generateStage, setGenerateStage] = useState(initialState.generateStage);
  const [generateLifecycle, setGenerateLifecycle] = useState(initialState.generateLifecycle);
  const [outputLevel, setOutputLevel] = useState<GenerateOutputLevel>(initialState.outputLevel);
  const [draftDocument, setDraftDocument] = useState(initialState.draftDocument);
  const [stageProgress, setStageProgress] = useState(initialState.stageProgress);
  const [overallProgress, setOverallProgress] = useState(initialState.overallProgress);
  const [lastError, setLastError] = useState(initialState.lastError);
  const [stageAttempt, setStageAttempt] = useState(initialState.stageAttempt);
  const [stageMaxAttempts, setStageMaxAttempts] = useState(initialState.stageMaxAttempts);
  const [generateRemainingMs, setGenerateRemainingMs] = useState(initialState.generateRemainingMs);
  const [displayRemainingMs, setDisplayRemainingMs] = useState(initialState.generateRemainingMs);
  const [generateElapsedMs, setGenerateElapsedMs] = useState(initialState.generateElapsedMs);
  const [fallbackAttempts, setFallbackAttempts] = useState(initialState.fallbackAttempts);
  const [missingSections, setMissingSections] = useState<string[]>(initialState.missingSections);
  const [missingSectionIds, setMissingSectionIds] = useState<number[]>(initialState.missingSectionIds);
  const [invalidSectionIds, setInvalidSectionIds] = useState<number[]>(initialState.invalidSectionIds);
  const [weakSectionIds, setWeakSectionIds] = useState<number[]>(initialState.weakSectionIds);
  const [completionScore, setCompletionScore] = useState(initialState.completionScore);
  const [qualityWarnings, setQualityWarnings] = useState<string[]>(initialState.qualityWarnings);
  const requirement = input.trim();

  useEffect(() => {
    setDisplayRemainingMs(generateRemainingMs);
  }, [generateRemainingMs]);

  useEffect(() => {
    if (step !== 'generating') return;
    if (displayRemainingMs <= 0) return;
    const timer = window.setInterval(() => {
      setDisplayRemainingMs((prev) => Math.max(prev - 1000, 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [step, displayRemainingMs]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    window.localStorage.setItem(
      HOME_STORAGE_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        input,
        step,
        questions,
        answers,
        scenario,
        generateProgress,
        generateStepText,
        activeJobId,
        generateStage,
        generateLifecycle,
        outputLevel,
        draftDocument,
        stageProgress,
        overallProgress,
        lastError,
        stageAttempt,
        stageMaxAttempts,
        generateRemainingMs,
        generateElapsedMs,
        fallbackAttempts,
        missingSections,
        missingSectionIds,
        invalidSectionIds,
        weakSectionIds,
        completionScore,
        qualityWarnings,
      })
    );
  }, [
    input,
    step,
    questions,
    answers,
    scenario,
    generateProgress,
    generateStepText,
    activeJobId,
    generateStage,
    generateLifecycle,
    outputLevel,
    draftDocument,
    stageProgress,
    overallProgress,
    lastError,
    stageAttempt,
    stageMaxAttempts,
    generateRemainingMs,
    generateElapsedMs,
    fallbackAttempts,
    missingSections,
    missingSectionIds,
    invalidSectionIds,
    weakSectionIds,
    completionScore,
    qualityWarnings,
  ]);

  const resetGeneratingState = () => {
    pollingJobRef.current = '';
    setActiveJobId('');
    setGenerateProgress(0);
    setGenerateStepText('准备提交任务');
    setGenerateStage('queued');
    setGenerateLifecycle('queued');
    setOutputLevel('draft');
    setDraftDocument('');
    setStageProgress(0);
    setOverallProgress(0);
    setLastError('');
    setStageAttempt(0);
    setStageMaxAttempts(0);
    setGenerateRemainingMs(0);
    setGenerateElapsedMs(0);
    setFallbackAttempts(0);
    setMissingSections([]);
    setMissingSectionIds([]);
    setInvalidSectionIds([]);
    setWeakSectionIds([]);
    setCompletionScore(0);
    setQualityWarnings([]);
    setLoading(false);
  };

  const handleGenerationSuccess = (doc: string) => {
    pollingJobRef.current = '';
    setActiveJobId('');
    setGenerateProgress(100);
    setGenerateStepText('生成完成');
    setGenerateStage('completed_final');
    setGenerateLifecycle('completed_final');
    setOutputLevel('final');
    setDraftDocument(doc.trim());
    setStageProgress(100);
    setOverallProgress(100);
    setGenerateRemainingMs(0);
    setCompletionScore(100);
    setMissingSectionIds([]);
    setInvalidSectionIds([]);
    setWeakSectionIds([]);
    setQualityWarnings([]);
    setLoading(false);
    setStep('input');
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(HOME_STORAGE_KEY);
    }
    onGenerate(requirement, doc.trim());
  };

  const pollGenerateJob = async (jobId: string) => {
    pollingJobRef.current = jobId;
    setActiveJobId(jobId);
    setLoading(true);
    const startedAt = Date.now();
    let zeroBudgetSince = 0;
    let latestDoc = '';

    while (Date.now() - startedAt <= GENERATE_MAX_WAIT_MS) {
      const statusRes = await getGenerateJobStatus(jobId);

      if (pollingJobRef.current !== jobId) {
        return;
      }

      const progress = Math.min(Math.max(statusRes.progress ?? 10, 10), 100);
      setGenerateProgress(progress);
      setGenerateStage(statusRes.stage || 'running_generate_main');
      setGenerateLifecycle(statusRes.lifecycle || 'queued');
      setOutputLevel(statusRes.outputLevel === 'final' || statusRes.outputLevel === 'partial' ? statusRes.outputLevel : 'draft');
      setDraftDocument(typeof statusRes.document === 'string' ? statusRes.document : '');
      latestDoc = typeof statusRes.document === 'string' ? statusRes.document : latestDoc;
      setStageProgress(statusRes.stageProgress ?? 0);
      setOverallProgress(statusRes.overallProgress ?? progress);
      setLastError(statusRes.lastError ?? '');
      setStageAttempt(statusRes.attempt ?? 0);
      setStageMaxAttempts(statusRes.maxAttempts ?? 0);
      setGenerateElapsedMs(statusRes.elapsedMs ?? 0);
      setGenerateRemainingMs(statusRes.remainingMs ?? 0);
      setFallbackAttempts(statusRes.fallbackAttempts ?? 0);
      setMissingSections(statusRes.missingSections ?? []);
      setMissingSectionIds(statusRes.missingSectionIds ?? []);
      setWeakSectionIds(statusRes.weakSectionIds ?? statusRes.invalidSectionIds ?? []);
      setInvalidSectionIds(statusRes.invalidSectionIds ?? []);
      setCompletionScore(statusRes.completionScore ?? 0);
      setQualityWarnings(statusRes.qualityWarnings ?? []);
      if (statusRes.queuePosition && statusRes.status === 'queued') {
        setGenerateStepText(`队列中，前方还有 ${statusRes.queuePosition - 1} 个任务`);
      } else {
        setGenerateStepText(statusRes.step || '正在生成');
      }

      if (statusRes.status === 'completed') {
        const doc = statusRes.document;
        const resolvedDoc =
          (typeof doc === 'string' && doc.trim())
            ? doc.trim()
            : latestDoc.trim();
        if (resolvedDoc) {
          handleGenerationSuccess(resolvedDoc);
          return;
        }
        setLoading(false);
        setGenerateStepText('已返回可用初稿，可先进入编辑');
        return;
      }

      if (statusRes.status === 'failed') {
        const hasDraft = typeof statusRes.document === 'string' && statusRes.document.trim().length > 0;
        if (hasDraft) {
          setGenerateStepText(statusRes.message || '当前阶段失败，已保留可用初稿');
          setLoading(false);
          return;
        }
        throw new Error(statusRes.message || '生成失败');
      }

      const remainingMs = statusRes.remainingMs ?? 0;
      if (statusRes.status === 'queued' && remainingMs <= 0) {
        throw new Error('历史任务已过期，请重新发起生成');
      }
      if (remainingMs <= 0 && statusRes.status === 'running') {
        if (!zeroBudgetSince) {
          zeroBudgetSince = Date.now();
        } else if (Date.now() - zeroBudgetSince > ZERO_BUDGET_GRACE_MS) {
          throw new Error('生成预算已耗尽，请缩小需求范围后重试');
        }
      } else {
        zeroBudgetSince = 0;
      }

      await sleep(getPollDelay(statusRes.status));
    }

    if (latestDoc.trim()) {
      setGenerateStepText('超时：已保留可用初稿，你可先进入编辑');
      setLoading(false);
      return;
    }
    throw new Error(`生成超时（>${Math.floor(GENERATE_MAX_WAIT_MS / 60000)} 分钟），请缩小需求范围或稍后重试`);
  };

  const handleGetQuestions = async () => {
    if (!requirement) {
      setError('请输入一句话需求');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const res = await getClarificationQuestions(requirement, scenario);
      const validApiQuestions =
        Array.isArray(res.questions)
          ? res.questions
              .map((q) => (typeof q === 'string' ? q.trim() : ''))
              .filter((q) => q.length > 0)
          : [];
      const mergedQuestions = [...validApiQuestions];
      for (const fallback of FALLBACK_QUESTIONS) {
        if (mergedQuestions.length >= 5) break;
        if (!mergedQuestions.includes(fallback)) {
          mergedQuestions.push(fallback);
        }
      }
      setQuestions(mergedQuestions.slice(0, 5));
      setAnswers({});
      setStep('clarify');
      if (!res.success) {
        setError(res.message || '未获取到澄清问题，将使用默认问题');
      }
    } catch (e) {
      setQuestions(FALLBACK_QUESTIONS);
      setAnswers({});
      setStep('clarify');
      const msg = e instanceof Error ? e.message : '请求失败，将使用默认问题';
      if (e instanceof ApiError && e.status === 401) {
        setError('澄清问题服务暂时不可用，已切换默认问题。');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async (skipClarify: boolean) => {
    if (!requirement) return;
    setError('');
    setLoading(true);
    setGenerateProgress(5);
    setGenerateStepText('提交生成任务');
    setStep('generating');
    try {
      const clarificationAnswers =
        skipClarify || questions.length === 0
          ? undefined
          : questions.map((q, i) => ({ q, a: answers[i] ?? '' }));

      const createRes = await generateDocument(requirement, clarificationAnswers, scenario);
      const jobId = createRes.jobId;
      if (!createRes.success || !jobId) {
        throw new Error(createRes.message || '任务创建失败，请重试');
      }

      setGenerateProgress(Math.max(createRes.progress ?? 10, 10));
      setGenerateStepText(createRes.step || '任务已创建');
      setGenerateStage(createRes.stage || 'queued');
      setGenerateLifecycle(createRes.lifecycle || 'queued');
      setOutputLevel(createRes.outputLevel === 'final' || createRes.outputLevel === 'partial' ? createRes.outputLevel : 'draft');
      setDraftDocument(typeof createRes.document === 'string' ? createRes.document : '');
      setStageProgress(createRes.stageProgress ?? 0);
      setOverallProgress(createRes.overallProgress ?? createRes.progress ?? 10);
      setLastError(createRes.lastError ?? '');
      setStageAttempt(createRes.attempt ?? 0);
      setStageMaxAttempts(createRes.maxAttempts ?? 0);
      setGenerateElapsedMs(createRes.elapsedMs ?? 0);
      setGenerateRemainingMs(createRes.remainingMs ?? 0);
      setFallbackAttempts(createRes.fallbackAttempts ?? 0);
      setMissingSections([]);
      setMissingSectionIds([]);
      setWeakSectionIds([]);
      setInvalidSectionIds([]);
      setCompletionScore(0);
      setQualityWarnings([]);
      await pollGenerateJob(jobId);
    } catch (e) {
      if (
        (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 404))
        || (e instanceof Error && e.message.includes('历史任务已过期'))
      ) {
        resetGeneratingState();
        setStep('input');
        setError('当前任务会话已失效，请重新点击生成。');
      } else {
        setError(e instanceof Error ? e.message : '请求失败');
      }
      pollingJobRef.current = '';
      setActiveJobId('');
    } finally {
      setLoading(false);
    }
  };

  const backToInput = () => {
    resetGeneratingState();
    setStep('input');
    setQuestions([]);
    setAnswers({});
    setError('');
  };

  useEffect(() => {
    if (step !== 'generating' || !activeJobId || !requirement) return;
    if (pollingJobRef.current === activeJobId) return;

    let cancelled = false;

    const resume = async () => {
      try {
        setError('');
        await pollGenerateJob(activeJobId);
      } catch (e) {
        if (cancelled) return;
        if (
          (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 404))
          || (e instanceof Error && e.message.includes('历史任务已过期'))
        ) {
          resetGeneratingState();
          setStep('input');
          setError('历史任务已失效，请重新发起生成。');
          return;
        }
        setError(e instanceof Error ? e.message : '恢复生成状态失败');
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    resume();

    return () => {
      cancelled = true;
    };
  }, [step, activeJobId, requirement]);

  if (step === 'clarify') {
    return (
      <div className="home-shell home-shell-centered">
        <div className="home-card flow-card">
          <div className="home-flow-top">
            <div>
              <span className="home-badge">Step 2</span>
              <h1 className="home-title small">补齐关键信息</h1>
              <p className="home-subtitle">
                回答越完整，生成的需求 Markdown 越接近可直接进入 AI Coding IDE 开发的版本。
              </p>
            </div>
            <button className="btn-secondary" onClick={backToInput} disabled={loading}>
              返回修改需求
            </button>
          </div>

          <div className="requirement-preview">
            <span className="requirement-preview-label">当前需求</span>
            <p>{requirement}</p>
          </div>

          <div className="question-list">
            {questions.map((q, i) => (
              <div key={i} className="question-card">
                <label className="question-label">
                  <span className="question-index">Q{i + 1}</span>
                  <span>{q}</span>
                </label>
                <textarea
                  className="input-area input-area-compact"
                  placeholder="您的回答（可留空）"
                  value={answers[i] ?? ''}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [i]: e.target.value }))}
                  disabled={loading}
                  rows={3}
                />
              </div>
            ))}
          </div>

          {error && <p className="error-text">{error}</p>}

          <div className="action-row">
            <button className="btn-primary" onClick={() => handleGenerate(false)} disabled={loading}>
              {loading ? '生成中…' : '根据回答生成需求 Markdown'}
            </button>
            <button className="btn-secondary" onClick={() => handleGenerate(true)} disabled={loading}>
              跳过，直接生成
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (step === 'generating') {
    return (
      <div className="home-shell home-shell-centered">
        <div className="home-card generating-card">
          {!error ? (
            <>
              <span className="home-badge">Step 3</span>
              <div className="generating-spinner" />
              <h1 className="home-title small">正在生成需求 Markdown</h1>
              <p className="home-subtitle">
                {generateStepText}
              </p>
              <p style={{ color: '#95a9c8', marginTop: 8, fontSize: 14 }}>
                阶段：{stageLabel(generateStage)} · 步骤进度：{stageProgress}% · 剩余预算：{formatMs(displayRemainingMs)}
              </p>
              {displayRemainingMs > 0 && displayRemainingMs <= LOW_REMAINING_THRESHOLD_MS && (
                <p style={{ color: '#ffd166', marginTop: 8, fontSize: 14 }}>
                  即将超时，正在收敛输出，请稍候。
                </p>
              )}
              <div style={{ width: '100%', maxWidth: 420, marginTop: 16 }}>
                <div style={{ color: '#95a9c8', fontSize: 14, marginBottom: 8 }}>进度：{generateProgress}%</div>
                <div style={{ height: 8, borderRadius: 999, background: 'rgba(255,255,255,0.12)' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${generateProgress}%`,
                      borderRadius: 999,
                      background: 'linear-gradient(90deg, #4ec6ff, #7fddff)',
                      transition: 'width 220ms ease',
                    }}
                  />
                </div>
              </div>
              {draftDocument.trim() && (
                <div style={{ width: '100%', maxWidth: 760, marginTop: 18, textAlign: 'left' }}>
                  <div style={{ color: '#95a9c8', fontSize: 13, marginBottom: 8 }}>
                    当前可用文档预览（{outputLevel === 'final' ? '最终稿' : outputLevel === 'partial' ? '可用稿' : '初稿'}）
                  </div>
                  <div
                    style={{
                      maxHeight: 220,
                      overflow: 'auto',
                      border: '1px solid rgba(146,170,203,0.2)',
                      borderRadius: 10,
                      padding: 12,
                      background: 'rgba(0,0,0,0.2)',
                      color: '#dce8fb',
                      whiteSpace: 'pre-wrap',
                      fontSize: 13,
                      lineHeight: 1.6,
                    }}
                  >
                    {draftDocument}
                  </div>
                </div>
              )}
              <div className="action-row centered" style={{ width: '100%', maxWidth: 420, marginTop: 16 }}>
                {draftDocument.trim() && (
                  <button
                    className="btn-primary"
                    onClick={() => onGenerate(requirement, draftDocument)}
                  >
                    进入编辑
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <span className="home-badge danger">生成失败</span>
              <h1 className="home-title small">这次没有顺利生成文档</h1>
              <p className="home-subtitle">{error}</p>
              <details style={{ marginTop: 14, width: '100%', maxWidth: 560, textAlign: 'left', color: '#95a9c8' }}>
                <summary style={{ cursor: 'pointer' }}>查看失败原因详情</summary>
                <p style={{ marginTop: 10 }}>阶段：{stageLabel(generateStage)}</p>
                <p>已耗时：{formatMs(generateElapsedMs)}；剩余预算：{formatMs(displayRemainingMs)}</p>
                <p>阶段重试：{stageAttempt}/{stageMaxAttempts}</p>
                <p>模型回退次数：{fallbackAttempts}</p>
                <p>完成度评分：{completionScore}</p>
                {lastError && <p>最近错误：{lastError}</p>}
                {missingSections.length > 0 && (
                  <p>缺失章节：{missingSections.join('、')}</p>
                )}
                {missingSectionIds.length > 0 && (
                  <p>缺失章节ID：{missingSectionIds.join(', ')}</p>
                )}
                {weakSectionIds.length > 0 && (
                  <p>薄弱章节ID：{weakSectionIds.join(', ')}</p>
                )}
                {qualityWarnings.length > 0 && (
                  <p>质量提示：{qualityWarnings.join('；')}</p>
                )}
              </details>
              <div className="action-row centered">
                <button
                  className="btn-primary"
                  onClick={async () => {
                    try {
                      if (!activeJobId) return;
                      setError('');
                      await retryGenerateJobStage(activeJobId);
                      setLoading(true);
                      await pollGenerateJob(activeJobId);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : '重试阶段失败');
                    }
                  }}
                  disabled={!activeJobId || loading}
                >
                  {loading ? '重试中…' : '重试当前阶段'}
                </button>
                {draftDocument.trim() && (
                  <button
                    className="btn-secondary"
                    onClick={() => onGenerate(requirement, draftDocument)}
                  >
                    进入编辑
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="home-shell">
      <div className="home-hero">
        <div className="home-copy">
          <span className="home-badge">AI Requirement Studio</span>
          <h1 className="home-title">把一句模糊想法，变成可持续修订的需求 Markdown。</h1>
          <p className="home-subtitle">
            面向 AI Coding IDE：从一句想法出发，快速得到可编辑初稿，并在同一页面持续修订。
          </p>

          <div className="feature-list">
            {HOME_FEATURES.map((item) => (
              <div key={item} className="feature-chip">
                {item}
              </div>
            ))}
          </div>
          <div className="home-info-grid">
            <article className="home-info-card">
              <h3>解决的痛点</h3>
              <p>AI Coding IDE 一次生成的需求 md 往往难以持续修改。这里把“澄清、生成、标注修订、全篇修复”放进同一流程，减少整篇重写。</p>
            </article>
            <article className="home-info-card">
              <h3>如何使用</h3>
              <p>输入一句想法 → 回答澄清问题 → 生成初稿 → 按标注修订/全篇修复 → 导出 Markdown 继续开发。</p>
            </article>
          </div>
          {activeJobId && (
            <div style={{ marginTop: 18, padding: '12px 14px', border: '1px solid rgba(146,170,203,0.2)', borderRadius: 12, background: 'rgba(9,17,28,0.45)' }}>
              <p style={{ color: '#95a9c8', margin: 0 }}>
                检测到未完成任务：{stageLabel(generateStage)}（{outputLevel === 'final' ? '最终稿' : outputLevel === 'partial' ? '可用稿' : '初稿'}）
              </p>
              <div className="action-row" style={{ marginTop: 10 }}>
                <button
                  className="btn-secondary"
                  onClick={async () => {
                    try {
                      setStep('generating');
                      setError('');
                      await pollGenerateJob(activeJobId);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : '恢复任务失败');
                    }
                  }}
                >
                  继续任务
                </button>
                {draftDocument.trim() && (
                  <button
                    className="btn-secondary"
                    onClick={() => onGenerate(requirement, draftDocument)}
                  >
                    先进入文档编辑
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="home-card home-entry-card">
          <div className="card-topline">
            <span className="card-kicker">开始生成需求 Markdown</span>
            <span className="card-meta">约 3-8 分钟可得到可编辑初稿</span>
          </div>

          <div className="scenario-row">
            <label className="scenario-label" htmlFor="scenario-select">
              功能场景
            </label>
            <select
              id="scenario-select"
              className="scenario-select"
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
              disabled={loading}
            >
              {SCENARIOS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>

          <textarea
            className="input-area input-area-hero"
            placeholder="例如：做一个支持多人在线编辑的待办应用，支持任务拆分、评论、提醒和团队协作"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
          />

          {error && <p className="error-text">{error}</p>}

          <div className="action-row">
            <button
              className="btn-primary home-entry-cta"
              onClick={handleGetQuestions}
              disabled={loading}
            >
              {loading ? '获取中…' : '下一步：获取澄清问题'}
            </button>
          </div>
          <p className="home-entry-hint">主入口：输入想法后直接进入澄清与生成流程</p>
        </div>
      </div>

      <section className="workflow-card" aria-label="工作流程与预计耗时">
        <div className="workflow-head">
          <span className="card-kicker">流程与预期时间</span>
          <span className="card-meta">首次完整产出通常 3-10 分钟</span>
        </div>
        <div className="workflow-timeline">
          {WORKFLOW_STEPS.map((step, idx) => (
            <article key={step.title} className="workflow-step">
              <div className="workflow-step-index">{idx + 1}</div>
              <div className="workflow-step-time">{step.eta}</div>
              <h3 className="workflow-step-title">{step.title}</h3>
            </article>
          ))}
        </div>
        <details className="workflow-details">
          <summary>查看每一步说明</summary>
          <div className="workflow-detail-list">
            {WORKFLOW_STEPS.map((step, idx) => (
              <p key={`${step.title}-${idx}`} className="workflow-step-desc">
                <strong>{idx + 1}. {step.title}：</strong>{step.desc}
              </p>
            ))}
          </div>
        </details>
        <p className="workflow-note">
          以上为预估时间区间（非 SLA），实际耗时会随内容复杂度、并发和网络状态变化。
        </p>
      </section>
    </div>
  );
}
