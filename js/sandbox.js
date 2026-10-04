/* ============================================================
   sandbox.js — Forge execution layer
   1) runInSandbox(code): runs JavaScript in an isolated iframe,
      captures console output, thrown errors and assert() results.
   2) buildPreviewHtml(fs, entry): assembles a self-contained page
      by inlining the project's CSS and JS files.
   ============================================================ */

/* ---------- isolated JS runner ---------- */

const HARNESS = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
(function(){
  var logs=[], errors=[], assertions=[];
  function fmt(v){
    try{
      if(typeof v==='string') return v;
      if(v instanceof Error) return v.name+': '+v.message;
      if(typeof v==='undefined') return 'undefined';
      if(typeof v==='function') return '[function '+(v.name||'anonymous')+']';
      if(v===null) return 'null';
      return JSON.stringify(v);
    }catch(e){ return String(v); }
  }
  ['log','info','warn','error','debug'].forEach(function(level){
    var orig = console[level] ? console[level].bind(console) : function(){};
    console[level] = function(){
      var args=[].slice.call(arguments);
      logs.push({ level: level==='debug'?'log':level, text: args.map(fmt).join(' ') });
      try{ orig.apply(null,args); }catch(e){}
    };
  });
  function assert(cond, msg){
    var ok = !!cond;
    assertions.push({ ok: ok, msg: msg || ('assertion '+(assertions.length+1)) });
    return ok;
  }
  window.assert = assert;
  window.onerror = function(m,s,l,c,err){ errors.push(fmt(err||m)); return false; };
  window.addEventListener('unhandledrejection', function(ev){
    errors.push('Unhandled promise rejection: '+fmt(ev.reason));
  });
  window.addEventListener('message', function(ev){
    var d = ev.data || {};
    if(d.type !== 'forge-run') return;
    logs=[]; errors=[]; assertions=[];
    try{
      var fn = new Function('assert','console','"use strict";\\n'+String(d.code));
      fn(assert, console);
    }catch(e){ errors.push(fmt(e)); }
    parent.postMessage({ type:'forge-result', id:d.id, logs:logs, errors:errors, assertions:assertions }, '*');
  });
  parent.postMessage({ type:'forge-ready' }, '*');
})();
<\/script></body></html>`;

let frameEl = null;
let frameReady = null;
const pending = new Map();
let seq = 0;

function ensureFrame() {
  if (frameReady) return frameReady;
  frameReady = new Promise((resolve, reject) => {
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:absolute;width:0;height:0;border:0;left:-9999px;visibility:hidden';
    const timeout = setTimeout(() => reject(new Error('Sandbox failed to start')), 8000);
    const onMsg = (ev) => {
      if (ev.source !== f.contentWindow) return;
      if (ev.data && ev.data.type === 'forge-ready') {
        clearTimeout(timeout);
        window.removeEventListener('message', onMsg);
        frameEl = f;
        resolve(f);
      }
    };
    window.addEventListener('message', onMsg);
    f.srcdoc = HARNESS;
    document.body.appendChild(f);
  });
  return frameReady;
}

// one global result listener
window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (!d || d.type !== 'forge-result') return;
  const entry = pending.get(d.id);
  if (!entry) return;
  pending.delete(d.id);
  clearTimeout(entry.timer);
  entry.resolve({ logs: d.logs || [], errors: d.errors || [], assertions: d.assertions || [] });
});

/**
 * Run JavaScript in the sandbox.
 * @returns {Promise<{logs, errors, assertions, timedOut}>}
 */
export async function runInSandbox(code, { timeout = 6000 } = {}) {
  let frame;
  try {
    frame = await ensureFrame();
  } catch (e) {
    return { logs: [], errors: [e.message], assertions: [], timedOut: false };
  }
  const id = `run-${++seq}-${Date.now()}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ logs: [], errors: [`Timed out after ${timeout}ms (possible infinite loop).`], assertions: [], timedOut: true });
    }, timeout);
    pending.set(id, { resolve, timer });
    try {
      frame.contentWindow.postMessage({ type: 'forge-run', id, code: String(code) }, '*');
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ logs: [], errors: [String(e)], assertions: [], timedOut: false });
    }
  });
}

/* ---------- preview assembly ---------- */

function resolveRef(ref, files) {
  if (!ref) return null;
  let r = String(ref).trim();
  if (/^(https?:)?\/\//i.test(r) || r.startsWith('data:') || r.startsWith('#')) return null;
  r = r.split('?')[0].split('#')[0].replace(/^\.?\//, '').replace(/^\/+/, '');
  return files.has(r) ? r : null;
}

const PREVIEW_BRIDGE = `<script>
(function(){
  function send(level,text){ try{ parent.postMessage({type:'forge-preview-log', level:level, text:String(text)},'*'); }catch(e){} }
  window.addEventListener('error', function(e){ send('error', (e.message||'Error')+(e.lineno?(' @ line '+e.lineno):'')); });
  window.addEventListener('unhandledrejection', function(e){ send('error','Unhandled promise rejection: '+(e.reason&&e.reason.message||e.reason)); });
  ['warn','error'].forEach(function(l){ var o=console[l]&&console[l].bind(console); console[l]=function(){ send(l,[].slice.call(arguments).join(' ')); if(o)try{o.apply(null,arguments)}catch(e){} }; });
})();
<\/script>`;

/**
 * Build a self-contained HTML document for the preview iframe by inlining
 * the project's linked stylesheets and scripts from the virtual filesystem.
 */
export function buildPreviewHtml(fs, entryPath) {
  const files = new Set(fs.list());
  const entry = entryPath && files.has(entryPath) ? entryPath : null;

  if (!entry) {
    return `<!doctype html><html><head><meta charset="utf-8">${PREVIEW_BRIDGE}
<style>body{font-family:system-ui;background:#0a0e1a;color:#e7ecf6;display:grid;place-items:center;height:100vh;margin:0;text-align:center}
code{background:#161d2e;padding:2px 6px;border-radius:5px}</style></head>
<body><div><h2>Nothing to preview</h2><p>Add an <code>index.html</code> file to the project, then refresh.</p></div></body></html>`;
  }

  const ext = (entry.split('.').pop() || '').toLowerCase();

  // Non-HTML entry files are wrapped so they can still be previewed.
  if (ext === 'css') {
    const css = fs.read(entry);
    return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><h1>Preview: ${entry}</h1><p>Stylesheet applied.</p><p class="demo">Sample text to show the styles.</p></body></html>`;
  }
  if (ext === 'js') {
    const js = fs.read(entry);
    return `<!doctype html><html><head><meta charset="utf-8">${PREVIEW_BRIDGE}
<style>body{font-family:ui-monospace,monospace;background:#0a0e1a;color:#e7ecf6;padding:16px;margin:0}</style></head>
<body><h3 style="font-family:system-ui">Preview: ${entry}</h3><pre id="out"></pre>
<script>var out=document.getElementById('out');var _log=console.log;console.log=function(){out.textContent+=[].slice.call(arguments).join(' ')+"\\n";_log.apply(console,arguments)};<\/script>
<script>${js}<\/script></body></html>`;
  }

  let html = fs.read(entry);

  // inline <link rel=stylesheet href=...>
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
    const m = /href\s*=\s*["']([^"']+)["']/i.exec(tag);
    const path = m ? resolveRef(m[1], files) : null;
    if (!path) return tag;
    return `<style data-forge-src="${path}">\n${fs.read(path)}\n</style>`;
  });

  // inline <script src=...></script>
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (whole, attrs, body) => {
    const m = /src\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (!m) return whole;
    const path = resolveRef(m[1], files);
    if (!path) return whole;
    const keepType = /type\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const typeAttr = keepType ? ` type="${keepType[1]}"` : '';
    return `<script${typeAttr} data-forge-src="${path}">\n${fs.read(path)}\n</script>`;
  });

  // inject bridge after <head>
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + PREVIEW_BRIDGE);
  else html = PREVIEW_BRIDGE + html;

  return html;
}
