import { useEffect, useState } from 'react';
import { Home } from './pages/Home';
import { DocumentPage } from './pages/DocumentPage';
import {
  forgotPassword,
  getAuthTokens,
  getMe,
  getUsage,
  login,
  logout,
  refreshAuth,
  register,
  resetPassword,
  trackEvent,
  type AuthUser,
} from './services/api';

const APP_STORAGE_KEY = 'requirement-website.app-state.v1';
const HOME_STORAGE_KEY = 'requirement-website.home-state.v1';

function readAppState() {
  if (typeof window === 'undefined') {
    return { document: '', userRequirement: '' };
  }
  try {
    const raw = window.localStorage.getItem(APP_STORAGE_KEY);
    if (!raw) return { document: '', userRequirement: '' };
    const parsed = JSON.parse(raw) as { document?: unknown; userRequirement?: unknown };
    return {
      document: typeof parsed.document === 'string' ? parsed.document : '',
      userRequirement: typeof parsed.userRequirement === 'string' ? parsed.userRequirement : '',
    };
  } catch {
    return { document: '', userRequirement: '' };
  }
}

export default function App() {
  const [document, setDocument] = useState(() => readAppState().document);
  const [userRequirement, setUserRequirement] = useState(() => readAppState().userRequirement);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [showAuthDialog, setShowAuthDialog] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authDialogNotice, setAuthDialogNotice] = useState('');
  const [authMode, setAuthMode] = useState<'login' | 'register' | 'forgot'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [name, setName] = useState('');
  const [usageSummary, setUsageSummary] = useState('');
  const [pendingAction, setPendingAction] = useState<'download' | null>(null);
  const [pendingDocumentContext, setPendingDocumentContext] = useState<{
    document: string;
    title: string;
  } | null>(null);
  const [exportAfterAuthSignal, setExportAfterAuthSignal] = useState(0);
  const [authNotice, setAuthNotice] = useState('');
  const isDocumentView = Boolean(document && userRequirement);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!document || !userRequirement) {
      window.localStorage.removeItem(APP_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(APP_STORAGE_KEY, JSON.stringify({ document, userRequirement }));
  }, [document, userRequirement]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('auth') !== 'reset-password') return;

    const emailFromLink = (params.get('email') || '').trim();
    const codeFromLink = (params.get('code') || '').trim();
    setEmail(emailFromLink);
    setResetCode(codeFromLink);
    setPassword('');
    setAuthMode('forgot');
    setAuthError('');
    setAuthDialogNotice(codeFromLink ? '已从邮件链接填入重置码，请输入新密码后提交。' : '请填写重置码并输入新密码。');
    setShowAuthDialog(true);

    const nextPath = `${window.location.pathname}${window.location.hash || ''}`;
    window.history.replaceState({}, window.document.title, nextPath);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      const tokens = getAuthTokens();
      if (!tokens) {
        if (!cancelled) setAuthLoading(false);
        return;
      }
      try {
        const me = await getMe();
        if (!cancelled) setAuthUser(me.user ?? null);
      } catch {
        try {
          const refreshed = await refreshAuth();
          if (!cancelled) setAuthUser(refreshed.user ?? null);
        } catch {
          if (!cancelled) setAuthUser(null);
        }
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    };
    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!authUser) {
      setUsageSummary('');
      return;
    }
    let cancelled = false;
    getUsage()
      .then((usage) => {
        if (cancelled) return;
        setUsageSummary(`本月剩余：生成 ${usage.quotaRemaining.generateRemaining} 次，修订 ${usage.quotaRemaining.reviseRemaining} 次`);
      })
      .catch(() => {
        if (cancelled) return;
        setUsageSummary('');
      });
    return () => {
      cancelled = true;
    };
  }, [authUser]);

  useEffect(() => {
    setAuthError('');
    setAuthDialogNotice('');
    if (authMode !== 'forgot') {
      setResetCode('');
    }
  }, [authMode]);

  const handleGenerate = (req: string, doc: string) => {
    setUserRequirement(req);
    setDocument(doc);
  };

  const openAuthDialog = (mode: 'login' | 'register' | 'forgot' = 'login') => {
    setAuthMode(mode);
    setAuthError('');
    setAuthDialogNotice('');
    setResetCode('');
    if (mode !== 'register') setName('');
    if (mode !== 'forgot') {
      setPassword('');
    }
    setShowAuthDialog(true);
  };

  const handleAuthSubmit = async () => {
    if (authMode === 'forgot') return;
    setAuthError('');
    setAuthDialogNotice('');
    if (!email.trim() || !password.trim()) {
      setAuthError('请输入邮箱和密码');
      return;
    }
    setAuthLoading(true);
    try {
      const res = authMode === 'login'
        ? await login(email.trim(), password)
        : await register(email.trim(), password, name.trim() || undefined);
      if (!res.success || !res.user) {
        throw new Error(res.message || '登录失败');
      }
      setAuthUser(res.user);
      trackEvent('login_success', { mode: authMode }).catch(() => undefined);
      setPassword('');
      setShowAuthDialog(false);
      if (pendingAction === 'download') {
        setAuthNotice('已登录，正在返回标注页并继续下载');
        setExportAfterAuthSignal((v) => v + 1);
        setPendingAction(null);
        setPendingDocumentContext(null);
      } else {
        setAuthNotice('已登录');
      }
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '登录失败');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSendResetCode = async () => {
    setAuthError('');
    setAuthDialogNotice('');
    if (!email.trim()) {
      setAuthError('请输入注册邮箱');
      return;
    }
    setAuthLoading(true);
    try {
      const res = await forgotPassword(email.trim());
      if (!res.success) {
        throw new Error(res.message || '发送重置码失败');
      }
      setAuthDialogNotice(res.message || '若邮箱已注册，重置码已发送');
      if (res.resetCode) {
        setResetCode(res.resetCode);
        setAuthDialogNotice(`已发送重置码（测试环境）：${res.resetCode}`);
      }
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '发送重置码失败');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleResetPassword = async () => {
    setAuthError('');
    setAuthDialogNotice('');
    if (!email.trim() || !resetCode.trim() || !password.trim()) {
      setAuthError('请填写邮箱、6位重置码和新密码');
      return;
    }
    setAuthLoading(true);
    try {
      const res = await resetPassword(email.trim(), resetCode.trim(), password);
      if (!res.success) {
        throw new Error(res.message || '重置密码失败');
      }
      setAuthDialogNotice('密码已重置，请使用新密码登录');
      setPassword('');
      setResetCode('');
      setAuthMode('login');
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '重置密码失败');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    setAuthUser(null);
    setUsageSummary('');
  };

  const handleRequireAuthForExport = (payload: { document: string; title: string }) => {
    setPendingAction('download');
    setPendingDocumentContext(payload);
    setAuthNotice('');
    openAuthDialog('login');
  };

  return (
    <div>
      {!isDocumentView && (
        <div
          style={{
            position: 'fixed',
            top: 12,
            right: 12,
            zIndex: 30,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
          }}
        >
          {authNotice && <span style={{ color: '#7dd8ff', fontSize: 12 }}>{authNotice}</span>}
          {authUser ? (
            <>
              {usageSummary && <span style={{ color: '#8fb2d7', fontSize: 12 }}>{usageSummary}</span>}
              <span style={{ color: '#b8cbe6', fontSize: 13 }}>{authUser.email}</span>
              <button
                onClick={handleLogout}
                style={{ border: '1px solid rgba(146,170,203,0.3)', borderRadius: 999, padding: '6px 12px', background: 'rgba(9,17,28,0.7)', color: '#dce8fb' }}
              >
                退出
              </button>
            </>
          ) : (
            <button
              onClick={() => openAuthDialog('login')}
              style={{ border: '1px solid rgba(146,170,203,0.3)', borderRadius: 999, padding: '6px 12px', background: 'rgba(9,17,28,0.7)', color: '#dce8fb' }}
            >
              登录 / 注册
            </button>
          )}
        </div>
      )}

      {isDocumentView ? (
        <DocumentPage
          initialDocument={document}
          userRequirement={userRequirement}
          onBack={() => {
            if (typeof window !== 'undefined') {
              window.localStorage.removeItem(HOME_STORAGE_KEY);
            }
            setDocument('');
            setUserRequirement('');
          }}
          onDocumentChange={setDocument}
          onRequireAuthForExport={handleRequireAuthForExport}
          exportAfterAuthSignal={exportAfterAuthSignal}
        />
      ) : (
        <Home onGenerate={handleGenerate} />
      )}

      {showAuthDialog && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(2, 8, 20, 0.68)',
            display: 'grid',
            placeItems: 'center',
            zIndex: 40,
            padding: 16,
          }}
          onClick={() => setShowAuthDialog(false)}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 420,
              border: '1px solid rgba(146,170,203,0.25)',
              borderRadius: 14,
              padding: 18,
              background: 'rgba(9,17,28,0.95)',
              color: '#dce8fb',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0, marginBottom: 8 }}>
              {pendingAction === 'download'
                ? (authMode === 'register' ? '注册后继续下载' : authMode === 'forgot' ? '找回密码后登录下载' : '登录后继续下载')
                : (authMode === 'register' ? '注册并登录' : authMode === 'forgot' ? '找回密码' : '登录')}
            </h3>
            {pendingAction === 'download' && (
              <p style={{ color: '#95a9c8', marginTop: 0, fontSize: 13 }}>
                当前文档：{pendingDocumentContext?.title || '未命名文档'}。登录成功后会自动继续下载。
              </p>
            )}
            {authMode === 'forgot' && (
              <p style={{ color: '#95a9c8', marginTop: 0, fontSize: 13 }}>
                输入注册邮箱，发送 6 位重置码后设置新密码。
              </p>
            )}
            {authMode === 'register' && (
              <input
                placeholder="昵称（可选）"
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={{ width: '100%', marginBottom: 10, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(146,170,203,0.25)', background: '#0b1526', color: '#dce8fb' }}
              />
            )}
            <input
              placeholder="邮箱"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ width: '100%', marginBottom: 10, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(146,170,203,0.25)', background: '#0b1526', color: '#dce8fb' }}
            />
            {authMode === 'forgot' && (
              <>
                <button
                  onClick={handleSendResetCode}
                  disabled={authLoading}
                  style={{ width: '100%', marginBottom: 10, padding: '10px 12px', borderRadius: 999, border: '1px solid rgba(146,170,203,0.3)', background: 'transparent', color: '#dce8fb', cursor: authLoading ? 'not-allowed' : 'pointer' }}
                >
                  {authLoading ? '发送中…' : '发送重置码'}
                </button>
                <input
                  placeholder="6位重置码"
                  value={resetCode}
                  onChange={(e) => setResetCode(e.target.value)}
                  style={{ width: '100%', marginBottom: 10, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(146,170,203,0.25)', background: '#0b1526', color: '#dce8fb' }}
                />
              </>
            )}
            <input
              type="password"
              placeholder={authMode === 'forgot' ? '新密码（至少 8 位）' : '密码（至少 8 位）'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ width: '100%', marginBottom: 10, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(146,170,203,0.25)', background: '#0b1526', color: '#dce8fb' }}
            />
            {authDialogNotice && <p style={{ color: '#7dd8ff', marginTop: 6 }}>{authDialogNotice}</p>}
            {authError && <p style={{ color: '#ff9ea5', marginTop: 6 }}>{authError}</p>}
            <button
              onClick={authMode === 'forgot' ? handleResetPassword : handleAuthSubmit}
              disabled={authLoading}
              style={{ width: '100%', marginTop: 6, padding: '10px 12px', borderRadius: 999, border: 'none', background: '#58c6ff', color: '#032034', fontWeight: 700, cursor: authLoading ? 'not-allowed' : 'pointer' }}
            >
              {authLoading
                ? '处理中…'
                : authMode === 'register'
                  ? '注册并登录'
                  : authMode === 'forgot'
                    ? '重置密码'
                    : '登录'}
            </button>
            {authMode !== 'forgot' && (
              <button
                onClick={() => setAuthMode((m) => (m === 'register' ? 'login' : 'register'))}
                disabled={authLoading}
                style={{ width: '100%', marginTop: 10, padding: '10px 12px', borderRadius: 999, border: '1px solid rgba(146,170,203,0.3)', background: 'transparent', color: '#dce8fb', cursor: authLoading ? 'not-allowed' : 'pointer' }}
              >
                {authMode === 'register' ? '已有账号？去登录' : '没有账号？去注册'}
              </button>
            )}
            {authMode !== 'forgot' && (
              <button
                onClick={() => setAuthMode('forgot')}
                disabled={authLoading}
                style={{ width: '100%', marginTop: 10, padding: '10px 12px', borderRadius: 999, border: '1px solid rgba(146,170,203,0.3)', background: 'transparent', color: '#b8cbe6', cursor: authLoading ? 'not-allowed' : 'pointer' }}
              >
                忘记密码？
              </button>
            )}
            {authMode === 'forgot' && (
              <button
                onClick={() => setAuthMode('login')}
                disabled={authLoading}
                style={{ width: '100%', marginTop: 10, padding: '10px 12px', borderRadius: 999, border: '1px solid rgba(146,170,203,0.3)', background: 'transparent', color: '#b8cbe6', cursor: authLoading ? 'not-allowed' : 'pointer' }}
              >
                返回登录
              </button>
            )}
            <p style={{ marginTop: 10, marginBottom: 0, color: '#8fa4c1', fontSize: 12, lineHeight: 1.6 }}>
              登录/注册即表示同意
              {' '}
              <a href="/legal/terms.html" target="_blank" rel="noreferrer">用户协议</a>
              {' '}
              /
              {' '}
              <a href="/legal/privacy.html" target="_blank" rel="noreferrer">隐私政策</a>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
