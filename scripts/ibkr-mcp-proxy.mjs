#!/usr/bin/env node
/**
 * Zero-dependency MCP stdio proxy for Interactive Brokers (IBKR) official remote MCP.
 * Handles OAuth 2.0 + PKCE + Dynamic Client Registration with non-blocking 127.0.0.1
 * loopback callback capture, automatic token refresh, and Streamable HTTP forwarding.
 */

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import readline from "node:readline";

const RESOURCE_URL = "https://api.ibkr.com/v1/api/mcp-public";
const PROTECTED_RESOURCE_METADATA_URL = `${RESOURCE_URL}/.well-known/oauth-protected-resource`;
const DEFAULT_AUTH_SERVER_METADATA_URL = "https://api.ibkr.com/.well-known/oauth-authorization-server";
const DEFAULT_SCOPE = "mcp.read";
const OAUTH_TIMEOUT_MS = 300_000;
const REFRESH_SKEW_MS = 60_000;
const FETCH_TIMEOUT_MS = 30_000;
const PROXY_VERSION = "0.4.0";

const TRUSTED_IBKR_HOSTS = new Set(["api.ibkr.com", "ibkr.com", "interactivebrokers.com"]);
const MUTATING_TOOL_NAME_RE =
  /^(submit|place|modify|cancel|create|delete|remove|update|edit|set|answer|provide|transfer|withdraw|deposit|execute|close|liquidate|preview_order)(_|$)/i;

function parseCliArgs(argv) {
  let dataDir = path.join(os.homedir(), ".gemini", "antigravity", "plugin_data", "ibkr");
  let scope = DEFAULT_SCOPE;
  let previewCallbackPath = null;
  let allowWrite = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--data-dir" && argv[i + 1]) {
      dataDir = argv[++i];
    } else if (argv[i] === "--scope" && argv[i + 1]) {
      scope = argv[++i];
    } else if (argv[i] === "--preview-callback" && argv[i + 1]) {
      previewCallbackPath = argv[++i];
    } else if (argv[i] === "--allow-write") {
      allowWrite = true;
    }
  }
  return { dataDir, scope, previewCallbackPath, allowWrite };
}

const parsedArgs = parseCliArgs(process.argv.slice(2));
const DATA_DIR = parsedArgs.dataDir;
const ALLOW_WRITE = Boolean(parsedArgs.allowWrite);
const PREVIEW_CALLBACK_PATH = parsedArgs.previewCallbackPath;
const REQUESTED_CLI_SCOPE = String(parsedArgs.scope || DEFAULT_SCOPE).trim();
if (!ALLOW_WRITE && REQUESTED_CLI_SCOPE !== DEFAULT_SCOPE) {
  process.stderr.write(
    `[ibkr-mcp-proxy] Refusing --scope "${REQUESTED_CLI_SCOPE}" without --allow-write (read-only '${DEFAULT_SCOPE}' is enforced by default).\n`
  );
  process.exit(2);
}
const DEFAULT_REQUESTED_SCOPE = ALLOW_WRITE ? REQUESTED_CLI_SCOPE : DEFAULT_SCOPE;
const TOKEN_FILE = path.join(DATA_DIR, "oauth_tokens.json");

function isMutatingToolName(name) {
  return typeof name === "string" && MUTATING_TOOL_NAME_RE.test(name.trim());
}

function filterExposedTools(tools) {
  if (!Array.isArray(tools)) return [];
  return ALLOW_WRITE ? tools : tools.filter((t) => !isMutatingToolName(t?.name));
}

const BUILTIN_TOOLS = [
  {
    name: "ibkr_connect",
    description:
      "Start 1-click Interactive Brokers browser OAuth 2.0 (PKCE) with automatic local callback capture. Enforces read-only 'mcp.read' scope unless the proxy was launched with --allow-write.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description:
            "OAuth scope (defaults to read-only 'mcp.read'; non-read scopes require launching the proxy with --allow-write)."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "ibkr_auth_status",
    description:
      "Check Interactive Brokers OAuth connection state, granted scope, read-only enforcement state, pending login status, last auth error, token expiration, and cached upstream tool count without revealing secrets.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "ibkr_list_tools",
    description:
      "List all live tools exposed by the connected Interactive Brokers MCP server along with descriptions and parameter schemas.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "ibkr_call",
    description:
      "Forward a tool call directly to the connected Interactive Brokers MCP server.",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: {
          type: "string",
          description: "Exact name of the upstream IBKR MCP tool to invoke."
        },
        arguments: {
          type: "object",
          description: "JSON arguments object expected by the upstream IBKR tool.",
          additionalProperties: true
        }
      },
      required: ["tool_name"],
      additionalProperties: false
    }
  },
  {
    name: "ibkr_sign_out",
    description:
      "Revoke stored Interactive Brokers OAuth tokens (best-effort) and remove local credentials.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }
];

const BUILTIN_TOOL_NAMES = new Set(BUILTIN_TOOLS.map((t) => t.name));

let upstreamSessionId = null;
let upstreamProtocolVersion = "2025-03-26";
let cachedUpstreamTools = [];
let nextRpcId = 1;
let refreshInFlight = null;
let sessionInitInFlight = null;
let pendingLogin = null;
let lastAuthError = null;

function logErr(msg) {
  process.stderr.write(`[ibkr-mcp-proxy] ${msg}\n`);
}

function writeRpc(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function sendResult(id, result) {
  if (id === undefined || id === null) return;
  writeRpc({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  if (id === undefined || id === null) return;
  const error = data !== undefined ? { code, message, data } : { code, message };
  writeRpc({ jsonrpc: "2.0", id, error });
}

function notifyToolsChanged() {
  writeRpc({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
}

function base64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function sanitizeErrorBody(text) {
  return String(text ?? "")
    .replace(/"(access_token|refresh_token|id_token|client_secret)"\s*:\s*"[^"]*"/gi, '"$1":"[REDACTED]"')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 200);
}

function isTrustedIbkrHostname(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  return (
    TRUSTED_IBKR_HOSTS.has(host) ||
    host.endsWith(".ibkr.com") ||
    host.endsWith(".interactivebrokers.com")
  );
}

function assertTrustedIbkrHttpsUrl(rawUrl, label = "URL") {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new Error(`Invalid ${label}: expected non-empty HTTPS URL.`);
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error(`Invalid ${label}: malformed URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Rejected ${label}: HTTPS is required.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Rejected ${label}: embedded credentials in URL are not allowed.`);
  }
  if (!isTrustedIbkrHostname(parsed.hostname)) {
    throw new Error(`Rejected untrusted ${label} host: ${parsed.hostname}`);
  }
  return parsed.toString();
}

function timingSafeEqualStrings(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal =
    options.signal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([options.signal, timeoutSignal])
      : options.signal || timeoutSignal;
  return fetch(url, { ...options, signal });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const BRAND_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none"><rect x="12" y="12" width="104" height="104" rx="24" fill="#FFFFFF"/><rect x="12.75" y="12.75" width="102.5" height="102.5" rx="23.25" stroke="#CBD5E1" stroke-width="1.5"/><path d="M38 65L74 66L38 100V65Z" fill="#9F1239"/><path d="M38 28L74 66L38 67V28Z" fill="#D81E2B"/><circle cx="80" cy="48" r="10.5" fill="#E11D48"/></svg>`;
const FAVICON_DATA_URI = `data:image/svg+xml,${encodeURIComponent(BRAND_ICON_SVG)}`;

function formatScopeLabel(scope) {
  if (!scope) return null;
  if (scope.trim() === "mcp.read") return "Read-Only · mcp.read";
  return `Scope · ${scope}`;
}

function renderCallbackHtml({ ok, title, subtitle, scope = null }) {
  const statusLabel = ok ? "Connected" : "Action Required";
  const scopeLabel = formatScopeLabel(scope);
  const statusBadgeSvg = ok
    ? `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5.5 10.25L8.5 13.25L14.75 7" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M6.5 6.5L13.5 13.5M13.5 6.5L6.5 13.5" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round"/></svg>`;
  const lockIconSvg = `<svg class="pill-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3.25" y="7.25" width="9.5" height="6.5" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M5.25 7.25V5.25C5.25 3.73 6.48 2.5 8 2.5C9.52 2.5 10.75 3.73 10.75 5.25V7.25" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  const scopePillHtml = scopeLabel
    ? `<span class="pill pill-scope">${lockIconSvg}${escapeHtml(scopeLabel)}</span>`
    : "";
  const cleanRoute = ok ? "/connected" : "/auth-error";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} — Interactive Brokers · Antigravity</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URI}">
<link rel="alternate icon" type="image/svg+xml" href="/favicon.svg">
<style>
  :root {
    --bg: #f8fafc;
    --bg-accent-1: rgba(216, 30, 43, 0.08);
    --bg-accent-2: rgba(22, 163, 74, 0.08);
    --card-bg: #ffffff;
    --card-border: #e2e8f0;
    --card-shadow: 0 24px 48px -12px rgba(15, 23, 42, 0.12), 0 4px 12px rgba(15, 23, 42, 0.04);
    --text-primary: #0f172a;
    --text-secondary: #475569;
    --text-muted: #64748b;
    --divider: #f1f5f9;
    --pill-status-bg: ${ok ? "#ecfdf5" : "#fef2f2"};
    --pill-status-border: ${ok ? "#bbf7d0" : "#fecaca"};
    --pill-status-fg: ${ok ? "#15803d" : "#b91c1c"};
    --pill-dot: ${ok ? "#16a34a" : "#dc2626"};
    --pill-scope-bg: #f1f5f9;
    --pill-scope-border: #e2e8f0;
    --pill-scope-fg: #334155;
    --btn-bg: #0f172a;
    --btn-bg-hover: #1e293b;
    --btn-fg: #ffffff;
    --ring-bg: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b1120;
      --bg-accent-1: rgba(216, 30, 43, 0.14);
      --bg-accent-2: rgba(34, 197, 94, 0.10);
      --card-bg: #111827;
      --card-border: #1f2937;
      --card-shadow: 0 28px 60px -12px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.03);
      --text-primary: #f8fafc;
      --text-secondary: #cbd5e1;
      --text-muted: #94a3b8;
      --divider: #1f2937;
      --pill-status-bg: ${ok ? "rgba(22, 163, 74, 0.16)" : "rgba(220, 38, 38, 0.16)"};
      --pill-status-border: ${ok ? "rgba(34, 197, 94, 0.35)" : "rgba(248, 113, 113, 0.35)"};
      --pill-status-fg: ${ok ? "#4ade80" : "#fca5a5"};
      --pill-dot: ${ok ? "#22c55e" : "#ef4444"};
      --pill-scope-bg: #1e293b;
      --pill-scope-border: #334155;
      --pill-scope-fg: #e2e8f0;
      --btn-bg: #f8fafc;
      --btn-bg-hover: #e2e8f0;
      --btn-fg: #0f172a;
      --ring-bg: #111827;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
    color: var(--text-primary);
    background-color: var(--bg);
    background-image:
      radial-gradient(640px 360px at 50% 0%, var(--bg-accent-1), transparent 70%),
      radial-gradient(560px 340px at 50% 100%, var(--bg-accent-2), transparent 70%);
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%;
    max-width: 440px;
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: 20px;
    padding: 36px 32px 28px;
    box-shadow: var(--card-shadow);
    text-align: center;
  }
  .brand-wrap {
    position: relative;
    width: 64px;
    height: 64px;
    margin: 0 auto 20px;
  }
  .brand-icon {
    width: 64px;
    height: 64px;
    border-radius: 16px;
    overflow: hidden;
    box-shadow: 0 10px 24px rgba(15, 23, 42, 0.12);
  }
  .brand-icon svg { width: 100%; height: 100%; display: block; }
  .status-emblem {
    position: absolute;
    right: -4px;
    bottom: -4px;
    width: 24px;
    height: 24px;
    border-radius: 999px;
    background: var(--pill-dot);
    border: 2.5px solid var(--ring-bg);
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18);
  }
  .status-emblem svg { width: 13px; height: 13px; }
  .eyebrow {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin: 0 0 10px;
  }
  h1 {
    margin: 0 0 10px;
    font-size: 22px;
    font-weight: 700;
    line-height: 1.25;
    letter-spacing: -0.02em;
  }
  .subtitle {
    margin: 0 0 20px;
    font-size: 14.5px;
    line-height: 1.55;
    color: var(--text-secondary);
  }
  .pills {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-bottom: 24px;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    line-height: 1.2;
  }
  .pill-status {
    background: var(--pill-status-bg);
    border: 1px solid var(--pill-status-border);
    color: var(--pill-status-fg);
  }
  .pill-dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--pill-dot);
  }
  .pill-scope {
    background: var(--pill-scope-bg);
    border: 1px solid var(--pill-scope-border);
    color: var(--pill-scope-fg);
  }
  .pill-icon { width: 13px; height: 13px; opacity: 0.85; }
  .actions {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }
  .btn-close {
    width: 100%;
    appearance: none;
    border: none;
    border-radius: 12px;
    padding: 12px 18px;
    font-size: 14px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    background: var(--btn-bg);
    color: var(--btn-fg);
    transition: background-color 0.15s ease, transform 0.1s ease;
  }
  .btn-close:hover { background: var(--btn-bg-hover); }
  .btn-close:active { transform: scale(0.99); }
  .close-hint {
    display: none;
    font-size: 12px;
    line-height: 1.45;
    color: var(--text-muted);
    margin: 0;
  }
  .close-hint.visible { display: block; }
  .footer {
    margin-top: 24px;
    padding-top: 16px;
    border-top: 1px solid var(--divider);
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-muted);
  }
</style>
</head>
<body>
  <main class="card">
    <div class="brand-wrap">
      <div class="brand-icon">${BRAND_ICON_SVG}</div>
      <div class="status-emblem">${statusBadgeSvg}</div>
    </div>
    <p class="eyebrow">Interactive Brokers &middot; Antigravity</p>
    <h1>${escapeHtml(title)}</h1>
    <p class="subtitle">${escapeHtml(subtitle)}</p>
    <div class="pills">
      <span class="pill pill-status"><span class="pill-dot"></span>${escapeHtml(statusLabel)}</span>
      ${scopePillHtml}
    </div>
    <div class="actions">
      <button type="button" class="btn-close" id="close-tab-btn">Close Tab</button>
      <p class="close-hint" id="close-hint">Browser security kept this tab open &mdash; press Cmd+W or Ctrl+W to close it and return to Antigravity.</p>
    </div>
    <footer class="footer">
      Credentials remain on Interactive Brokers. Local tokens use 0600 permissions; revoke anytime in IBKR Client Portal.
    </footer>
  </main>
  <script>
    try {
      window.history.replaceState({}, document.title, "${cleanRoute}");
    } catch {}
    (function () {
      var btn = document.getElementById("close-tab-btn");
      var hint = document.getElementById("close-hint");
      if (!btn) return;
      btn.addEventListener("click", function () {
        window.close();
        setTimeout(function () {
          if (!window.closed && hint) {
            hint.classList.add("visible");
          }
        }, 160);
      });
    })();
  </script>
</body>
</html>`;
}

function sendCallbackHtml(res, statusCode, htmlOpts) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  });
  res.end(renderCallbackHtml(htmlOpts));
}

function assertNotSymlink(targetPath) {
  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symlink at protected path: ${targetPath}`);
    }
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
}

function clearPendingLogin() {
  if (!pendingLogin) return;
  const active = pendingLogin;
  pendingLogin = null;
  if (active.timeoutHandle) {
    clearTimeout(active.timeoutHandle);
  }
  try {
    active.server?.closeAllConnections?.();
    active.server?.close();
  } catch {
    // Ignore close errors.
  }
}

function readTokens() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    assertNotSymlink(TOKEN_FILE);
    const raw = fs.readFileSync(TOKEN_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.access_token) return null;
    return parsed;
  } catch (err) {
    logErr(`Failed to read token file: ${err.message}`);
    return null;
  }
}

function saveTokens(tokenObj) {
  assertNotSymlink(DATA_DIR);
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  assertNotSymlink(DATA_DIR);
  try {
    fs.chmodSync(DATA_DIR, 0o700);
  } catch {
    // Ignore chmod failures on filesystems that do not support POSIX permissions.
  }
  assertNotSymlink(TOKEN_FILE);
  const tmpFile = `${TOKEN_FILE}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(tokenObj, null, 2), { mode: 0o600 });
    fs.renameSync(tmpFile, TOKEN_FILE);
  } catch (err) {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup failures.
    }
    throw err;
  }
  try {
    fs.chmodSync(TOKEN_FILE, 0o600);
  } catch {
    // Ignore chmod failures on non-POSIX filesystems.
  }
}

function deleteTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      fs.unlinkSync(TOKEN_FILE);
    }
  } catch (err) {
    logErr(`Failed to delete token file: ${err.message}`);
  }
}

async function tryOpenBrowser(url) {
  let safeUrl;
  try {
    safeUrl = assertTrustedIbkrHttpsUrl(url, "authorization_url");
  } catch (err) {
    logErr(`Refused browser launch: ${err.message}`);
    return { launched: false, error: err.message };
  }

  return new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      const platform = process.platform;
      if (platform === "darwin") {
        child = spawn("open", [safeUrl], { detached: true, stdio: "ignore" });
      } else if (platform === "win32") {
        child = spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            "Start-Process -FilePath $env:IBKR_AUTH_URL"
          ],
          {
            detached: true,
            stdio: "ignore",
            env: { ...process.env, IBKR_AUTH_URL: safeUrl }
          }
        );
      } else {
        child = spawn("xdg-open", [safeUrl], { detached: true, stdio: "ignore" });
      }
    } catch (err) {
      resolve({ launched: false, error: err.message });
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.unref();
      } catch {
        // Ignore unref failures.
      }
      resolve({ launched: true });
    }, 150);

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logErr(`Browser launch error: ${err.message}`);
      resolve({ launched: false, error: err.message });
    });

    child.once("exit", (code) => {
      if (settled) return;
      if (code !== null && code !== 0) {
        settled = true;
        clearTimeout(timer);
        logErr(`Browser launcher exited with code ${code}`);
        resolve({ launched: false, error: `Browser launcher exited with code ${code}` });
      }
    });
  });
}

async function discoverOAuthMetadata() {
  let authServerBase = null;
  try {
    const prRes = await fetchWithTimeout(PROTECTED_RESOURCE_METADATA_URL, {
      headers: { Accept: "application/json" }
    });
    if (prRes.ok) {
      const prJson = await prRes.json();
      if (Array.isArray(prJson.authorization_servers) && prJson.authorization_servers[0]) {
        const candidateBase = String(prJson.authorization_servers[0]).replace(/\/+$/, "");
        authServerBase = assertTrustedIbkrHttpsUrl(candidateBase, "authorization_server").replace(/\/+$/, "");
      }
    }
  } catch (err) {
    logErr(`Protected resource discovery fallback: ${err.message}`);
  }

  const asMetadataUrl = assertTrustedIbkrHttpsUrl(
    authServerBase
      ? `${authServerBase}/.well-known/oauth-authorization-server`
      : DEFAULT_AUTH_SERVER_METADATA_URL,
    "authorization_server_metadata"
  );

  const asRes = await fetchWithTimeout(asMetadataUrl, { headers: { Accept: "application/json" } });
  if (!asRes.ok) {
    throw new Error(`OAuth authorization server metadata fetch failed (${asRes.status})`);
  }
  const meta = await asRes.json();
  if (!meta.authorization_endpoint || !meta.token_endpoint || !meta.registration_endpoint) {
    throw new Error("OAuth authorization server metadata missing required endpoints");
  }
  meta.authorization_endpoint = assertTrustedIbkrHttpsUrl(
    meta.authorization_endpoint,
    "authorization_endpoint"
  );
  meta.token_endpoint = assertTrustedIbkrHttpsUrl(meta.token_endpoint, "token_endpoint");
  meta.registration_endpoint = assertTrustedIbkrHttpsUrl(
    meta.registration_endpoint,
    "registration_endpoint"
  );
  if (meta.revocation_endpoint) {
    meta.revocation_endpoint = assertTrustedIbkrHttpsUrl(
      meta.revocation_endpoint,
      "revocation_endpoint"
    );
  }
  if (meta.issuer) {
    meta.issuer = assertTrustedIbkrHttpsUrl(meta.issuer, "issuer").replace(/\/+$/, "");
  }
  return meta;
}

async function refreshAccessToken(tokens) {
  if (!tokens?.refresh_token || !tokens?.token_endpoint || !tokens?.client_id) {
    throw new Error("No refresh token available; run ibkr_connect to re-authenticate.");
  }
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const tokenEndpoint = assertTrustedIbkrHttpsUrl(tokens.token_endpoint, "token_endpoint");
    const resourceUrl = assertTrustedIbkrHttpsUrl(tokens.resource || RESOURCE_URL, "resource");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: tokens.client_id,
      resource: resourceUrl
    });
    const res = await fetchWithTimeout(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: body.toString()
    });
    if (!res.ok) {
      const errText = sanitizeErrorBody(await res.text());
      if (res.status === 400 || res.status === 401) {
        deleteTokens();
        upstreamSessionId = null;
        cachedUpstreamTools = [];
      }
      throw new Error(`Token refresh failed (${res.status}): ${errText}`);
    }
    const refreshed = await res.json();
    const updated = {
      ...tokens,
      token_endpoint: tokenEndpoint,
      resource: resourceUrl,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token || tokens.refresh_token,
      token_type: refreshed.token_type || tokens.token_type || "Bearer",
      scope: refreshed.scope || tokens.scope,
      expires_at: Date.now() + Number(refreshed.expires_in || 3600) * 1000,
      updated_at: new Date().toISOString()
    };
    saveTokens(updated);
    return updated;
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function getValidTokens({ forceRefresh = false } = {}) {
  const tokens = readTokens();
  if (!tokens) return null;
  const isExpiring = !tokens.expires_at || Date.now() + REFRESH_SKEW_MS >= Number(tokens.expires_at);
  if (forceRefresh || isExpiring) {
    if (tokens.refresh_token) {
      return refreshAccessToken(tokens);
    }
    if (tokens.expires_at && Date.now() >= Number(tokens.expires_at)) {
      return null;
    }
  }
  return tokens;
}

function parseSseMessages(rawText) {
  const messages = [];
  const blocks = rawText.replace(/\r\n/g, "\n").split("\n\n");
  for (const block of blocks) {
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n").trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      messages.push(JSON.parse(payload));
    } catch {
      // Skip non-JSON SSE control payloads.
    }
  }
  return messages;
}

async function sendUpstreamRpc(method, params, { isNotification = false, allowReinit = true, allowRefresh = true } = {}) {
  const tokens = await getValidTokens();
  if (!tokens) {
    throw new Error("Not connected to Interactive Brokers. Run ibkr_connect first.");
  }

  const rpcId = isNotification ? undefined : nextRpcId++;
  const payload = isNotification
    ? { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }
    : { jsonrpc: "2.0", id: rpcId, method, ...(params !== undefined ? { params } : {}) };

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${tokens.access_token}`
  };
  if (upstreamSessionId) {
    headers["Mcp-Session-Id"] = upstreamSessionId;
  }
  if (method !== "initialize" && upstreamProtocolVersion) {
    headers["MCP-Protocol-Version"] = upstreamProtocolVersion;
  }

  const res = await fetchWithTimeout(RESOURCE_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  if (res.status === 401 && allowRefresh && tokens.refresh_token) {
    await getValidTokens({ forceRefresh: true });
    return sendUpstreamRpc(method, params, { isNotification, allowReinit, allowRefresh: false });
  }

  if ((res.status === 404 || res.status === 400) && upstreamSessionId && method !== "initialize" && allowReinit) {
    upstreamSessionId = null;
    await ensureUpstreamSession({ force: true });
    return sendUpstreamRpc(method, params, { isNotification, allowReinit: false, allowRefresh });
  }

  const returnedSessionId = res.headers.get("mcp-session-id");
  if (returnedSessionId) {
    upstreamSessionId = returnedSessionId;
  }

  if (isNotification && (res.status === 202 || res.status === 204)) {
    return null;
  }

  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const bodyText = await res.text();

  if (!res.ok) {
    throw new Error(`Upstream IBKR MCP HTTP ${res.status}: ${sanitizeErrorBody(bodyText)}`);
  }

  if (isNotification) return null;

  let rpcMsg = null;
  if (contentType.includes("text/event-stream")) {
    const events = parseSseMessages(bodyText);
    rpcMsg =
      events.find((m) => m && m.id === rpcId) ||
      [...events].reverse().find((m) => m && (m.result !== undefined || m.error !== undefined));
  } else if (bodyText.trim()) {
    const parsed = JSON.parse(bodyText);
    if (Array.isArray(parsed)) {
      rpcMsg = parsed.find((m) => m && m.id === rpcId) || parsed[parsed.length - 1];
    } else {
      rpcMsg = parsed;
    }
  }

  if (!rpcMsg) {
    throw new Error(`Empty or unparseable response from IBKR MCP for ${method}`);
  }
  if (rpcMsg.error) {
    const msg = rpcMsg.error.message || JSON.stringify(rpcMsg.error);
    throw new Error(`IBKR MCP error (${rpcMsg.error.code ?? "unknown"}): ${msg}`);
  }
  return rpcMsg.result;
}

async function ensureUpstreamSession({ force = false } = {}) {
  if (upstreamSessionId && !force) return upstreamSessionId;
  if (sessionInitInFlight && !force) return sessionInitInFlight;

  sessionInitInFlight = (async () => {
    const initResult = await sendUpstreamRpc(
      "initialize",
      {
        protocolVersion: upstreamProtocolVersion,
        capabilities: {},
        clientInfo: { name: "antigravity-ibkr-proxy", version: PROXY_VERSION }
      },
      { allowReinit: false }
    );
    if (initResult?.protocolVersion) {
      upstreamProtocolVersion = initResult.protocolVersion;
    }
    await sendUpstreamRpc("notifications/initialized", {}, { isNotification: true, allowReinit: false });
    return upstreamSessionId;
  })();

  try {
    return await sessionInitInFlight;
  } finally {
    sessionInitInFlight = null;
  }
}

async function fetchUpstreamTools() {
  await ensureUpstreamSession();
  const allTools = [];
  let cursor;
  do {
    const params = cursor ? { cursor } : {};
    const res = await sendUpstreamRpc("tools/list", params);
    if (Array.isArray(res?.tools)) {
      allTools.push(...res.tools);
    }
    cursor = res?.nextCursor;
  } while (cursor);
  cachedUpstreamTools = allTools;
  return allTools;
}

async function startOAuthConnect(requestedScope) {
  const normalizedRequested =
    requestedScope === undefined || requestedScope === null ? "" : String(requestedScope).trim();
  const scope = normalizedRequested || DEFAULT_REQUESTED_SCOPE;
  if (!ALLOW_WRITE && scope !== DEFAULT_SCOPE) {
    throw new Error(
      `Read-only mode is enforced by default; only '${DEFAULT_SCOPE}' scope is allowed unless the proxy is launched with --allow-write.`
    );
  }

  clearPendingLogin();
  lastAuthError = null;

  const meta = await discoverOAuthMetadata();

  const codeVerifier = base64Url(crypto.randomBytes(32));
  const codeChallenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
  const expectedState = crypto.randomBytes(16).toString("hex");

  let clientId = null;
  let redirectUri = null;
  let server = null;
  let callbackHandled = false;

  server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "GET") {
        res.writeHead(405, {
          Allow: "GET",
          "Content-Type": "text/plain",
          "Cache-Control": "no-store"
        });
        res.end("Method Not Allowed");
        return;
      }

      const boundAddress = server.address();
      const boundPort = boundAddress && typeof boundAddress !== "string" ? boundAddress.port : null;
      const expectedHost = boundPort ? `127.0.0.1:${boundPort}` : null;
      const hostHeader = String(req.headers.host || "").toLowerCase();
      if (!expectedHost || hostHeader !== expectedHost) {
        res.writeHead(403, {
          "Content-Type": "text/plain",
          "Cache-Control": "no-store"
        });
        res.end("Forbidden");
        return;
      }

      const reqUrl = new URL(req.url || "/", `http://${expectedHost}`);
      if (reqUrl.pathname === "/favicon.ico" || reqUrl.pathname === "/favicon.svg") {
        res.writeHead(200, {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        });
        res.end(BRAND_ICON_SVG);
        return;
      }
      if (reqUrl.pathname !== "/callback") {
        res.writeHead(404, {
          "Content-Type": "text/plain",
          "Cache-Control": "no-store"
        });
        res.end("Not Found");
        return;
      }

      if (callbackHandled) {
        sendCallbackHtml(res, 409, {
          ok: false,
          title: "Callback Already Processed",
          subtitle: "This authorization callback has already been handled. Please retry ibkr_connect if needed."
        });
        return;
      }
      callbackHandled = true;

      const oauthError = reqUrl.searchParams.get("error");
      const oauthErrorDesc = reqUrl.searchParams.get("error_description");
      const code = reqUrl.searchParams.get("code");
      const state = reqUrl.searchParams.get("state");
      const iss = reqUrl.searchParams.get("iss");

      if (oauthError) {
        const safeErr = sanitizeErrorBody(oauthError);
        const safeDesc = oauthErrorDesc ? sanitizeErrorBody(oauthErrorDesc) : "";
        const msg = (safeDesc ? `${safeErr}: ${safeDesc}` : safeErr).slice(0, 200);
        lastAuthError = `OAuth authorization failed: ${msg}`;
        sendCallbackHtml(res, 400, {
          ok: false,
          title: "IBKR Sign-In Denied",
          subtitle: msg
        });
        clearPendingLogin();
        return;
      }

      if (!timingSafeEqualStrings(state, expectedState) || !code) {
        lastAuthError = "OAuth callback failed state or code validation.";
        sendCallbackHtml(res, 400, {
          ok: false,
          title: "Invalid OAuth Callback",
          subtitle: "State mismatch or missing authorization code. Please retry ibkr_connect."
        });
        clearPendingLogin();
        return;
      }

      if (iss) {
        let normalizedIss;
        try {
          normalizedIss = assertTrustedIbkrHttpsUrl(iss, "iss").replace(/\/+$/, "");
        } catch (issErr) {
          lastAuthError = `OAuth callback issuer rejected: ${issErr.message}`;
          sendCallbackHtml(res, 400, {
            ok: false,
            title: "Untrusted Authorization Issuer",
            subtitle: "The OAuth callback issuer parameter did not match a trusted Interactive Brokers URL."
          });
          clearPendingLogin();
          return;
        }
        if (meta.issuer && normalizedIss !== meta.issuer) {
          lastAuthError = `OAuth callback issuer mismatch (${normalizedIss}).`;
          sendCallbackHtml(res, 400, {
            ok: false,
            title: "Authorization Server Mismatch",
            subtitle: "Callback issuer did not match Interactive Brokers metadata. Please retry ibkr_connect."
          });
          clearPendingLogin();
          return;
        }
      }

      const tokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: codeVerifier,
        resource: RESOURCE_URL
      });

      const tokRes = await fetchWithTimeout(meta.token_endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        },
        body: tokenBody.toString()
      });

      if (!tokRes.ok) {
        const tokErr = sanitizeErrorBody(await tokRes.text());
        lastAuthError = `Token exchange failed (${tokRes.status}): ${tokErr}`;
        sendCallbackHtml(res, 502, {
          ok: false,
          title: "Token Exchange Failed",
          subtitle: `IBKR token endpoint returned HTTP ${tokRes.status}. Please retry.`
        });
        clearPendingLogin();
        return;
      }

      const tokenData = await tokRes.json();
      const persisted = {
        client_id: clientId,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || null,
        token_type: tokenData.token_type || "Bearer",
        scope: tokenData.scope || scope,
        expires_at: Date.now() + Number(tokenData.expires_in || 3600) * 1000,
        resource: RESOURCE_URL,
        token_endpoint: meta.token_endpoint,
        revocation_endpoint: meta.revocation_endpoint || null,
        updated_at: new Date().toISOString()
      };
      saveTokens(persisted);
      lastAuthError = null;

      sendCallbackHtml(res, 200, {
        ok: true,
        title: "Connected to Interactive Brokers",
        subtitle: "Your Interactive Brokers session is active in Antigravity. You can safely close this tab.",
        scope: persisted.scope
      });
      clearPendingLogin();

      upstreamSessionId = null;
      try {
        await fetchUpstreamTools();
        notifyToolsChanged();
      } catch (err) {
        logErr(`Post-login upstream tool discovery error: ${err.message}`);
      }
    } catch (err) {
      lastAuthError = sanitizeErrorBody(err?.message || String(err));
      logErr(`Callback handler error: ${lastAuthError}`);
      try {
        if (!res.headersSent) {
          sendCallbackHtml(res, 500, {
            ok: false,
            title: "Callback Processing Error",
            subtitle: "An internal error occurred exchanging the OAuth code. Please retry."
          });
        }
      } catch {
        // Ignore write failures.
      }
      clearPendingLogin();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to bind loopback OAuth callback server.");
  }
  redirectUri = `http://127.0.0.1:${address.port}/callback`;

  const dcrRes = await fetchWithTimeout(meta.registration_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      client_name: "Antigravity IBKR Portfolio",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope
    })
  });
  if (!dcrRes.ok) {
    server.close();
    const dcrErr = sanitizeErrorBody(await dcrRes.text());
    throw new Error(`IBKR Dynamic Client Registration failed (${dcrRes.status}): ${dcrErr}`);
  }
  const clientMeta = await dcrRes.json();
  clientId = clientMeta.client_id;
  if (!clientId) {
    server.close();
    throw new Error("IBKR Dynamic Client Registration did not return client_id.");
  }

  const authUrlObj = new URL(meta.authorization_endpoint);
  authUrlObj.searchParams.set("response_type", "code");
  authUrlObj.searchParams.set("client_id", clientId);
  authUrlObj.searchParams.set("redirect_uri", redirectUri);
  authUrlObj.searchParams.set("scope", scope);
  authUrlObj.searchParams.set("state", expectedState);
  authUrlObj.searchParams.set("code_challenge", codeChallenge);
  authUrlObj.searchParams.set("code_challenge_method", "S256");
  authUrlObj.searchParams.set("resource", RESOURCE_URL);

  const authorizationUrl = assertTrustedIbkrHttpsUrl(authUrlObj.toString(), "authorization_url");
  const startedAt = Date.now();
  const expiresAt = startedAt + OAUTH_TIMEOUT_MS;
  const timeoutHandle = setTimeout(() => {
    lastAuthError = "Timed out waiting for IBKR OAuth browser callback (300s).";
    clearPendingLogin();
  }, OAUTH_TIMEOUT_MS);
  timeoutHandle.unref?.();

  pendingLogin = {
    server,
    timeoutHandle,
    state: expectedState,
    redirectUri,
    authorizationUrl,
    scope,
    startedAt,
    expiresAt
  };

  logErr(`Launching browser for IBKR OAuth (redirect ${redirectUri})`);
  const browserRes = await tryOpenBrowser(authorizationUrl);

  return {
    status: "awaiting_browser_approval",
    authorization_url: authorizationUrl,
    redirect_uri: redirectUri,
    scope,
    read_only_enforced: !ALLOW_WRITE,
    browser_launch_attempted: browserRes.launched,
    ...(browserRes.error ? { browser_error: browserRes.error } : {}),
    expires_in_seconds: OAUTH_TIMEOUT_MS / 1000,
    next_step:
      "Approve the sign-in in your browser (or open authorization_url). No code copying is needed; once approved, the callback is captured automatically."
  };
}

async function handleSignOut() {
  clearPendingLogin();
  lastAuthError = null;
  const tokens = readTokens();
  const revoked = [];
  if (tokens?.revocation_endpoint && tokens?.client_id) {
    try {
      const revocationEndpoint = assertTrustedIbkrHttpsUrl(
        tokens.revocation_endpoint,
        "revocation_endpoint"
      );
      for (const tokenVal of [tokens.refresh_token, tokens.access_token]) {
        if (!tokenVal) continue;
        try {
          const body = new URLSearchParams({
            token: tokenVal,
            client_id: tokens.client_id
          });
          const r = await fetchWithTimeout(
            revocationEndpoint,
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: body.toString()
            },
            15_000
          );
          revoked.push(r.status);
        } catch {
          // Best-effort revocation.
        }
      }
    } catch (err) {
      logErr(`Skipped token revocation: ${err.message}`);
    }
  }
  deleteTokens();
  upstreamSessionId = null;
  cachedUpstreamTools = [];
  notifyToolsChanged();
  return {
    signed_out: true,
    token_file_removed: !fs.existsSync(TOKEN_FILE),
    revocation_statuses: revoked
  };
}

function asTextResult(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }]
  };
}

async function handleToolCall(name, args) {
  if (name === "ibkr_auth_status") {
    const exists = fs.existsSync(TOKEN_FILE);
    const rawTokens = readTokens();
    let validTokens = null;
    try {
      validTokens = await getValidTokens();
    } catch {
      validTokens = null;
    }
    const active = validTokens || rawTokens;
    return asTextResult({
      connected: Boolean(validTokens),
      scope: active?.scope || null,
      read_only_enforced: !ALLOW_WRITE,
      expires_at: active?.expires_at ? new Date(Number(active.expires_at)).toISOString() : null,
      upstream_tools_count: filterExposedTools(cachedUpstreamTools).length,
      token_file_exists: exists,
      pending_login: Boolean(pendingLogin),
      last_auth_error: lastAuthError || null
    });
  }

  if (name === "ibkr_connect") {
    const result = await startOAuthConnect(args?.scope);
    return asTextResult(result);
  }

  if (name === "ibkr_list_tools") {
    const tools = filterExposedTools(await fetchUpstreamTools());
    notifyToolsChanged();
    return asTextResult({
      upstream_tools_count: tools.length,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description || "",
        inputSchema: t.inputSchema || {}
      }))
    });
  }

  if (name === "ibkr_call") {
    const toolName = args?.tool_name;
    if (!toolName || typeof toolName !== "string") {
      throw new Error("ibkr_call requires a string 'tool_name' parameter.");
    }
    if (!ALLOW_WRITE && isMutatingToolName(toolName)) {
      throw new Error(
        `Tool '${toolName}' is blocked in read-only mode. Relaunch proxy with --allow-write to enable write operations.`
      );
    }
    await ensureUpstreamSession();
    return sendUpstreamRpc("tools/call", {
      name: toolName,
      arguments: args?.arguments && typeof args.arguments === "object" ? args.arguments : {}
    });
  }

  if (name === "ibkr_sign_out") {
    const res = await handleSignOut();
    return asTextResult(res);
  }

  if (!ALLOW_WRITE && isMutatingToolName(name)) {
    throw new Error(
      `Tool '${name}' is blocked in read-only mode. Relaunch proxy with --allow-write to enable write operations.`
    );
  }

  await ensureUpstreamSession();
  return sendUpstreamRpc("tools/call", {
    name,
    arguments: args && typeof args === "object" ? args : {}
  });
}

async function handleRequest(msg) {
  if (!msg || typeof msg !== "object" || !msg.method) return;
  const { id, method, params } = msg;

  try {
    if (method === "initialize") {
      const clientProto = params?.protocolVersion || "2025-03-26";
      sendResult(id, {
        protocolVersion: clientProto,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "ibkr-mcp-proxy", version: PROXY_VERSION }
      });
      return;
    }

    if (method === "notifications/initialized" || method.startsWith("notifications/")) {
      return;
    }

    if (method === "ping") {
      sendResult(id, {});
      return;
    }

    if (method === "tools/list") {
      let merged = [...BUILTIN_TOOLS];
      try {
        const valid = await getValidTokens();
        if (valid) {
          const upstream = filterExposedTools(await fetchUpstreamTools());
          for (const t of upstream) {
            if (t?.name && !BUILTIN_TOOL_NAMES.has(t.name)) {
              merged.push(t);
            }
          }
        }
      } catch (err) {
        logErr(`Skipping upstream tool merge on tools/list: ${err.message}`);
      }
      sendResult(id, { tools: merged });
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      if (!toolName) {
        sendError(id, -32602, "Missing tool name in tools/call.");
        return;
      }
      const res = await handleToolCall(toolName, toolArgs);
      sendResult(id, res);
      return;
    }

    sendError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    if (method === "tools/call" && id !== undefined && id !== null) {
      sendResult(id, {
        isError: true,
        content: [{ type: "text", text: err.message || String(err) }]
      });
      return;
    }
    sendError(id, -32603, err.message || String(err));
  }
}

if (PREVIEW_CALLBACK_PATH) {
  const resolvedOut = path.resolve(PREVIEW_CALLBACK_PATH);
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  fs.writeFileSync(
    resolvedOut,
    renderCallbackHtml({
      ok: true,
      title: "Connected to Interactive Brokers",
      subtitle: "Your Interactive Brokers session is active in Antigravity. You can safely close this tab.",
      scope: DEFAULT_REQUESTED_SCOPE
    }),
    "utf8"
  );
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    logErr(`Invalid JSON-RPC line: ${err.message}`);
    return;
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      void handleRequest(item);
    }
  } else {
    void handleRequest(parsed);
  }
});

rl.on("close", () => {
  clearPendingLogin();
  process.exit(0);
});
