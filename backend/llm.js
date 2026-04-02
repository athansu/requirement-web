import https from 'https';
import http from 'http';
import { HttpsProxyAgent } from 'https-proxy-agent';

/**
 * OpenAI 兼容的 chat completions 请求，支持 options.model、options.stream 与代理。
 * 环境变量在每次请求时读取，确保 dotenv 已加载。
 */
export async function requestLLM(messages, options = {}) {
  const rawKey = process.env.LLM_API_KEY || '';
  const API_KEY = rawKey.replace(/\r?\n/g, '').trim();
  const BASE_URL = (process.env.LLM_BASE_URL || 'https://api.deepseek.com').trim();
  const PROXY = (process.env.LLM_PROXY || process.env.HTTPS_PROXY || '').trim();
  if (!API_KEY) {
    throw new Error('未配置 LLM_API_KEY，请在 backend/.env 中填写');
  }
  if (!API_KEY.startsWith('sk-')) {
    throw new Error('LLM_API_KEY 格式异常，应以 sk- 开头，请检查 .env');
  }
  const model = options.model || process.env.LLM_MODEL || 'deepseek-chat';
  const stream = options.stream !== false;
  const timeoutMs = Math.max(
    Number(options.timeout_ms ?? process.env.LLM_TIMEOUT_MS) || 480000,
    1000
  );
  const url = new URL('/v1/chat/completions', BASE_URL);
  const body = JSON.stringify({
    model,
    messages,
    stream,
    max_tokens: options.max_tokens ?? 12288,
  });

  const agent = PROXY ? new HttpsProxyAgent(PROXY) : undefined;
  const isHttps = url.protocol === 'https:';

  return new Promise((resolve, reject) => {
    let settled = false;
    let totalTimeoutId;
    const finalize = (fn, value) => {
      if (settled) return;
      settled = true;
      if (totalTimeoutId) clearTimeout(totalTimeoutId);
      fn(value);
    };
    const fail = (error, shouldDestroy = false) => {
      finalize(reject, error instanceof Error ? error : new Error(String(error)));
      if (shouldDestroy) {
        req.destroy();
      }
    };
    const succeed = (value) => finalize(resolve, value);

    const req = (isHttps ? https : http).request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
          'Content-Length': Buffer.byteLength(body, 'utf8'),
        },
        agent,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (settled) return;
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            let msg = res.statusMessage || `HTTP ${res.statusCode}`;
            try {
              const err = JSON.parse(raw);
              msg = err.error?.message || err.message || msg;
            } catch (_) {}
            return fail(new Error(`大模型 API 错误 (${res.statusCode}): ${msg}`));
          }
          let content = '';
          if (stream) {
            const lines = raw.split('\n').filter((line) => line.startsWith('data: '));
            if (lines.length > 0) {
              for (const line of lines) {
                const data = line.slice(6);
                if (data === '[DONE]') break;
                try {
                  const obj = JSON.parse(data);
                  const delta = obj.choices?.[0]?.delta?.content;
                  if (typeof delta === 'string') content += delta;
                } catch (_) {}
              }
            }
          }
          if (!content) {
            try {
              const obj = JSON.parse(raw);
              const text = obj.choices?.[0]?.message?.content;
              if (typeof text === 'string') content = text;
            } catch (_) {}
          }
          succeed(content);
        });
      }
    );
    // Absolute timeout for the whole request lifecycle.
    totalTimeoutId = setTimeout(() => {
      fail(new Error(`大模型请求超时（${timeoutMs}ms）`), true);
    }, timeoutMs);

    // Keep idle-timeout as a secondary guard.
    req.setTimeout(timeoutMs, () => {
      fail(new Error(`大模型请求超时（${timeoutMs}ms）`), true);
    });
    req.on('error', (e) => {
      const msg = e?.message || String(e);
      fail(new Error(`网络请求失败: ${msg}。请检查 LLM_BASE_URL、网络或代理设置`));
    });
    req.write(body);
    req.end();
  });
}
