/* ============================================================
   highlight.js — tiny, dependency-free syntax highlighter
   Escapes all text, then wraps tokens. Cheap enough for a low-end phone.
   ============================================================ */

export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const JS_KW = /^(const|let|var|function|return|if|else|for|while|do|switch|case|default|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|try|catch|finally|throw|await|async|yield|import|export|from|as|null|undefined|true|false|delete|void|static|get|set|interface|type|enum|implements|public|private|protected|readonly)$/;

function highlightJS(code) {
  const re = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|(`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")|\b(0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b([A-Za-z_$][\w$]*)\b/g;
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    if (m[1]) out += `<span class="tok-com">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="tok-str">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="tok-num">${esc(m[3])}</span>`;
    else if (m[4]) {
      const w = m[4];
      const after = code.slice(re.lastIndex);
      if (JS_KW.test(w)) out += `<span class="tok-key">${esc(w)}</span>`;
      else if (/^\s*\(/.test(after)) out += `<span class="tok-fn">${esc(w)}</span>`;
      else out += esc(w);
    }
    last = re.lastIndex;
  }
  return out + esc(code.slice(last));
}

function highlightAttrs(s) {
  const re = /([a-zA-Z_:][\w:.\-]*)(\s*=\s*)("[^"]*"|'[^']*')/g;
  let out = '', last = 0, m;
  while ((m = re.exec(s))) {
    out += esc(s.slice(last, m.index));
    out += `<span class="tok-attr">${esc(m[1])}</span>${esc(m[2])}<span class="tok-str">${esc(m[3])}</span>`;
    last = re.lastIndex;
  }
  return out + esc(s.slice(last));
}

function highlightHTML(code) {
  const re = /(<!--[\s\S]*?-->)|(<\/?[a-zA-Z][\w:-]*)([^>]*?)(\/?>)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    if (m[1]) {
      out += `<span class="tok-com">${esc(m[1])}</span>`;
    } else {
      const open = /^(<\/?)([\w:-]+)$/.exec(m[2]);
      if (open) {
        out += `<span class="tok-punc">${esc(open[1])}</span><span class="tok-tag">${esc(open[2])}</span>`;
      } else {
        out += esc(m[2]);
      }
      out += highlightAttrs(m[3] || '');
      out += `<span class="tok-punc">${esc(m[4])}</span>`;
    }
    last = re.lastIndex;
  }
  return out + esc(code.slice(last));
}

function highlightCSS(code) {
  const re = /(\/\*[\s\S]*?\*\/)|("[^"\n]*"|'[^'\n]*')|(#[0-9a-fA-F]{3,8}\b)|(@[a-zA-Z-]+)|(-?\d*\.?\d+(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|turn|fr|pt|ch|ex)?)|([a-zA-Z-][\w-]*)(?=\s*:)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    if (m[1]) out += `<span class="tok-com">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="tok-str">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="tok-num">${esc(m[3])}</span>`;
    else if (m[4]) out += `<span class="tok-key">${esc(m[4])}</span>`;
    else if (m[5]) out += `<span class="tok-num">${esc(m[5])}</span>`;
    else if (m[6]) out += `<span class="tok-attr">${esc(m[6])}</span>`;
    last = re.lastIndex;
  }
  return out + esc(code.slice(last));
}

function highlightJSON(code) {
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    if (m[1]) {
      if (m[2]) out += `<span class="tok-attr">${esc(m[1])}</span>${esc(m[2])}`;
      else out += `<span class="tok-str">${esc(m[1])}</span>`;
    } else if (m[3]) out += `<span class="tok-num">${esc(m[3])}</span>`;
    else if (m[4]) out += `<span class="tok-key">${esc(m[4])}</span>`;
    last = re.lastIndex;
  }
  return out + esc(code.slice(last));
}

function langFromPath(path) {
  const ext = (/\.([a-z0-9]+)$/i.exec(path || '') || [])[1]?.toLowerCase() || '';
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'].includes(ext)) return 'js';
  if (['html', 'htm', 'svg', 'xml', 'vue'].includes(ext)) return 'html';
  if (['css', 'scss', 'less'].includes(ext)) return 'css';
  if (ext === 'json') return 'json';
  return 'plain';
}

export function highlight(code, langOrPath) {
  const lang = langOrPath.includes('.') ? langFromPath(langOrPath) : langOrPath;
  const src = String(code ?? '');
  switch (lang) {
    case 'js': return highlightJS(src);
    case 'html': return highlightHTML(src);
    case 'css': return highlightCSS(src);
    case 'json': return highlightJSON(src);
    default: return esc(src);
  }
}

/* ---------- minimal, safe markdown for chat messages ---------- */

export function renderMarkdown(text) {
  const blocks = String(text ?? '').split(/```/);
  let html = '';
  blocks.forEach((block, i) => {
    if (i % 2 === 1) {
      // code fence
      const nl = block.indexOf('\n');
      const lang = nl > -1 ? block.slice(0, nl).trim() : '';
      const body = nl > -1 ? block.slice(nl + 1) : block;
      html += `<pre><code class="lang-${esc(lang || 'plain')}">${esc(body.replace(/\n$/, ''))}</code></pre>`;
    } else {
      html += inlineMd(block);
    }
  });
  return html;
}

function inlineMd(src) {
  let s = esc(src);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  // lists
  const lines = s.split('\n');
  let out = '', inList = false;
  for (const line of lines) {
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (!inList) { out += '<ul>'; inList = true; }
      out += `<li>${li[1]}</li>`;
    } else {
      if (inList) { out += '</ul>'; inList = false; }
      out += (line.trim() === '' ? '' : line + '\n');
    }
  }
  if (inList) out += '</ul>';
  // paragraphs
  return out.split(/\n{2,}/).map(p => {
    if (/^\s*<(ul|pre|h\d)/.test(p)) return p;
    const t = p.replace(/\n/g, '<br>').trim();
    return t ? `<p>${t}</p>` : '';
  }).join('');
}
