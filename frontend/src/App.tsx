import { useEffect, useState } from 'react';
import { Home } from './pages/Home';
import { DocumentPage } from './pages/DocumentPage';
import {
  getAuthTokens,
  getMe,
  getUsage,
  login,
  logout,
  refreshAuth,
  register,
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
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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

  const handleGenerate = (req: string, doc: string) => {
    setUserRequirement(req);
    setDocument(doc);
  };

  const openAuthDialog = (mode: 'login' | 'register' = 'login') => {
    setAuthMode(mode);
    setAuthError('');
    setShowAuthDialog(true);
  };

  const handleAuthSubmit = async () => {
    setAuthError('');
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
                ? (authMode === 'login' ? '登录后继续下载' : '注册后继续下载')
                : (authMode === 'login' ? '登录' : '注册并登录')}
            </h3>
            {pendingAction === 'download' && (
              <p style={{ color: '#95a9c8', marginTop: 0, fontSize: 13 }}>
                当前文档：{pendingDocumentContext?.title || '未命名文档'}。登录成功后会自动继续下载。
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
            <input
              type="password"
              placeholder="密码（至少 8 位）"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ width: '100%', marginBottom: 10, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(146,170,203,0.25)', background: '#0b1526', color: '#dce8fb' }}
            />
            {authError && <p style={{ color: '#ff9ea5', marginTop: 6 }}>{authError}</p>}
            <button
              onClick={handleAuthSubmit}
              disabled={authLoading}
              style={{ width: '100%', marginTop: 6, padding: '10px 12px', borderRadius: 999, border: 'none', background: '#58c6ff', color: '#032034', fontWeight: 700, cursor: authLoading ? 'not-allowed' : 'pointer' }}
            >
              {authLoading ? '处理中…' : authMode === 'login' ? '登录' : '注册并登录'}
            </button>
            <button
              onClick={() => setAuthMode((m) => (m === 'login' ? 'register' : 'login'))}
              disabled={authLoading}
              style={{ width: '100%', marginTop: 10, padding: '10px 12px', borderRadius: 999, border: '1px solid rgba(146,170,203,0.3)', background: 'transparent', color: '#dce8fb', cursor: authLoading ? 'not-allowed' : 'pointer' }}
            >
              {authMode === 'login' ? '没有账号？去注册' : '已有账号？去登录'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
