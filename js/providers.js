/* ============================================================
   providers.js — model adapters
   Streaming chat against OpenAI-compatible, Sarvam, Anthropic and
   Google Gemini endpoints. The user supplies their own API key; it is
   never bundled with the app.
   ============================================================ */

export const PRESETS = {
  openai:    { label: 'OpenAI-compatible', baseUrl: 'https://api.openai.com/v1',                    model: 'gpt-4o-mini' },
  sarvam:    { label: 'Sarvam AI',         baseUrl: 'https://api.sarvam.ai/v1',                     model: 'sarvam-m' },
  anthropic: { label: 'Anthropic',         baseUrl: 'https://api.anthropic.com/v1',                 model: 'claude-3-5-sonnet-latest' },
  gemini:    { label: 'Google Gemini',     baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash' },
};

export const DEFAULT_SETTINGS = {
  provider: 'openai',
  baseUrl: PRESETS.openai.baseUrl,
  model: PRESETS.openai.model,
  apiKey: '',
  temperature: 0.2,
  maxSteps: 14,
};

export function isConfigured(s) {
  return !!(s && s.apiKey && s.model && s.baseUrl);
}

/* ---------- helpers ---------- */

async function* sseData(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload && payload !== '[DONE]') yield payload;
      }
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith('data:')) {
    const payload = tail.slice(5).trim();
    if (payload && payload !== '[DONE]') yield payload;
  }
}

async function readError(res) {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message || j?.message || j?.detail || text;
    } catch { detail = text; }
  } catch { /* ignore */ }
  return `${res.status} ${res.statusText}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`;
}

function mergeRoles(messages) {
  // Anthropic/Gemini need strictly alternating turns; merge same-role runs.
  const out = [];
  for (const m of messages) {
    if (!m.content) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

/* ---------- adapters ---------- */

async function streamOpenAI({ baseUrl, apiKey, model, messages, temperature, signal, onToken }) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature, stream: true }),
  });
  if (!res.ok) throw new Error(await readError(res));
  let full = '';
  for await (const payload of sseData(res)) {
    let json;
    try { json = JSON.parse(payload); } catch { continue; }
    if (json.error) throw new Error(json.error.message || 'Provider error');
    const delta = json.choices?.[0]?.delta?.content;
    if (delta) { full += delta; onToken?.(delta); }
  }
  return full;
}

async function streamAnthropic({ baseUrl, apiKey, model, messages, temperature, signal, onToken }) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const convo = mergeRoles(messages.filter(m => m.role !== 'system'));
  if (convo.length && convo[0].role !== 'user') convo.unshift({ role: 'user', content: '(continue)' });
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/messages`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model, max_tokens: 4096, temperature, system, messages: convo, stream: true }),
  });
  if (!res.ok) throw new Error(await readError(res));
  let full = '';
  for await (const payload of sseData(res)) {
    let json;
    try { json = JSON.parse(payload); } catch { continue; }
    if (json.type === 'error') throw new Error(json.error?.message || 'Provider error');
    const text = json.delta?.text;
    if (json.type === 'content_block_delta' && text) { full += text; onToken?.(text); }
  }
  return full;
}

async function streamGemini({ baseUrl, apiKey, model, messages, temperature, signal, onToken }) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const convo = mergeRoles(messages.filter(m => m.role !== 'system'))
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  if (convo.length && convo[0].role !== 'user') convo.unshift({ role: 'user', parts: [{ text: '(continue)' }] });
  const url = `${baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: convo,
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      generationConfig: { temperature },
    }),
  });
  if (!res.ok) throw new Error(await readError(res));
  let full = '';
  for await (const payload of sseData(res)) {
    let json;
    try { json = JSON.parse(payload); } catch { continue; }
    if (json.error) throw new Error(json.error.message || 'Provider error');
    const parts = json.candidates?.[0]?.content?.parts || [];
    for (const p of parts) if (p.text) { full += p.text; onToken?.(p.text); }
  }
  return full;
}

const ADAPTERS = {
  openai: streamOpenAI,
  sarvam: streamOpenAI,
  anthropic: streamAnthropic,
  gemini: streamGemini,
};

/**
 * Stream a chat completion. Returns the full assistant text.
 * Emits incremental text via onToken(chunk).
 */
export async function streamChat(opts) {
  const { provider = 'openai' } = opts;
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`Unknown provider: ${provider}`);
  if (!opts.apiKey) throw new Error('No API key set. Open Settings and add your key.');
  return adapter(opts);
}

/** Cheap connectivity check — a single tiny completion. */
export async function testConnection(settings) {
  const text = await streamChat({
    ...settings,
    messages: [
      { role: 'system', content: 'You are a connectivity probe. Reply with the single word: ready' },
      { role: 'user', content: 'ping' },
    ],
    temperature: 0,
  });
  return (text || '').trim();
}
