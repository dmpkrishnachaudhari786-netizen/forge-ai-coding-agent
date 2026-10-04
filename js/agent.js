/* ============================================================
   agent.js — the Forge agent loop
   observe → think → act → observe. Real tools against the real
   virtual filesystem and the real sandbox. One tool call per turn.
   ============================================================ */

import { streamChat } from './providers.js';

const MAX_OBSERVATION = 6000;

export const TOOL_NAMES = ['list_files', 'read_file', 'write_file', 'delete_file', 'run_tests', 'set_preview', 'finish'];

function systemPrompt(fs, maxSteps) {
  const files = fs.list();
  const listing = files.length ? files.join('\n') : '(the project is empty)';
  return `You are Forge, an autonomous coding agent running entirely inside the user's web browser.
You build small, complete web projects by writing real files into a virtual filesystem, then you verify your work by running tests.

## The project right now
Files in the project:
${listing}

## How you act
Call exactly ONE tool per turn. To call a tool, reply with ONLY a fenced json block, nothing else:

\`\`\`json
{"thought":"one short sentence of reasoning","tool":"TOOL_NAME","args":{ }}
\`\`\`

## Tools
- list_files   args {}
    List every file path in the project.
- read_file   args {"path":"index.html"}
    Return a file's full contents.
- write_file  args {"path":"style.css","content":"..."}
    Create or overwrite a file. "content" must be the COMPLETE file text.
    Inside the JSON string, escape newlines as \\n, tabs as \\t, double quotes as \\" and backslashes as \\\\.
- delete_file args {"path":"old.js"}
    Delete a file from the project.
- run_tests   args {"code":"...","include":["app.js"]}
    Run JavaScript in an isolated sandbox and get back console output, assert() results and any errors.
    Use assert(condition, "message") for checks. THIS IS THE ONLY WAY TO VERIFY YOUR CODE.
    List every project file your test code depends on in "include" — they are loaded into the sandbox before your code runs.
    Example, to test a greet() function that lives in hello.js:
      {"code":"assert(greet('a') === 'Hello, a!', 'greets')","include":["hello.js"]}
- set_preview args {"path":"index.html"}
    Choose which HTML file the live preview panel renders.
- finish      args {"summary":"what you built and how you verified it"}
    End the task. Call this only after run_tests has passed.

## Rules
1. Think briefly in "thought", then call exactly one tool.
2. write_file "content" is the whole file — never a fragment, never "TODO", never a placeholder. Write real, working code.
3. Prefer plain HTML/CSS/JavaScript with no build step. Make it responsive and accessible.
4. ALWAYS run_tests on your core logic before calling finish. If a test fails, read the error, fix the file and test again. If you get "X is not defined", add the file that defines X to the run_tests "include" list.
5. Never invent test results. Report exactly what the sandbox returned.
6. If the user asks a question that needs no file change, reply in plain prose with no tool call — that ends the turn.
7. You have at most ${maxSteps} steps. Keep the project focused on exactly what the user asked for.

Begin.`;
}

/* ---------- tool-call parsing ---------- */

function repairJson(s) {
  // Escape raw control characters inside string literals + drop trailing commas.
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { out += c; esc = false; continue; }
    if (c === '\\') { out += c; esc = true; continue; }
    if (c === '"') { inStr = !inStr; out += c; continue; }
    if (inStr) {
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r') { continue; }
      if (c === '\t') { out += '\\t'; continue; }
    }
    out += c;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { /* try repair */ }
  try { return JSON.parse(repairJson(s)); } catch { return null; }
}

export function parseToolCall(text) {
  const raw = String(text || '');
  const candidates = [];

  const fence = /```(?:json)?\s*([\s\S]*)/i.exec(raw);
  if (fence) {
    let body = fence[1];
    const close = body.lastIndexOf('```');
    if (close !== -1) body = body.slice(0, close);
    candidates.push(body.trim());
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) candidates.push(trimmed);
  const objMatch = /\{[\s\S]*"tool"[\s\S]*\}/.exec(raw);
  if (objMatch) candidates.push(objMatch[0]);

  for (let i = candidates.length - 1; i >= 0; i--) {
    const o = tryParse(candidates[i]);
    if (o && typeof o === 'object') {
      const tool = o.tool || o.name || o.action;
      const args = o.args || o.arguments || o.parameters || {};
      if (tool) return { tool: String(tool).trim(), args: args || {}, thought: o.thought || '' };
      if (o.finish || o.final) return { tool: 'finish', args: { summary: o.finish || o.final }, thought: o.thought || '' };
    }
  }
  return null;
}

/* ---------- tool execution ---------- */

async function executeTool(call, ctx) {
  const { fs, runInSandbox, onPreview } = ctx;
  const args = call.args || {};
  const trunc = (s) => {
    const t = String(s ?? '');
    return t.length > MAX_OBSERVATION ? t.slice(0, MAX_OBSERVATION) + `\n…[truncated ${t.length - MAX_OBSERVATION} chars]` : t;
  };

  switch (call.tool) {
    case 'list_files': {
      const files = fs.list();
      return { ok: true, summary: `${files.length} file${files.length === 1 ? '' : 's'}`, detail: files.join('\n') || '(empty)' };
    }

    case 'read_file': {
      const path = args.path;
      if (!path) return { ok: false, summary: 'missing path', detail: 'ERROR: read_file needs {"path":"..."}' };
      if (!fs.has(path)) return { ok: false, summary: 'not found', detail: `ERROR: no such file: ${path}` };
      const content = fs.read(path);
      return { ok: true, summary: `${path} · ${content.length} chars`, detail: trunc(content) };
    }

    case 'write_file': {
      const path = args.path;
      const content = args.content;
      if (!path) return { ok: false, summary: 'missing path', detail: 'ERROR: write_file needs {"path":"...","content":"..."}' };
      if (typeof content !== 'string') return { ok: false, summary: 'missing content', detail: 'ERROR: write_file "content" must be a string containing the full file text.' };
      await fs.write(path, content);
      const lines = content.split('\n').length;
      return { ok: true, summary: `${path} · ${lines} lines`, detail: `OK: wrote ${path} (${content.length} chars, ${lines} lines).` };
    }

    case 'delete_file': {
      const path = args.path;
      if (!path || !fs.has(path)) return { ok: false, summary: 'not found', detail: `ERROR: no such file: ${path}` };
      await fs.remove(path);
      return { ok: true, summary: `deleted ${path}`, detail: `OK: deleted ${path}.` };
    }

    case 'run_tests': {
      const code = args.code;
      if (typeof code !== 'string' || !code.trim()) return { ok: false, summary: 'no code', detail: 'ERROR: run_tests needs {"code":"..."}' };
      const include = Array.isArray(args.include) ? args.include.map(String) : (args.include ? [String(args.include)] : []);
      const missing = include.filter(p => !fs.has(p));
      if (missing.length) {
        return { ok: false, summary: 'missing include', detail: `ERROR: cannot include file(s) that do not exist: ${missing.join(', ')}.\nProject files: ${fs.list().join(', ') || '(none)'}` };
      }
      const prefix = include.map(p => `/* ==== ${p} ==== */\n${fs.read(p)}`).join('\n\n');
      const full = prefix ? `${prefix}\n\n/* ==== test code ==== */\n${code}` : code;
      const res = await runInSandbox(full);
      const pass = res.assertions.filter(a => a.ok).length;
      const fail = res.assertions.filter(a => !a.ok).length;
      const lines = [];
      if (include.length) lines.push(`Loaded from project: ${include.join(', ')}`);
      if (res.assertions.length) {
        lines.push(`Assertions: ${pass} passed, ${fail} failed`);
        for (const a of res.assertions) lines.push(`${a.ok ? 'PASS' : 'FAIL'}: ${a.msg}`);
      } else {
        lines.push('Assertions: 0 (no assert() calls)');
      }
      if (res.logs.length) {
        lines.push('', 'console output:');
        for (const l of res.logs) lines.push(`[${l.level}] ${l.text}`);
      }
      if (res.errors.length) {
        lines.push('', 'errors:');
        for (const e of res.errors) lines.push(`ERROR: ${e}`);
      }
      const hint = res.errors.some(e => /is not defined/.test(e))
        ? '\nHINT: something you referenced is not defined. If it is defined in a project file, call run_tests again with "include":["that-file.js"].'
        : '';
      const ok = fail === 0 && res.errors.length === 0 && !res.timedOut;
      return {
        ok,
        summary: `${pass} passed · ${fail} failed · ${res.errors.length} error${res.errors.length === 1 ? '' : 's'}`,
        detail: trunc(lines.join('\n') + hint),
        raw: res,
      };
    }

    case 'set_preview': {
      const path = args.path;
      if (!path || !fs.has(path)) return { ok: false, summary: 'not found', detail: `ERROR: cannot preview missing file: ${path}` };
      onPreview?.(path);
      return { ok: true, summary: `preview → ${path}`, detail: `OK: preview set to ${path}.` };
    }

    case 'finish': {
      return { ok: true, summary: 'finished', detail: String(args.summary || 'Task complete.'), finish: true };
    }

    default:
      return { ok: false, summary: 'unknown tool', detail: `ERROR: unknown tool "${call.tool}". Use one of: ${TOOL_NAMES.join(', ')}` };
  }
}

/* ---------- the loop ---------- */

/**
 * Run the agent on a task.
 * @param {object} o
 * @param {string} o.task
 * @param {VirtualFS} o.fs
 * @param {object} o.settings
 * @param {Array}  o.history   prior {role, content} messages (mutated copy returned)
 * @param {function} o.onEvent  event sink
 * @param {AbortSignal} o.signal
 */
export async function runAgent({ task, fs, settings, history = [], runInSandbox, onPreview, onEvent = () => {}, signal }) {
  const maxSteps = Math.max(1, Math.min(40, Number(settings.maxSteps) || 14));
  const messages = [
    ...history,
    { role: 'user', content: task },
  ];
  // fresh system prompt each run so the file listing is current
  const convo = [
    { role: 'system', content: systemPrompt(fs, maxSteps) },
    ...messages.filter(m => m.role !== 'system'),
  ];

  let finished = false;
  let finalSummary = '';

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) { onEvent({ type: 'status', text: 'Stopped' }); break; }
    onEvent({ type: 'status', text: `Thinking… step ${step}/${maxSteps}` });
    onEvent({ type: 'assistant-start' });

    let raw = '';
    try {
      raw = await streamChat({
        provider: settings.provider,
        baseUrl: settings.baseUrl,
        model: settings.model,
        apiKey: settings.apiKey,
        temperature: settings.temperature,
        messages: convo,
        signal,
        onToken: (t) => onEvent({ type: 'token', text: t }),
      });
    } catch (err) {
      if (signal?.aborted) { onEvent({ type: 'status', text: 'Stopped' }); break; }
      onEvent({ type: 'assistant-end', text: raw, aborted: false });
      onEvent({ type: 'error', message: friendlyError(err) });
      return { history: messages, finished: false };
    }

    onEvent({ type: 'assistant-end', text: raw });
    convo.push({ role: 'assistant', content: raw });
    messages.push({ role: 'assistant', content: raw });

    const call = parseToolCall(raw);
    if (!call) {
      // plain-prose answer — the turn is over
      break;
    }

    onEvent({ type: 'tool-start', name: call.tool, args: call.args, thought: call.thought });
    const result = await executeTool(call, { fs, runInSandbox, onPreview });
    onEvent({ type: 'tool-result', name: call.tool, ok: result.ok, summary: result.summary, detail: result.detail, raw: result.raw, args: call.args });

    const observation = `TOOL RESULT — ${call.tool} (${result.ok ? 'success' : 'failure'}):\n${result.detail}`;
    convo.push({ role: 'user', content: observation });
    messages.push({ role: 'user', content: observation });

    if (result.finish) { finished = true; finalSummary = result.detail; break; }
    if (step === maxSteps) onEvent({ type: 'error', message: `Reached the ${maxSteps}-step limit before finishing. Raise "Max steps" in Settings or send a follow-up.` });
  }

  onEvent({ type: 'done', finished, summary: finalSummary });
  return { history: messages, finished, summary: finalSummary };
}

function friendlyError(err) {
  const msg = String(err?.message || err);
  if (err?.name === 'AbortError') return 'Stopped by user.';
  if (/Failed to fetch|NetworkError|load failed/i.test(msg)) {
    return `Could not reach the model endpoint. Check your internet connection, the Base URL, and whether the provider allows browser requests (CORS). Details: ${msg}`;
  }
  if (/\b401\b|\b403\b/.test(msg)) return `Authentication failed — check your API key and that it has access to the model. Details: ${msg}`;
  if (/\b429\b/.test(msg)) return `Rate limited by the provider. Wait a moment and try again. Details: ${msg}`;
  return msg;
}
