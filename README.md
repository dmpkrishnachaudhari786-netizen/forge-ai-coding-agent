# Forge — AI Coding Agent

A real AI coding agent that runs **entirely in your browser** as an installable PWA.
You describe what to build; Forge plans, picks tools, writes real files into a project
filesystem, renders a live preview, runs tests in a sandbox, and debugs — in a loop.

No server, no build step, no account. The only external dependency is the model API,
and you supply that key yourself.

---

## Run it

The app needs to be served over `http://localhost` or `https://` (PWAs and ES modules
do not work from `file://`).

```bash
# any static server works
python3 -m http.server 8080
# then open http://localhost:8080
```

## Connect a model

Open **Settings** (the gear in the top bar) and fill in:

| Field | Notes |
|---|---|
| Provider | OpenAI-compatible, Sarvam AI, Anthropic (Claude), or Google Gemini |
| Base URL | Pre-filled per provider; change it for Groq, OpenRouter, Together, a local server, etc. |
| Model | e.g. `gpt-4o-mini`, `sarvam-m`, `claude-3-5-sonnet-latest`, `gemini-2.0-flash` |
| API key | **Your own key.** Stored only in this browser's `localStorage`. Never bundled with the app. |

Press **Test connection** to verify before you run a task.

> **Note on keys in the browser.** Forge is deliberately serverless, so the key lives
> in your browser and requests go straight from the page to the provider. That is fine
> for a personal tool, but do not deploy this publicly with a shared key. For a
> multi-user deployment, put a small server-side proxy in front of the model call.

## What actually works

- **Virtual filesystem** — files persist in IndexedDB (falls back to localStorage).
  Create, rename, delete, import and export the whole project as JSON.
- **Code editor** — line numbers, syntax highlighting, tab/auto-indent, `Ctrl/Cmd+S`.
- **Live preview** — linked CSS and JS are inlined from the project, so a multi-file
  site renders correctly in a sandboxed iframe. Preview errors are surfaced.
- **Test runner** — JavaScript runs in an isolated sandbox iframe with `assert()`,
  console capture, error capture and a timeout guard. "Run project tests" concatenates
  your plain `.js` files with a chosen test file, so tests see the real project code.
- **The agent** — a real loop: it calls one tool per turn and observes the result.
  Tools: `list_files`, `read_file`, `write_file`, `delete_file`, `run_tests`,
  `set_preview`, `finish`. It is instructed to verify with tests before finishing,
  and a failing `ReferenceError` returns a self-correcting hint.
- **Installable PWA** — manifest + service worker, works offline once loaded
  (model calls still need a network connection).

## Limitations

- The project filesystem stores **text** files. Binary assets (images, fonts) are not
  part of the project; use external URLs in your HTML if you need them.
- The sandbox runs code in an iframe with `allow-scripts` — a solid isolation boundary
  for generated code, but it is not a hardened security sandbox for hostile code.
- Streaming is implemented for all four providers. If a provider blocks browser
  requests (CORS), use one that allows them or add your own proxy.

## Files

```
index.html            app shell
styles.css            design system + responsive layout
js/app.js             UI wiring
js/agent.js           agent loop + tools
js/providers.js       OpenAI / Sarvam / Anthropic / Gemini streaming adapters
js/fs.js              virtual filesystem (IndexedDB)
js/sandbox.js         isolated runner + preview builder
js/highlight.js       syntax highlighter + chat markdown
sw.js                 service worker (offline shell)
manifest.webmanifest  PWA manifest
icon-192.png, icon-512.png, icons/favicon.svg
```
