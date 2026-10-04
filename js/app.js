/* ============================================================
   app.js — Forge UI wiring
   Connects the virtual filesystem, editor, preview, sandbox and the
   agent loop into one working application.
   ============================================================ */

import { VirtualFS, normPath, extOf } from './fs.js';
import { runInSandbox, buildPreviewHtml } from './sandbox.js';
import { PRESETS, DEFAULT_SETTINGS, isConfigured, testConnection } from './providers.js';
import { runAgent } from './agent.js';
import { highlight, renderMarkdown, esc } from './highlight.js';

/* ---------- element cache ---------- */
const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'),
  fileTree: $('fileTree'), fileSelect: $('fileSelect'),
  editorShell: $('editorShell'), editorEmpty: $('editorEmpty'),
  editorInput: $('editorInput'), editorHighlight: $('editorHighlight'),
  editorGutter: $('editorGutter'), editorStatus: $('editorStatus'),
  btnNewFile: $('btnNewFile'), btnDeleteFile: $('btnDeleteFile'),
  btnRenameFile: $('btnRenameFile'), btnSaveFile: $('btnSaveFile'),
  btnExport: $('btnExport'), btnImport: $('btnImport'), importFile: $('importFile'),
  btnSample: $('btnSample'), btnResetProject: $('btnResetProject'),
  previewFrame: $('previewFrame'), previewEntry: $('previewEntry'), previewEmpty: $('previewEmpty'),
  btnRefreshPreview: $('btnRefreshPreview'), btnOpenPreview: $('btnOpenPreview'),
  runInput: $('runInput'), runOutput: $('runOutput'), runSummary: $('runSummary'),
  btnRunManual: $('btnRunManual'), btnClearRun: $('btnClearRun'),
  testFileSelect: $('testFileSelect'), btnRunProject: $('btnRunProject'),
  chatLog: $('chatLog'), chatForm: $('chatForm'), taskInput: $('taskInput'),
  btnRun: $('btnRun'), btnStop: $('btnStop'), btnClearChat: $('btnClearChat'),
  engineStatus: $('engineStatus'), engineStatusLabel: $('engineStatusLabel'),
  agentPulse: $('agentPulse'), modelHint: $('modelHint'),
  settingsModal: $('settingsModal'), btnSettings: $('btnSettings'),
  btnCloseSettings: $('btnCloseSettings'), btnCancelSettings: $('btnCancelSettings'),
  btnSaveSettings: $('btnSaveSettings'), btnTestKey: $('btnTestKey'), testKeyResult: $('testKeyResult'),
  setProvider: $('setProvider'), setBaseUrl: $('setBaseUrl'), setModel: $('setModel'),
  setApiKey: $('setApiKey'), setTemperature: $('setTemperature'), setTempVal: $('setTempVal'),
  setMaxSteps: $('setMaxSteps'),
  toast: $('toast'),
};

/* ---------- state ---------- */
const fs = new VirtualFS();
let settings = { ...DEFAULT_SETTINGS };
let activePath = null;
let dirty = false;
let agentHistory = [];
let running = false;
let controller = null;
let previewEntryPath = 'index.html';
let toastTimer = null;

const SETTINGS_KEY = 'forge-settings';

/* ============================================================
   Boot
   ============================================================ */
init();

async function init() {
  loadSettings();
  await fs.init();
  if (fs.list().length === 0) await loadSample(true);

  bindUI();
  renderFileTree();
  populateSelects();
  openFile(pickDefaultFile());
  refreshPreview();
  setEngineStatus('idle');
  updateModelHint();
  setTab(window.innerWidth >= 1024 ? 'code' : 'chat');

  if (!isConfigured(settings)) {
    addSystemMsg('No model configured yet. Open Settings (gear icon) and add your API key to start the agent.');
  } else {
    addSystemMsg('Ready. Describe what you want to build, then press Run.');
  }

  registerServiceWorker();
  window.addEventListener('message', onPreviewMessage);
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* defaults */ }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

/* ============================================================
   Tabs / navigation
   ============================================================ */
function bindUI() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  });
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  });

  // editor
  els.editorInput.addEventListener('input', () => { dirty = true; renderEditor(); });
  els.editorInput.addEventListener('scroll', syncScroll);
  els.editorInput.addEventListener('keydown', onEditorKeydown);
  els.editorInput.addEventListener('click', updateCaret);
  els.editorInput.addEventListener('keyup', updateCaret);

  // files
  els.btnNewFile.addEventListener('click', newFile);
  els.btnDeleteFile.addEventListener('click', deleteFile);
  els.btnRenameFile.addEventListener('click', renameFile);
  els.btnSaveFile.addEventListener('click', () => saveActive(true));
  els.fileSelect.addEventListener('change', () => openFile(els.fileSelect.value));
  els.btnExport.addEventListener('click', exportProject);
  els.btnImport.addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', importProject);
  els.btnSample.addEventListener('click', () => { loadSample(false).then(() => { renderFileTree(); populateSelects(); openFile(pickDefaultFile()); refreshPreview(); toast('Starter project loaded'); }); });
  els.btnResetProject.addEventListener('click', resetProject);

  // preview
  els.btnRefreshPreview.addEventListener('click', refreshPreview);
  els.previewEntry.addEventListener('change', () => { previewEntryPath = els.previewEntry.value; refreshPreview(); });
  els.btnOpenPreview.addEventListener('click', openPreviewInTab);

  // run
  els.btnRunManual.addEventListener('click', () => runCode(els.runInput.value, 'manual'));
  els.btnRunProject.addEventListener('click', runProjectTests);
  els.btnClearRun.addEventListener('click', () => { els.runOutput.innerHTML = '<div class="console-line dim">Console cleared.</div>'; els.runSummary.textContent = 'No runs yet'; });

  // chat
  els.chatForm.addEventListener('submit', onChatSubmit);
  els.taskInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); els.chatForm.requestSubmit(); }
  });
  els.taskInput.addEventListener('input', autosizeTask);
  els.btnStop.addEventListener('click', stopAgent);
  els.btnClearChat.addEventListener('click', () => { agentHistory = []; els.chatLog.innerHTML = ''; addSystemMsg('Conversation cleared.'); });

  // settings
  els.btnSettings.addEventListener('click', openSettings);
  els.btnCloseSettings.addEventListener('click', closeSettings);
  els.btnCancelSettings.addEventListener('click', closeSettings);
  els.settingsModal.querySelector('[data-close]').addEventListener('click', closeSettings);
  els.btnSaveSettings.addEventListener('click', applySettings);
  els.btnTestKey.addEventListener('click', onTestConnection);
  els.setProvider.addEventListener('change', onProviderChange);
  els.setTemperature.addEventListener('input', () => { els.setTempVal.textContent = els.setTemperature.value; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.settingsModal.hidden) closeSettings();
  });

  // keyboard shortcut
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveActive(true); }
  });
}

function setTab(name) {
  const isChat = name === 'chat';
  els.chatLog.closest('.agent').classList.toggle('active', isChat || window.innerWidth >= 1024);
  document.querySelector('.workspace').classList.toggle('active', !isChat);

  document.querySelectorAll('.nav-item').forEach(b => b.setAttribute('aria-current', String(b.dataset.tab === name)));
  const workTab = isChat ? (document.querySelector('.tab[aria-selected="true"]')?.dataset.tab || 'code') : name;
  document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === workTab)));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${workTab}`));
}

/* ============================================================
   Files
   ============================================================ */
function renderFileTree() {
  const files = fs.list();
  els.fileTree.innerHTML = '';
  if (!files.length) {
    const li = document.createElement('li');
    li.className = 'file-item muted';
    li.textContent = 'No files yet';
    els.fileTree.appendChild(li);
    return;
  }
  for (const path of files) {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.setAttribute('role', 'listitem');
    li.setAttribute('aria-current', String(path === activePath));
    li.innerHTML = `<span>${esc(path)}</span><span class="ext">${esc(extOf(path) || 'file')}</span>`;
    li.addEventListener('click', () => { openFile(path); setTab('code'); });
    els.fileTree.appendChild(li);
  }
}

function populateSelects() {
  const files = fs.list();
  const prev = els.fileSelect.value;
  els.fileSelect.innerHTML = files.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  if (files.includes(prev)) els.fileSelect.value = prev;

  const htmls = files.filter(p => ['html', 'htm'].includes(extOf(p)));
  const prevEntry = els.previewEntry.value;
  els.previewEntry.innerHTML = htmls.length
    ? htmls.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('')
    : '<option value="">No HTML files</option>';
  if (htmls.includes(prevEntry)) els.previewEntry.value = prevEntry;
  if (htmls.length) {
    if (!htmls.includes(previewEntryPath)) previewEntryPath = htmls.includes('index.html') ? 'index.html' : htmls[0];
    els.previewEntry.value = previewEntryPath;
  }

  const jsFiles = files.filter(p => extOf(p) === 'js');
  const prevTest = els.testFileSelect.value;
  els.testFileSelect.innerHTML = jsFiles.length
    ? jsFiles.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('')
    : '<option value="">No .js files</option>';
  if (jsFiles.includes(prevTest)) els.testFileSelect.value = prevTest;
  else if (jsFiles.includes('tests.js')) els.testFileSelect.value = 'tests.js';
}

/** Concatenate the project's plain .js files with the chosen test file and run them. */
async function runProjectTests() {
  const testFile = els.testFileSelect.value;
  if (!testFile || !fs.has(testFile)) { toast('No test file to run — add a .js file first'); return; }
  const others = fs.list().filter(p => extOf(p) === 'js' && p !== testFile);
  const code = others.map(p => `/* ==== ${p} ==== */\n${fs.read(p)}`).join('\n\n') + `\n\n/* ==== ${testFile} ==== */\n${fs.read(testFile)}`;
  setTab('run');
  await runCode(code, `${testFile} (+${others.length} file${others.length === 1 ? '' : 's'})`);
}

function pickDefaultFile() {
  const files = fs.list();
  return files.find(p => p === 'index.html') || files[0] || null;
}

function openFile(path) {
  if (!path || !fs.has(path)) { showEditorEmpty(true); return; }
  activePath = normPath(path);
  els.editorInput.value = fs.read(activePath);
  dirty = false;
  showEditorEmpty(false);
  renderEditor();
  renderFileTree();
  els.fileSelect.value = activePath;
  setTab('code');
}

function showEditorEmpty(show) {
  els.editorShell.hidden = show;
  els.editorEmpty.hidden = !show;
}

function renderEditor() {
  const code = els.editorInput.value;
  els.editorHighlight.innerHTML = highlight(code, activePath || 'txt');
  const lines = code.split('\n').length;
  els.editorGutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
  syncScroll();
  updateCaret();
}

function syncScroll() {
  const { scrollTop, scrollLeft } = els.editorInput;
  els.editorHighlight.parentElement.scrollTop = scrollTop;
  els.editorHighlight.parentElement.scrollLeft = scrollLeft;
  els.editorGutter.scrollTop = scrollTop;
}

function updateCaret() {
  const upto = els.editorInput.value.slice(0, els.editorInput.selectionStart);
  const line = upto.split('\n').length;
  const col = upto.length - upto.lastIndexOf('\n');
  els.editorStatus.textContent = `${line}:${col}${dirty ? ' • unsaved' : ''}`;
}

function onEditorKeydown(e) {
  const ta = els.editorInput;
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = ta.selectionStart, en = ta.selectionEnd;
    ta.setRangeText('  ', s, en, 'end');
    dirty = true; renderEditor();
  } else if (e.key === 'Enter') {
    const s = ta.selectionStart;
    const before = ta.value.slice(0, s);
    const lineStart = before.lastIndexOf('\n') + 1;
    const indent = (/^[ \t]*/.exec(ta.value.slice(lineStart, s)) || [''])[0];
    if (indent) {
      e.preventDefault();
      ta.setRangeText('\n' + indent, s, ta.selectionEnd, 'end');
      dirty = true; renderEditor();
    }
  }
}

async function saveActive(showToast) {
  if (!activePath) return;
  await fs.write(activePath, els.editorInput.value);
  dirty = false;
  updateCaret();
  if (showToast) toast(`Saved ${activePath}`);
  refreshPreviewIfEntry();
}

function newFile() {
  const name = prompt('New file name (e.g. index.html, style.css, app.js):');
  if (!name) return;
  const p = normPath(name);
  if (fs.has(p)) { toast('That file already exists'); openFile(p); return; }
  fs.write(p, '').then(() => {
    renderFileTree(); populateSelects(); openFile(p); setTab('code');
  });
}

function deleteFile() {
  if (!activePath) return;
  if (!confirm(`Delete ${activePath}? This cannot be undone.`)) return;
  fs.remove(activePath).then(() => {
    activePath = null;
    renderFileTree(); populateSelects();
    openFile(pickDefaultFile());
    refreshPreview();
    toast('File deleted');
  });
}

function renameFile() {
  if (!activePath) return;
  const next = prompt('Rename file to:', activePath);
  if (!next || normPath(next) === activePath) return;
  fs.rename(activePath, next).then((p) => {
    activePath = p;
    renderFileTree(); populateSelects(); openFile(p); refreshPreview();
    toast(`Renamed to ${p}`);
  });
}

async function resetProject() {
  if (!confirm('Delete every file in this project? This cannot be undone.')) return;
  await fs.clear();
  activePath = null;
  renderFileTree(); populateSelects();
  showEditorEmpty(true);
  refreshPreview();
  toast('Project cleared');
}

function exportProject() {
  const data = { app: 'Forge', version: 1, exportedAt: new Date().toISOString(), files: fs.snapshot() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'forge-project.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Project exported');
}

function importProject(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(String(reader.result));
      const files = Array.isArray(data) ? data : data.files;
      if (!Array.isArray(files)) throw new Error('No files array found');
      await fs.clear();
      await fs.writeMany(files.map(f => ({ path: f.path, content: f.content })));
      renderFileTree(); populateSelects(); openFile(pickDefaultFile()); refreshPreview();
      toast(`Imported ${files.length} file${files.length === 1 ? '' : 's'}`);
    } catch (err) {
      toast('Import failed: ' + err.message);
    }
    e.target.value = '';
  };
  reader.readAsText(file);
}

/* ============================================================
   Preview
   ============================================================ */
function refreshPreviewIfEntry() {
  if (activePath === previewEntryPath) refreshPreview();
}

function refreshPreview() {
  const html = buildPreviewHtml(fs, previewEntryPath);
  els.previewFrame.srcdoc = html;
  const has = fs.list().some(p => ['html', 'htm'].includes(extOf(p)));
  els.previewEmpty.hidden = has;
  els.previewFrame.style.visibility = has ? 'visible' : 'hidden';
}

function openPreviewInTab() {
  const html = buildPreviewHtml(fs, previewEntryPath);
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

function onPreviewMessage(ev) {
  const d = ev.data;
  if (!d || d.type !== 'forge-preview-log') return;
  if (d.level === 'error') {
    appendConsole('preview: ' + d.text, 'err');
    toastThrottled('Preview error: ' + String(d.text).slice(0, 80));
  }
}

/* ============================================================
   Run & test
   ============================================================ */
function appendConsole(text, cls = '') {
  const div = document.createElement('div');
  div.className = 'console-line ' + cls;
  div.textContent = text;
  els.runOutput.appendChild(div);
  els.runOutput.scrollTop = els.runOutput.scrollHeight;
}

function clearConsole() { els.runOutput.innerHTML = ''; }

async function runCode(code, label = 'manual') {
  clearConsole();
  appendConsole(`▶ Running ${label} …`, 'sys');
  const t0 = performance.now();
  const res = await runInSandbox(code);
  const ms = Math.round(performance.now() - t0);
  renderRunResult(res, ms);
  return res;
}

function renderRunResult(res, ms) {
  const pass = res.assertions.filter(a => a.ok).length;
  const fail = res.assertions.filter(a => !a.ok).length;
  for (const a of res.assertions) appendConsole(`${a.ok ? '✓ PASS' : '✗ FAIL'}  ${a.msg}`, a.ok ? 'ok' : 'fail');
  if (res.logs.length) {
    appendConsole('— console —', 'dim');
    for (const l of res.logs) appendConsole(l.text, l.level === 'error' ? 'err' : '');
  }
  if (res.errors.length) {
    appendConsole('— errors —', 'dim');
    for (const e of res.errors) appendConsole(e, 'err');
  }
  const status = res.errors.length || fail ? 'fail' : 'ok';
  appendConsole(`— ${pass} passed · ${fail} failed · ${res.errors.length} error(s) · ${ms}ms —`, status);
  els.runSummary.textContent = `${pass} passed · ${fail} failed`;
  return status;
}

/* ============================================================
   Chat
   ============================================================ */
function addSystemMsg(text) {
  const d = document.createElement('div');
  d.className = 'msg msg-system';
  d.textContent = text;
  els.chatLog.appendChild(d);
  scrollChat();
}

function addUserMsg(text) {
  const d = document.createElement('div');
  d.className = 'msg msg-user';
  d.innerHTML = `<div class="msg-role">You</div>${renderMarkdown(text)}`;
  els.chatLog.appendChild(d);
  scrollChat();
}

function addAgentMsg() {
  const d = document.createElement('div');
  d.className = 'msg msg-agent';
  d.innerHTML = '<div class="msg-role">Forge</div><div class="msg-content cursor"></div>';
  els.chatLog.appendChild(d);
  scrollChat();
  return d.querySelector('.msg-content');
}

function addErrorMsg(text) {
  const d = document.createElement('div');
  d.className = 'msg msg-error';
  d.innerHTML = `<div class="msg-role">Error</div>${renderMarkdown(text)}`;
  els.chatLog.appendChild(d);
  scrollChat();
}

function addToolCard(name, args, thought) {
  const details = document.createElement('details');
  details.className = 'tool-card';
  details.dataset.thought = thought || '';
  const argPreview = summarizeArgs(args);
  details.innerHTML = `
    <summary>
      <span class="tool-name">${esc(name)}</span>
      <span class="muted small">${esc(argPreview)}</span>
      <span class="tool-badge running">running…</span>
    </summary>
    <div class="tool-body">${thought ? esc(thought) + '\n\n' : ''}…</div>`;
  els.chatLog.appendChild(details);
  scrollChat();
  return details;
}

function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    let s = typeof v === 'string' ? v : JSON.stringify(v);
    s = String(s).replace(/\s+/g, ' ');
    if (s.length > 60) s = s.slice(0, 60) + '…';
    parts.push(`${k}: ${s}`);
  }
  return parts.join(' · ');
}

function scrollChat() { els.chatLog.scrollTop = els.chatLog.scrollHeight; }

function autosizeTask() {
  const ta = els.taskInput;
  ta.style.height = 'auto';
  ta.style.height = Math.min(140, ta.scrollHeight) + 'px';
}

async function onChatSubmit(e) {
  e.preventDefault();
  if (running) return;
  const task = els.taskInput.value.trim();
  if (!task) return;

  if (!isConfigured(settings)) {
    addErrorMsg('No model configured. Open **Settings** and add your API key first.');
    openSettings();
    return;
  }

  els.taskInput.value = '';
  autosizeTask();
  addUserMsg(task);

  running = true;
  controller = new AbortController();
  els.btnRun.disabled = true;
  els.btnStop.hidden = false;
  setEngineStatus('running');

  let streamEl = null;
  let streamBuf = '';
  let lastRender = 0;
  let toolCard = null;

  const flush = (force = false) => {
    if (!streamEl) return;
    const now = performance.now();
    if (!force && now - lastRender < 90) return;
    lastRender = now;
    streamEl.innerHTML = renderMarkdown(streamBuf) + (force ? '' : '<span class="cursor"></span>');
    scrollChat();
  };

  try {
    const res = await runAgent({
      task,
      fs,
      settings,
      history: agentHistory,
      runInSandbox: (code) => runInSandbox(code, { timeout: 6000 }),
      onPreview: (path) => { previewEntryPath = path; els.previewEntry.value = path; refreshPreview(); },
      signal: controller.signal,
      onEvent: (ev) => {
        switch (ev.type) {
          case 'status':
            els.engineStatusLabel.textContent = ev.text;
            break;
          case 'assistant-start':
            streamEl = addAgentMsg();
            streamBuf = '';
            break;
          case 'token':
            streamBuf += ev.text;
            flush();
            break;
          case 'assistant-end':
            streamBuf = ev.text || streamBuf;
            if (streamEl) {
              if (streamBuf.trim()) streamEl.innerHTML = renderMarkdown(streamBuf);
              else streamEl.closest('.msg')?.remove();
              streamEl = null;
            }
            scrollChat();
            break;
          case 'tool-start':
            toolCard = addToolCard(ev.name, ev.args, ev.thought);
            break;
          case 'tool-result': {
            const badge = toolCard?.querySelector('.tool-badge');
            if (toolCard && badge) {
              badge.className = 'tool-badge ' + (ev.ok ? 'ok' : 'fail');
              badge.textContent = ev.summary || (ev.ok ? 'ok' : 'failed');
              const body = toolCard.querySelector('.tool-body');
              const thought = toolCard.dataset.thought || '';
              body.textContent = (thought ? thought + '\n\n' : '') + (ev.detail || '');
            }
            if (ev.name === 'run_tests' && ev.raw) { clearConsole(); renderRunResult(ev.raw, 0); }
            if (ev.name === 'write_file' || ev.name === 'delete_file') {
              renderFileTree(); populateSelects();
            }
            toolCard = null;
            break;
          }
          case 'error':
            addErrorMsg(ev.message);
            break;
          case 'done':
            if (ev.finished) addSystemMsg('Task finished.');
            renderFileTree(); populateSelects();
            if (activePath) openFileSilent(activePath);
            refreshPreview();
            break;
        }
      },
    });
    agentHistory = res.history;
  } catch (err) {
    addErrorMsg('Agent crashed: ' + (err?.message || err));
  } finally {
    running = false;
    controller = null;
    els.btnRun.disabled = false;
    els.btnStop.hidden = true;
    setEngineStatus(isConfigured(settings) ? 'ready' : 'idle');
    els.engineStatusLabel.textContent = 'Idle';
  }
}

function openFileSilent(path) {
  if (!fs.has(path)) return;
  const keep = activePath;
  if (keep === path && !dirty) {
    els.editorInput.value = fs.read(path);
    renderEditor();
  }
}

function stopAgent() {
  if (controller) controller.abort();
}

/* ============================================================
   Status + toast
   ============================================================ */
function setEngineStatus(state) {
  els.engineStatus.dataset.state = state;
  els.agentPulse.dataset.state = state;
  if (state === 'running') els.engineStatusLabel.textContent = 'Running';
  else if (state === 'ready') els.engineStatusLabel.textContent = 'Ready';
  else if (state === 'error') els.engineStatusLabel.textContent = 'Error';
  else els.engineStatusLabel.textContent = 'Idle';
}

function updateModelHint() {
  els.modelHint.textContent = isConfigured(settings)
    ? `${settings.provider} · ${settings.model}`
    : 'No model configured — open Settings';
}

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
}

let lastToast = '';
function toastThrottled(msg) {
  if (msg === lastToast) return;
  lastToast = msg;
  toast(msg);
  setTimeout(() => { if (lastToast === msg) lastToast = ''; }, 4000);
}

/* ============================================================
   Settings
   ============================================================ */
function openSettings() {
  els.setProvider.value = settings.provider;
  els.setBaseUrl.value = settings.baseUrl;
  els.setModel.value = settings.model;
  els.setApiKey.value = settings.apiKey;
  els.setTemperature.value = settings.temperature;
  els.setTempVal.textContent = settings.temperature;
  els.setMaxSteps.value = settings.maxSteps;
  els.testKeyResult.textContent = '';
  els.settingsModal.hidden = false;
  els.setApiKey.focus();
}
function closeSettings() { els.settingsModal.hidden = true; }

function onProviderChange() {
  const p = PRESETS[els.setProvider.value];
  if (p) { els.setBaseUrl.value = p.baseUrl; els.setModel.value = p.model; }
}

function applySettings() {
  settings = {
    provider: els.setProvider.value,
    baseUrl: els.setBaseUrl.value.trim() || PRESETS[els.setProvider.value].baseUrl,
    model: els.setModel.value.trim(),
    apiKey: els.setApiKey.value.trim(),
    temperature: Number(els.setTemperature.value),
    maxSteps: Math.max(1, Math.min(40, Number(els.setMaxSteps.value) || 14)),
  };
  saveSettings();
  updateModelHint();
  setEngineStatus(isConfigured(settings) ? 'ready' : 'idle');
  closeSettings();
  toast('Settings saved');
}

async function onTestConnection() {
  const draft = {
    provider: els.setProvider.value,
    baseUrl: els.setBaseUrl.value.trim(),
    model: els.setModel.value.trim(),
    apiKey: els.setApiKey.value.trim(),
    temperature: 0,
  };
  if (!draft.apiKey || !draft.model) { els.testKeyResult.textContent = 'Add a key and model first.'; return; }
  els.testKeyResult.textContent = 'Testing…';
  els.btnTestKey.disabled = true;
  try {
    const reply = await testConnection(draft);
    els.testKeyResult.textContent = reply ? `Connected ✓ (“${reply.slice(0, 30)}”)` : 'Connected ✓';
  } catch (err) {
    els.testKeyResult.textContent = 'Failed: ' + String(err.message || err).slice(0, 120);
  } finally {
    els.btnTestKey.disabled = false;
  }
}

/* ============================================================
   Service worker
   ============================================================ */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is best-effort */ });
}

/* ============================================================
   Starter project
   ============================================================ */
async function loadSample(silent) {
  await fs.writeMany(SAMPLE_FILES);
  if (!silent) { /* caller re-renders */ }
}

const SAMPLE_FILES = [
  {
    path: 'index.html',
    content: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tip Splitter</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <main class="card">
    <h1>Tip Splitter</h1>
    <p class="sub">Work out the tip and what each person pays.</p>

    <label>Bill amount (₹)
      <input id="bill" type="number" min="0" step="1" value="1200" />
    </label>
    <label>Tip %
      <input id="tip" type="number" min="0" max="50" step="1" value="10" />
    </label>
    <label>People
      <input id="people" type="number" min="1" step="1" value="4" />
    </label>

    <div class="result" id="result" aria-live="polite"></div>
  </main>
  <script src="app.js"><\/script>
</body>
</html>`,
  },
  {
    path: 'styles.css',
    content: `:root { --bg:#0f1420; --card:#171e2e; --ink:#eef2f8; --dim:#93a0b8; --accent:#ff8a3d; }
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; display: grid; place-items: center;
  background: radial-gradient(circle at 30% 0%, #1b2436, var(--bg));
  color: var(--ink); font-family: system-ui, sans-serif; padding: 20px;
}
.card { width: min(420px, 100%); background: var(--card); border-radius: 18px; padding: 24px; box-shadow: 0 20px 50px rgba(0,0,0,.45); }
h1 { margin: 0 0 4px; font-size: 22px; }
.sub { margin: 0 0 18px; color: var(--dim); font-size: 14px; }
label { display: block; margin-bottom: 14px; font-size: 13px; color: var(--dim); }
input { width: 100%; margin-top: 6px; padding: 11px 12px; border-radius: 10px; border: 1px solid #2a3550; background: #0e1320; color: var(--ink); font-size: 16px; }
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.result { margin-top: 18px; padding: 16px; border-radius: 12px; background: #0e1320; border: 1px solid #2a3550; font-size: 15px; }
.result b { color: var(--accent); }`,
  },
  {
    path: 'app.js',
    content: `// Pure logic — easy to unit test in the Run & Test panel.
function calcTip(bill, tipPercent, people) {
  const amount = Math.max(0, Number(bill) || 0);
  const pct = Math.max(0, Number(tipPercent) || 0);
  const n = Math.max(1, Math.floor(Number(people) || 1));
  const tip = (amount * pct) / 100;
  const total = amount + tip;
  return {
    tip: Math.round(tip * 100) / 100,
    total: Math.round(total * 100) / 100,
    perPerson: Math.round((total / n) * 100) / 100,
  };
}

const money = (n) => '₹' + n.toFixed(2);

function render() {
  const bill = document.getElementById('bill').value;
  const tip = document.getElementById('tip').value;
  const people = document.getElementById('people').value;
  const r = calcTip(bill, tip, people);
  document.getElementById('result').innerHTML =
    'Tip: <b>' + money(r.tip) + '</b><br>' +
    'Total: <b>' + money(r.total) + '</b><br>' +
    'Each person pays: <b>' + money(r.perPerson) + '</b>';
}

document.addEventListener('DOMContentLoaded', () => {
  ['bill', 'tip', 'people'].forEach(id =>
    document.getElementById(id).addEventListener('input', render));
  render();
});`,
  },
  {
    path: 'tests.js',
    content: `// Run with "Run project tests" in the Run & Test panel.
// All other .js files are concatenated above this one, so calcTip() is in scope.
assert(calcTip(1000, 10, 2).tip === 100, 'tip on 1000 at 10% is 100');
assert(calcTip(1000, 10, 2).total === 1100, 'total includes the tip');
assert(calcTip(1000, 10, 2).perPerson === 550, 'per-person split of 1100 by 2');
assert(calcTip(0, 10, 2).tip === 0, 'zero bill gives zero tip');
assert(calcTip(1000, 0, 2).total === 1000, 'zero tip leaves the total unchanged');
assert(calcTip(100, 10, 0).perPerson === 110, 'people is clamped to at least 1');
console.log('calcTip(1200,10,4) =', JSON.stringify(calcTip(1200, 10, 4)));`,
  },
];
