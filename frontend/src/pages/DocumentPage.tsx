import { useState, useCallback, useEffect, useRef } from 'react';
import {
  ApiError,
  createReviseRepairJob,
  createSubscriptionCheckout,
  deleteDocumentById,
  exportDocument,
  listDocuments,
  saveDocument,
  getUsage,
  trackEvent,
  reviseDocument,
  getReviseConsistencyJobStatus,
  retryReviseConsistencyJob,
  applyReviseConsistencyJob,
  getSubscription,
  type SavedDocumentSummary,
} from '../services/api';
import type { Annotation, AnnotationType, AnnotationAnchorPolicy } from '../types';
import { DocumentView } from '../components/DocumentView';
import { AnnotationList } from '../components/AnnotationList';
import '../App.css';

interface DocumentPageProps {
  initialDocument: string;
  userRequirement: string;
  currentDocumentId: string | null;
  scenario?: string;
  templateSlug?: string;
  onBack: () => void;
  onDocumentChange: (doc: string) => void;
  onDocumentSaved?: (payload: { id: string; userRequirement?: string; scenario?: string; templateSlug?: string }) => void;
  onRestoreDocument?: (documentId: string) => Promise<void> | void;
  onRequireAuthForExport: (payload: { document: string; title: string }) => void;
  exportAfterAuthSignal: number;
  onUsageRefresh?: () => Promise<void> | void;
}

const REVISE_JOB_STORAGE_KEY = 'requirement-website.revise-consistency-job.v1';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const REPAIR_STATUS_LABEL: Record<'queued' | 'running' | 'completed' | 'completed_degraded' | 'failed', string> = {
  queued: '排队中',
  running: '执行中',
  completed: '已完成',
  completed_degraded: '降级完成',
  failed: '失败',
};

export function DocumentPage({
  initialDocument,
  userRequirement,
  currentDocumentId,
  scenario,
  templateSlug,
  onBack,
  onDocumentChange,
  onDocumentSaved,
  onRestoreDocument,
  onRequireAuthForExport,
  exportAfterAuthSignal,
  onUsageRefresh,
}: DocumentPageProps) {
  const pollingJobRef = useRef('');
  const lastProcessedExportSignalRef = useRef(0);
  const checkoutPollTimerRef = useRef<number | null>(null);
  const [document, setDocument] = useState(initialDocument);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [revising, setRevising] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revisionReport, setRevisionReport] = useState<{
    applied: number;
    consistencyUpdated: boolean;
    linkedUpdates: { section: string; summary: string; reason?: string }[];
    mode: 'constrained_global_consistency';
  } | null>(null);
  const [lastRevisionAnnotations, setLastRevisionAnnotations] = useState<{
    type: string;
    quote: string;
    content?: string;
    anchorPolicy?: 'replace_selected' | 'delete_selected' | 'insert_after_selected';
  }[]>([]);
  const [consistencyJob, setConsistencyJob] = useState<{
    id: string;
    status: 'queued' | 'running' | 'completed' | 'completed_degraded' | 'failed';
    stage: 'consistency';
    step?: string;
    attempt: number;
    maxAttempts: number;
    elapsedMs: number;
    remainingMs: number;
    linkedUpdates: { section: string; summary: string; reason?: string }[];
    candidateDocument?: string;
  } | null>(null);
  const [consistencyNotice, setConsistencyNotice] = useState('');
  const [applyingConsistency, setApplyingConsistency] = useState(false);
  const [startingRepair, setStartingRepair] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showExportPaywall, setShowExportPaywall] = useState(false);
  const [exportPaywallMessage, setExportPaywallMessage] = useState('免费额度已用尽，请开通订阅后导出。');
  const [displayConsistencyRemainingMs, setDisplayConsistencyRemainingMs] = useState(0);
  const [localDocumentId, setLocalDocumentId] = useState<string | null>(currentDocumentId);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyList, setHistoryList] = useState<SavedDocumentSummary[]>([]);
  const [saving, setSaving] = useState(false);
  const [historyNotice, setHistoryNotice] = useState('');
  const [exportQuota, setExportQuota] = useState<{
    total: number;
    used: number;
    remaining: number;
    canDownload: boolean;
    paymentGatingEnabled: boolean;
  } | null>(null);

  const persistConsistencyJob = useCallback((jobId: string) => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(REVISE_JOB_STORAGE_KEY, JSON.stringify({ jobId }));
  }, []);

  const clearConsistencyJob = useCallback(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(REVISE_JOB_STORAGE_KEY);
  }, []);

  const refreshExportQuota = useCallback(async () => {
    try {
      const usage = await getUsage();
      setExportQuota({
        total: Math.max(usage.freeExportQuotaTotal ?? 3, 0),
        used: Math.max(usage.freeExportUsed ?? 0, 0),
        remaining: Math.max(usage.freeExportRemaining ?? 0, 0),
        canDownload: Boolean(usage.entitlements?.canDownload),
        paymentGatingEnabled: Boolean(usage.paymentGatingEnabled),
      });
    } catch {
      setExportQuota(null);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await listDocuments();
      setHistoryList(res.documents || []);
      setHistoryNotice('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setHistoryList([]);
        setHistoryNotice('');
        return;
      }
      setHistoryNotice(e instanceof Error ? e.message : '加载历史失败');
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const persistCurrentDocument = useCallback(async (
    options?: { saveAsCopy?: boolean; silent?: boolean; contentOverride?: string; titleOverride?: string }
  ) => {
    const content = (options?.contentOverride ?? document).trim();
    if (!content) return null;
    try {
      if (!options?.silent) setSaving(true);
      const res = await saveDocument({
        ...(localDocumentId ? { id: localDocumentId } : {}),
        ...(options?.saveAsCopy ? { saveAsCopy: true } : {}),
        title: options?.titleOverride || `需求Markdown-${userRequirement.slice(0, 20) || '文档'}`,
        userRequirement,
        scenario: scenario || '通用产品',
        document: content,
        templateSlug: templateSlug || '',
      });
      if (res.success && res.document?.id) {
        setLocalDocumentId(res.document.id);
        onDocumentSaved?.({
          id: res.document.id,
          userRequirement: res.document.userRequirement,
          scenario: res.document.scenario,
          templateSlug: res.document.templateSlug || '',
        });
        if (!options?.silent) setHistoryNotice(options?.saveAsCopy ? '已另存为副本' : '已保存');
        await loadHistory();
        return res.document;
      }
      if (!options?.silent) setHistoryNotice(res.message || '保存失败');
    } catch (e) {
      if (!options?.silent) setHistoryNotice(e instanceof Error ? e.message : '保存失败');
    } finally {
      if (!options?.silent) setSaving(false);
    }
    return null;
  }, [document, loadHistory, localDocumentId, onDocumentSaved, scenario, templateSlug, userRequirement]);

  const handleDeleteHistory = useCallback(async (id: string) => {
    try {
      await deleteDocumentById(id);
      if (id === localDocumentId) {
        setLocalDocumentId(null);
      }
      await loadHistory();
    } catch (e) {
      setHistoryNotice(e instanceof Error ? e.message : '删除失败');
    }
  }, [loadHistory, localDocumentId]);

  const addAnnotation = useCallback(
    (type: AnnotationType, quote: string, content?: string, anchorPolicy?: AnnotationAnchorPolicy) => {
      setAnnotations((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          type,
          quote,
          content: content ?? undefined,
          anchorPolicy,
        },
      ]);
    },
    []
  );

  const removeAnnotation = useCallback((id: string) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const updateAnnotation = useCallback((id: string, content: string) => {
    setAnnotations((prev) =>
      prev.map((a) => (a.id === id ? { ...a, content } : a))
    );
  }, []);

  const handleRevise = async () => {
    if (annotations.length === 0) return;
    const invalid = annotations.find(
      (item) => (item.type === 'modify' || item.type === 'supplement') && !item.content?.trim()
    );
    if (invalid) {
      setError(`${invalid.type === 'modify' ? '修改' : '补充'}标注缺少输入内容，请补全后再修订`);
      return;
    }
    setError('');
    setRevisionReport(null);
    setNotice('正在按标注修订文档，请稍候（通常 20-90 秒）…');
    setConsistencyNotice('');
    setRevising(true);
    try {
      const submittedAnnotations = annotations.map(({ type, quote, content, anchorPolicy }) => ({ type, quote, content, anchorPolicy }));
      const res = await reviseDocument(
        document,
        submittedAnnotations
      );
      if (res.success && res.document) {
        setDocument(res.document);
        setLastRevisionAnnotations(submittedAnnotations);
        setAnnotations([]);
        onDocumentChange(res.document);
        setRevisionReport(res.revisionReport ?? null);
        clearConsistencyJob();
        setConsistencyJob(null);
        setNotice('局部修订完成：文档已更新。可选点击「全篇修复」进行联动优化。');
        persistCurrentDocument({ silent: true, contentOverride: res.document }).catch(() => undefined);
      } else {
        setNotice('');
        setError(res.message || '修订失败');
      }
    } catch (e) {
      setNotice('');
      setError(e instanceof Error ? e.message : '请求失败');
    } finally {
      setRevising(false);
    }
  };

  const pollConsistencyJob = useCallback(async (jobId: string) => {
    pollingJobRef.current = jobId;
    for (let i = 0; i < 240; i += 1) {
      let res;
      try {
        res = await getReviseConsistencyJobStatus(jobId);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          clearConsistencyJob();
          setConsistencyJob(null);
          setConsistencyNotice('联动任务已过期，已清理状态。请重新点击「全篇修复」。');
          return;
        }
        if (e instanceof ApiError && e.status === 429) {
          setConsistencyNotice('联动状态轮询触发限流，已自动降频重试…');
          await sleep(4500);
          continue;
        }
        throw e;
      }
      if (pollingJobRef.current !== jobId) return;
      const status = res.status || 'running';
      setConsistencyJob({
        id: jobId,
        status,
        stage: 'consistency',
        step: res.step,
        attempt: res.attempt ?? 0,
        maxAttempts: res.maxAttempts ?? 0,
        elapsedMs: res.elapsedMs ?? 0,
        remainingMs: res.remainingMs ?? 0,
        linkedUpdates: res.linkedUpdates ?? [],
        candidateDocument: res.candidateDocument,
      });

      if (status === 'completed' || status === 'completed_degraded') {
        setConsistencyNotice(`联动已完成：发现 ${(res.linkedUpdates ?? []).length} 处可应用更新。`);
        return;
      }
      if (status === 'failed') {
        setConsistencyNotice(res.message || '联动任务失败，可手动重试');
        return;
      }
      const nextIntervalMs = status === 'queued' ? 3500 : 3000;
      await sleep(nextIntervalMs);
    }
    setConsistencyNotice('联动状态查询超时，请稍后重试');
  }, []);

  useEffect(() => {
    if (!consistencyJob?.id) return;
    if (consistencyJob.status === 'completed' || consistencyJob.status === 'completed_degraded' || consistencyJob.status === 'failed') return;
    if (pollingJobRef.current === consistencyJob.id) return;
    pollConsistencyJob(consistencyJob.id).catch((e) => {
      setConsistencyNotice(e instanceof Error ? e.message : '联动状态查询失败');
    });
  }, [consistencyJob, pollConsistencyJob]);

  useEffect(() => {
    if (!consistencyJob) {
      setDisplayConsistencyRemainingMs(0);
      return;
    }
    setDisplayConsistencyRemainingMs(consistencyJob.remainingMs || 0);
  }, [consistencyJob?.id, consistencyJob?.remainingMs]);

  useEffect(() => {
    if (!consistencyJob) return;
    if (consistencyJob.status !== 'running' && consistencyJob.status !== 'queued') return;
    if (displayConsistencyRemainingMs <= 0) return;
    const timer = window.setInterval(() => {
      setDisplayConsistencyRemainingMs((prev) => Math.max(prev - 1000, 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [consistencyJob, displayConsistencyRemainingMs]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raw = window.localStorage.getItem(REVISE_JOB_STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { jobId?: string };
      if (parsed.jobId) {
        pollConsistencyJob(parsed.jobId).catch(() => undefined);
      }
    } catch {
      clearConsistencyJob();
    }
  }, [clearConsistencyJob, pollConsistencyJob]);

  useEffect(() => {
    refreshExportQuota().catch(() => undefined);
  }, [refreshExportQuota]);

  useEffect(() => {
    setDocument(initialDocument);
  }, [initialDocument]);

  useEffect(() => {
    setLocalDocumentId(currentDocumentId);
  }, [currentDocumentId]);

  useEffect(() => {
    loadHistory().catch(() => undefined);
  }, [loadHistory]);

  const handleRetryConsistency = async () => {
    if (!consistencyJob?.id) return;
    setConsistencyNotice('');
    const res = await retryReviseConsistencyJob(consistencyJob.id);
    setConsistencyJob((prev) =>
      prev
        ? {
            ...prev,
            status: res.status || 'queued',
            attempt: res.attempt ?? prev.attempt,
            maxAttempts: res.maxAttempts ?? prev.maxAttempts,
            step: '已发起重试，等待执行',
          }
        : prev
    );
    await pollConsistencyJob(consistencyJob.id);
  };

  const handleStartRepair = async () => {
    if (startingRepair) return;
    if (lastRevisionAnnotations.length === 0) {
      setConsistencyNotice('请先完成一次「按标注修订」，再执行全篇修复。');
      return;
    }
    const sourceAnnotations = lastRevisionAnnotations.length > 0
      ? lastRevisionAnnotations
      : annotations.map(({ type, quote, content, anchorPolicy }) => ({ type, quote, content, anchorPolicy }));
    setStartingRepair(true);
    setConsistencyNotice('');
    try {
      const created = await createReviseRepairJob(document, sourceAnnotations);
      if (!created.success || !created.repairJobId) {
        throw new Error(created.message || '创建全篇修复任务失败');
      }
      persistConsistencyJob(created.repairJobId);
      setConsistencyJob({
        id: created.repairJobId,
        status: created.status || 'queued',
        stage: 'consistency',
        step: created.message || '全篇修复任务已创建',
        attempt: created.attempt ?? 0,
        maxAttempts: created.maxAttempts ?? 0,
        elapsedMs: created.elapsedMs ?? 0,
        remainingMs: created.remainingMs ?? 0,
        linkedUpdates: [],
      });
      setConsistencyNotice('全篇修复已启动，后台处理中。');
      await pollConsistencyJob(created.repairJobId);
    } catch (e) {
      setConsistencyNotice(e instanceof Error ? e.message : '启动全篇修复失败');
    } finally {
      setStartingRepair(false);
    }
  };

  const handleApplyConsistency = async () => {
    if (!consistencyJob?.id) return;
    setApplyingConsistency(true);
    try {
      const res = await applyReviseConsistencyJob(consistencyJob.id);
      if (res.success && typeof res.document === 'string' && res.document.trim()) {
        setDocument(res.document);
        onDocumentChange(res.document);
        setRevisionReport((prev) => ({
          applied: prev?.applied ?? 0,
          consistencyUpdated: true,
          linkedUpdates: res.linkedUpdates ?? consistencyJob.linkedUpdates,
          mode: 'constrained_global_consistency',
        }));
        setConsistencyNotice('已应用联动版本。');
        clearConsistencyJob();
        setConsistencyJob(null);
        persistCurrentDocument({ silent: true, contentOverride: res.document }).catch(() => undefined);
      } else {
        setConsistencyNotice(res.message || '应用联动版本失败');
      }
    } catch (e) {
      setConsistencyNotice(e instanceof Error ? e.message : '应用联动版本失败');
    } finally {
      setApplyingConsistency(false);
    }
  };

  const handleExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const title = `需求Markdown-${userRequirement.slice(0, 20)}`;
      await persistCurrentDocument({ silent: true, titleOverride: title });
      trackEvent('click_export', { source: 'document_page' }).catch(() => undefined);
      const res = await exportDocument(document, title);
      if (!res.success || !res.document) {
        throw new Error(res.message || '导出失败');
      }
      setShowExportPaywall(false);
      const blob = new Blob([res.document], { type: res.contentType || 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = window.document.createElement('a');
      a.href = url;
      a.download = `需求Markdown-${userRequirement.slice(0, 20).replace(/[/\\?*:|\s]/g, '') || '文档'}.md`;
      a.style.display = 'none';
      window.document.body.appendChild(a);
      a.click();
      window.document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 200);
      setConsistencyNotice('导出成功。');
      if (typeof res.freeExportRemaining === 'number') {
        setExportQuota((prev) => {
          if (!prev || prev.canDownload) return prev;
          const remaining = Math.max(res.freeExportRemaining ?? prev.remaining, 0);
          return {
            ...prev,
            used: Math.max(prev.total - remaining, 0),
            remaining,
          };
        });
      } else {
        refreshExportQuota().catch(() => undefined);
      }
      onUsageRefresh?.();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setConsistencyNotice('下载需要登录，登录后会自动继续下载。');
        onRequireAuthForExport({
          title: `需求Markdown-${userRequirement.slice(0, 20)}`,
          document,
        });
        return;
      }
      if (
        (error instanceof ApiError && error.status === 402 && error.code === 'subscription_required')
        || (error instanceof Error && (error.message.includes('subscription_required') || error.message.includes('月订阅')))
      ) {
        setShowExportPaywall(true);
        setExportPaywallMessage(error instanceof Error ? error.message : '免费导出次数已用完，请开通订阅后导出');
        refreshExportQuota().catch(() => undefined);
        onUsageRefresh?.();
        setConsistencyNotice('');
        return;
      }
      setError(error instanceof Error ? error.message : '导出失败');
    } finally {
      setExporting(false);
    }
  }, [document, exporting, onRequireAuthForExport, onUsageRefresh, persistCurrentDocument, refreshExportQuota, userRequirement]);

  const stopCheckoutPolling = useCallback(() => {
    if (checkoutPollTimerRef.current !== null) {
      window.clearInterval(checkoutPollTimerRef.current);
      checkoutPollTimerRef.current = null;
    }
  }, []);

  const startCheckoutPolling = useCallback(() => {
    stopCheckoutPolling();
    let rounds = 0;
    checkoutPollTimerRef.current = window.setInterval(async () => {
      rounds += 1;
      try {
        const sub = await getSubscription();
        if (sub.subscription?.status === 'active') {
          stopCheckoutPolling();
          setShowExportPaywall(false);
          setConsistencyNotice('订阅已生效，正在继续导出…');
          handleExport().catch(() => undefined);
          return;
        }
      } catch {
        // ignore transient polling errors
      }
      if (rounds >= 240) {
        stopCheckoutPolling();
      }
    }, 5000);
  }, [handleExport, stopCheckoutPolling]);

  const handleOpenCheckout = useCallback(async () => {
    try {
      const checkout = await createSubscriptionCheckout('paddle');
      if (checkout.checkoutUrl) {
        window.open(checkout.checkoutUrl, '_blank');
        setConsistencyNotice('已打开支付页，支付成功后将自动继续导出。');
        startCheckoutPolling();
      } else {
        setConsistencyNotice(checkout.message || '支付未配置，暂不可开通订阅。');
      }
    } catch (e) {
      setConsistencyNotice(e instanceof Error ? e.message : '创建订阅会话失败，请稍后重试。');
    }
  }, [startCheckoutPolling]);

  useEffect(() => () => {
    stopCheckoutPolling();
  }, [stopCheckoutPolling]);

  useEffect(() => {
    if (!exportAfterAuthSignal) return;
    if (lastProcessedExportSignalRef.current === exportAfterAuthSignal) return;
    lastProcessedExportSignalRef.current = exportAfterAuthSignal;
    handleExport().catch(() => undefined);
  }, [exportAfterAuthSignal, handleExport]);

  const hasContent = document.trim().length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <header
        style={{
          padding: '12px 24px',
          borderBottom: '1px solid #30363d',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <button className="btn-secondary" onClick={onBack}>
          返回
        </button>
        <span style={{ color: '#8b949e', fontSize: '0.9rem' }}>需求：{userRequirement.slice(0, 40)}{userRequirement.length > 40 ? '…' : ''}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span style={{ color: '#8fa7c8', fontSize: 12, alignSelf: 'center', marginRight: 4 }}>
            {exportQuota
              ? (exportQuota.canDownload
                ? (exportQuota.paymentGatingEnabled ? '已订阅，可无限导出' : '当前可无限导出（支付未开启）')
                : `免费导出剩余 ${exportQuota.remaining}/${exportQuota.total}，用完需订阅`)
              : '下载需登录'}
          </span>
          <button
            className="btn-primary"
            onClick={handleRevise}
            disabled={annotations.length === 0 || revising}
          >
            {revising ? '修订中…' : `按标注修订${annotations.length > 0 ? ` (${annotations.length})` : ''}`}
          </button>
          <button
            className="btn-secondary"
            onClick={() => {
              persistCurrentDocument().catch(() => undefined);
            }}
            disabled={saving}
          >
            {saving ? '保存中…' : '保存'}
          </button>
          <button
            className="btn-secondary"
            onClick={() => {
              persistCurrentDocument({ saveAsCopy: true }).catch(() => undefined);
            }}
            disabled={saving}
          >
            另存副本
          </button>
          <button className="btn-secondary" onClick={handleExport}>
            {exporting ? '导出中…' : '导出 .md'}
          </button>
        </div>
      </header>
      {error && (
        <div style={{ padding: '8px 24px', background: '#f8514922', color: '#f85149' }}>
          {error}
        </div>
      )}
      {notice && (
        <div
          style={{
            padding: '8px 24px',
            background: revising ? '#58a6ff22' : '#3fb95022',
            color: revising ? '#79c0ff' : '#3fb950',
            borderBottom: '1px solid #30363d',
          }}
        >
          {notice}
        </div>
      )}
      {historyNotice && (
        <div
          style={{
            padding: '8px 24px',
            background: '#58a6ff22',
            color: '#79c0ff',
            borderBottom: '1px solid #30363d',
          }}
        >
          {historyNotice}
        </div>
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <main style={{ flex: 1, overflow: 'auto', padding: 24 }}>
          <details
            style={{
              marginBottom: 14,
              padding: '12px 14px',
              border: '1px solid #30363d',
              borderRadius: 10,
              background: '#0f1722',
            }}
          >
            <summary style={{ cursor: 'pointer', color: '#d7e4f7' }}>
              历史文档（{historyList.length}）
            </summary>
            <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  loadHistory().catch(() => undefined);
                }}
                disabled={historyLoading}
                style={{ width: 'fit-content' }}
              >
                {historyLoading ? '刷新中…' : '刷新历史'}
              </button>
              {historyList.length === 0 ? (
                <p style={{ color: '#95a9c8', margin: 0 }}>暂无已保存文档（登录后可保存并恢复）。</p>
              ) : (
                historyList.map((item) => (
                  <div
                    key={item.id}
                    style={{
                      border: '1px solid rgba(146,170,203,0.25)',
                      borderRadius: 8,
                      padding: 10,
                      background: 'rgba(10,18,30,0.72)',
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 8,
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div style={{ minWidth: 260, flex: 1 }}>
                      <div style={{ color: '#dce8fb', fontSize: 14 }}>{item.title || '需求文档'}</div>
                      <div style={{ color: '#95a9c8', fontSize: 12, marginTop: 4 }}>
                        {item.userRequirement || '未填写需求描述'} · {item.scenario || '通用产品'} · {item.lastUsedAt || item.updatedAt}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => {
                          onRestoreDocument?.(item.id);
                        }}
                      >
                        恢复
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => {
                          handleDeleteHistory(item.id).catch(() => undefined);
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </details>
          {hasContent && (
            <section
              style={{
                marginBottom: 14,
                padding: '12px 14px',
                border: '1px solid #2c3c52',
                borderRadius: 10,
                background: 'rgba(12, 22, 38, 0.72)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ color: '#9fb2cc', fontSize: 13 }}>
                完成一次「按标注修订」后，可手动执行全篇修复（预计 30-180 秒，完成后先预览再应用）。
              </div>
              <button
                className="btn-secondary"
                onClick={handleStartRepair}
                disabled={startingRepair || (!document.trim()) || lastRevisionAnnotations.length === 0}
                title={lastRevisionAnnotations.length === 0 ? '请先完成一次按标注修订' : undefined}
              >
                {startingRepair ? '启动中…' : '全篇修复'}
              </button>
            </section>
          )}
          {consistencyJob && (
            <details
              open
              style={{
                marginBottom: 18,
                padding: '12px 14px',
                border: '1px solid #30363d',
                borderRadius: 10,
                background: '#0f1722',
              }}
            >
              <summary style={{ cursor: 'pointer', color: '#d7e4f7' }}>
                联动任务状态：{REPAIR_STATUS_LABEL[consistencyJob.status] ?? consistencyJob.status}
              </summary>
              <p style={{ color: '#95a9c8', margin: '10px 0 6px' }}>
                {consistencyJob.step || '处理中'}
              </p>
              <p style={{ color: '#95a9c8' }}>
                重试：{consistencyJob.attempt}/{consistencyJob.maxAttempts}；剩余时间：{Math.max(Math.floor(displayConsistencyRemainingMs / 1000), 0)}秒
              </p>
              {consistencyNotice && <p style={{ color: '#79c0ff' }}>{consistencyNotice}</p>}
              {(consistencyJob.status === 'completed' || consistencyJob.status === 'completed_degraded') && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={handleApplyConsistency}
                    disabled={applyingConsistency}
                  >
                    {applyingConsistency ? '应用中…' : `应用联动版本（${consistencyJob.linkedUpdates.length}处）`}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      setConsistencyNotice('已保留当前文档，你可稍后再次发起全篇修复。');
                      clearConsistencyJob();
                      setConsistencyJob(null);
                    }}
                  >
                    保持当前版
                  </button>
                </div>
              )}
              {consistencyJob.status === 'failed' && (
                <div style={{ marginTop: 10 }}>
                  <button type="button" className="btn-secondary" onClick={handleRetryConsistency}>
                    重试联动
                  </button>
                </div>
              )}
            </details>
          )}
          {revisionReport && (
            <details
              style={{
                marginBottom: 18,
                padding: '12px 14px',
                border: '1px solid #30363d',
                borderRadius: 10,
                background: '#0f1722',
              }}
            >
              <summary style={{ cursor: 'pointer', color: '#d7e4f7' }}>
                联动更新清单（{revisionReport.linkedUpdates.length}）
              </summary>
              <p style={{ color: '#95a9c8', margin: '10px 0 8px' }}>
                已应用标注：{revisionReport.applied}；联动更新：{revisionReport.consistencyUpdated ? '是' : '否'}
              </p>
              {revisionReport.linkedUpdates.length > 0 ? (
                <div style={{ display: 'grid', gap: 8 }}>
                  {revisionReport.linkedUpdates.map((item, idx) => (
                    <div key={`${item.section}-${idx}`} style={{ padding: 10, borderRadius: 8, background: '#111d2c' }}>
                      <div style={{ color: '#79c0ff', fontSize: 13 }}>{item.section}</div>
                      <div style={{ color: '#dce9fb', marginTop: 4 }}>{item.summary}</div>
                      {item.reason && <div style={{ color: '#95a9c8', marginTop: 4 }}>原因：{item.reason}</div>}
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ color: '#95a9c8' }}>本次无跨章节联动更新。</p>
              )}
            </details>
          )}
          {hasContent ? (
            <DocumentView
              document={document}
              onAddAnnotation={addAnnotation}
            />
          ) : (
            <div style={{ color: '#8b949e', padding: 24, textAlign: 'center' }}>
              <p>文档为空或加载异常，请返回重新生成。</p>
              <button type="button" className="btn-secondary" style={{ marginTop: 16 }} onClick={onBack}>
                返回首页
              </button>
            </div>
          )}
        </main>
        <AnnotationList
          annotations={annotations}
          onRemove={removeAnnotation}
          onUpdateContent={updateAnnotation}
        />
      </div>
      {showExportPaywall && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(2, 8, 20, 0.72)',
            display: 'grid',
            placeItems: 'center',
            zIndex: 55,
            padding: 16,
          }}
          onClick={() => setShowExportPaywall(false)}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 420,
              border: '1px solid rgba(146,170,203,0.28)',
              borderRadius: 14,
              padding: 18,
              background: 'rgba(9,17,28,0.96)',
              color: '#dce8fb',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0, marginBottom: 10 }}>导出需要开通订阅</h3>
            <p style={{ margin: '0 0 14px', color: '#9fb2cc', lineHeight: 1.6 }}>
              {exportPaywallMessage}
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button
                className="btn-secondary"
                onClick={() => {
                  stopCheckoutPolling();
                  setShowExportPaywall(false);
                }}
              >
                稍后再说
              </button>
              <button
                className="btn-primary"
                onClick={async () => {
                  await handleOpenCheckout();
                }}
              >
                去支付开通
              </button>
            </div>
            <p style={{ marginTop: 12, marginBottom: 0, color: '#8fa4c1', fontSize: 12, lineHeight: 1.6 }}>
              继续即表示同意
              {' '}
              <a href="/legal/terms.html" target="_blank" rel="noreferrer">用户协议</a>
              {' '}
              /
              {' '}
              <a href="/legal/privacy.html" target="_blank" rel="noreferrer">隐私政策</a>
              {' '}
              /
              {' '}
              <a href="/legal/refund.html" target="_blank" rel="noreferrer">退款说明</a>
              {' '}
              /
              {' '}
              <a href="/content/pricing.html" target="_blank" rel="noreferrer">定价</a>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
