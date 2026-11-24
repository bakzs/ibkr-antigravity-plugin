<p align="center">
  <img src="assets/logo.svg" alt="Interactive Brokers (IBKR) Portfolio Plugin Logo" width="88" height="88" />
</p>

<h1 align="center">Interactive Brokers (IBKR) Portfolio Plugin for Antigravity</h1>

<p align="center">
  <strong>Zero-dependency 1-click OAuth PKCE proxy &amp; read-only portfolio intelligence bridge to Interactive Brokers' official remote MCP server (v1.2.1).</strong>
</p>

<p align="center">
  v0.4.0 &middot; Node.js 18+ (Zero npm Dependencies) &middot; Enforced Read-Only Default &middot; MIT License
</p>

> **Independent Community Plugin:** This project is maintained independently for Interactive Brokers customers and MCP users. It is **not affiliated with, sponsored by, or endorsed by Interactive Brokers LLC**.

---

## Why This Exists

Interactive Brokers hosts an official public Model Context Protocol server (`https://api.ibkr.com/v1/api/mcp-public`, Connector v1.2.1), but many desktop/IDE MCP clients still stumble on manual OAuth authorization-code copy-paste, browser callback capture, and prompt-injection safety around order tools.

This plugin bridges the last mile with a **single-file, zero-dependency stdio proxy**:
- Opens IBKR's official OAuth 2.0 + PKCE login in one click and captures the `127.0.0.1` loopback callback automatically (no code copying).
- Replaces plain callback pages with a branded confirmation screen and scrubs `?code=` and `?state=` from browser history.
- Enforces **strict read-only protection (`mcp.read`)** locally at the proxy layer while unlocking all **38 read-only real-time IBKR investment tools**.

---

## 38 Real-Time Investment Capabilities Unlocked (IBKR MCP v1.2.1)

When connected in default read-only mode, the proxy unlocks Interactive Brokers' official real-time tools across four suites while blocking all 18 order, trade, and mutation endpoints locally:

### 1. Portfolio, Liquidity & Performance Reconciliation
- **Live Account & Multi-Currency Balances:** `get_account_summary`, `get_account_balances` (NAV, gross position value, cash split by `BASE` and settlement currency, settled vs. unsettled cash, initial/maintenance margin, excess liquidity, and buying power).
- **Positions, Orders & Executions:** `get_account_positions`, `get_account_orders`, `get_account_trades`.
- **PortfolioAnalyst Attribution:** `get_pa_allocation`, `get_pa_performance_all_periods`.

### 2. Real-Time Market Data, Futures & Options Chains
- **Contract Resolution & Futures:** `search_contracts`, `search_futures`, `get_combo_identifier`.
- **Live Snapshots & Historical Bars:** `get_price_snapshot`, `get_price_history`.
- **Option Expirations & Strike Chains:** `get_option_parameters`, `get_option_data` (equity/index `OPT` and futures `FOP` expirations, strikes, and contract snapshots).

### 3. Multi-Factor Global Screeners (US, Europe & HK)
- **Screener Discovery & Previews:** `get_screener_asset_classes`, `get_screener_capabilities`, `get_screener_templates`, `get_screener_industries`, `get_screener_themes`, `preview_screener`.
- **Saved Client Screeners:** `list_saved_screeners`, `get_saved_screener`, `run_saved_screener`.

### 4. Institutional Knowledge Graph, Earnings & Monitoring
- **Earnings Insights:** `search_earnings_insights`, `get_earnings_insight` (analyst previews, bull/base/bear scenarios, KPIs, post-earnings recaps, management guidance, and historical reaction distributions).
- **Investment Themes & Company Connections:** `search_investment_topics`, `get_theme_details` (ranked peer exposure & related ETFs/funds), `get_company_themes`, `get_company_connections` (competitors, products, countries/regions, and supporting evidence).
- **Watchlists, Alerts & Diagnostics:** `get_watchlists`, `get_watchlist`, `get_alerts`, `get_alert`, `get_order_instructions`, `get_order_rules`, `get_order_status`, `get_flow_type`, `whats_new`.

---

## Example Prompts

- *"Connect IBKR and reconcile my live positions, cash by currency, margin, and recent T+1 executions in my base currency."*
- *"Pull the latest earnings insight preview or recap for my top equity positions and summarize key bull/bear scenarios."*
- *"Find which companies and ETFs lead the nuclear or grid battery theme, and show competitors and geographic revenue exposure."*
- *"Check implied prices across 5 call and put strikes around current spot for the next monthly expiration."*
- *"Build and preview a multi-factor US equity screener using IBKR screener capabilities."*

---

## Requirements

- **Node.js 18+** (uses built-in `fetch`, `AbortSignal.timeout`, `node:http`, `node:crypto`, and `node:fs` with zero npm dependencies)
- An **Interactive Brokers** account eligible for official remote MCP OAuth access (`https://api.ibkr.com/v1/api/mcp-public`)

---

## Installation

### Option A: Antigravity Plugin

Clone directly into Antigravity's local plugins directory:

```bash
git clone https://github.com/bakzs/ibkr-antigravity-plugin.git ~/.gemini/config/plugins/ibkr
chmod +x ~/.gemini/config/plugins/ibkr/scripts/ibkr-mcp-proxy.mjs
```

Enable or restart **Interactive Brokers (IBKR) Portfolio** in Antigravity's **Plugins Manager**.

### Option B: Any Standard MCP Client (Claude Code, Cursor, Windsurf)

Because `scripts/ibkr-mcp-proxy.mjs` is a self-contained Node.js stdio MCP server, any MCP client can point directly at it:

```json
{
  "mcpServers": {
    "ibkr": {
      "command": "node",
      "args": ["/path/to/ibkr-antigravity-plugin/scripts/ibkr-mcp-proxy.mjs"]
    }
  }
}
```

> **Note:** In standalone CLI usage without `--data-dir`, tokens default to `~/.gemini/antigravity/plugin_data/ibkr/oauth_tokens.json` (pass `--data-dir /custom/path` to customize).

---

## How Authentication Works

1. Ask your AI assistant to connect IBKR or run a portfolio check (triggers `ibkr_connect`).
2. Your browser opens IBKR's official OAuth screen (`https://api.ibkr.com`). Sign in and approve read-only (`mcp.read`) access.
3. IBKR redirects once to `http://127.0.0.1:<ephemeral-port>/callback`. The proxy exchanges the PKCE code directly with IBKR, shows the **Connected to Interactive Brokers** confirmation page, and unlocks all 38 read-only tools in the same session.

### Token Duration & Re-Authentication

- **Short-lived access tokens (typically 10 minutes):** Refreshed automatically in the background by `ibkr-mcp-proxy.mjs` before expiry.
- **Rolling refresh session:** IBKR does not publish a fixed calendar TTL for `mcp-public` refresh tokens; access normally persists across chats and restarts until Interactive Brokers invalidates the rolling session due to extended inactivity, password/security changes, or manual revocation.

---

## Security & Hardening Architecture (v0.4.0)

| Control | Behavior |
| :--- | :--- |
| **Credential custody** | Your IBKR username, password, and 2FA stay strictly on Interactive Brokers (`api.ibkr.com`). Neither Antigravity nor any AI model ever sees credentials. |
| **Enforced read-only proxy** | Pins OAuth scope to `mcp.read`, strips all 18 mutating/order upstream tools from `tools/list` and `ibkr_list_tools`, and rejects mutating calls locally unless explicitly started with `--allow-write`. |
| **IBKR Flow Modes & AI Partitions** | Supports IBKR's upstream `REVIEW_AND_APPROVE` and `AUTONOMOUS` (AI Partition) server modes safely by blocking write execution locally by default in the proxy regardless of account flags. |
| **Trusted HTTPS origin pinning** | All OAuth metadata, token exchange, refresh, revocation, issuer (`iss`), and browser launch URLs are validated strictly against `https://` `*.ibkr.com` / `*.interactivebrokers.com` hosts with 30-second fetch timeouts. |
| **Hardened loopback callback** | Enforces `GET`, exact `127.0.0.1:<port>` `Host` header validation (DNS-rebinding guard), single-use callback lock, `crypto.timingSafeEqual` `state` checks, RFC 9207 `iss` verification, strict CSP + `X-Frame-Options: DENY` headers, and URL query scrubbing. |
| **Safe browser & filesystem hygiene** | Uses environment-variable parameter passing (`$env:IBKR_AUTH_URL`) for Windows PowerShell browser launch, rejects symlinks at token/data paths, stores `${PLUGIN_DATA}/oauth_tokens.json` with `0600` (`-rw-------`) permissions, and redacts tokens from error logs. |
| **Clean sign-out & revocation** | Run `ibkr_sign_out` for best-effort RFC 7009 token revocation + local file deletion, or revoke access anytime in IBKR Client Portal under **Settings > Manage Third-Party Consents**. |

---

## Plugin Layout

```text
ibkr-antigravity-plugin/
├── plugin.json                        # Antigravity plugin manifest
├── mcp_config.json                    # Stdio MCP server definition (${PLUGIN_ROOT})
├── assets/
│   └── logo.svg                       # Custom squircle emblem (light & dark UI safe)
├── rules/
│   └── AGENTS.md                      # Read-only & currency-discipline guardrails
├── scripts/
│   └── ibkr-mcp-proxy.mjs             # Hardened zero-dependency OAuth PKCE MCP proxy
├── skills/
│   └── ibkr-portfolio/
│       └── SKILL.md                   # Portfolio reconciliation & v1.2.1 research workflows
├── LICENSE                            # MIT License
└── README.md
```

---

## License

Released under the [MIT License](LICENSE).
