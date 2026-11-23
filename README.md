# Interactive Brokers (IBKR) Portfolio Plugin for Antigravity

Connect Antigravity directly to Interactive Brokers' official public remote MCP server (`https://api.ibkr.com/v1/api/mcp-public`) using **1-click browser OAuth 2.0 + PKCE** with automatic loopback callback capture and **proxy-enforced read-only protection (`mcp.read`)**.

> **Independent Community Plugin:** This project is maintained independently for Interactive Brokers customers and Antigravity users. It is **not affiliated with, sponsored by, or endorsed by Interactive Brokers LLC**.

---

## Features

- **1-Click Loopback OAuth Sign-In (`scripts/ibkr-mcp-proxy.mjs`):** Zero-dependency Node.js MCP stdio proxy that binds an ephemeral `127.0.0.1` callback server, launches IBKR's official sign-in flow in your browser, captures the authorization code automatically (zero copy-paste), strips query parameters from the confirmation URL bar, and swaps to a branded adaptive confirmation page.
- **Hardened Read-Only Default (`mcp.read` + `--allow-write` opt-in):** The local proxy pins OAuth requests to `mcp.read`, filters mutating/order upstream tools out of discovery, and hard-blocks mutating tool execution locally against prompt injection unless explicitly launched with `--allow-write`.
- **Automatic Session Refresh:** Exchanges authorization codes locally and transparently refreshes short-lived access tokens using the stored OAuth refresh token—no re-login required between normal Antigravity sessions until IBKR expires or revokes the underlying session.
- **Global Multi-Currency Portfolio Skill (`skills/ibkr-portfolio/SKILL.md`):** Guides reconciliation across `BASE` and local trading currencies (`get_account_summary`, `get_account_balances`, `get_account_positions`, `get_account_orders`, `get_account_trades`, PortfolioAnalyst tools, live quotes, and ETF look-through concentration).

---

## Requirements

- **Node.js 18+** (uses built-in `fetch`, `AbortSignal.timeout`, `node:http`, `node:crypto`, and `node:fs` with zero npm dependencies)
- An **Interactive Brokers** account eligible to authorize official remote MCP OAuth access (`https://api.ibkr.com/v1/api/mcp-public`)
- **Antigravity** IDE / CLI

---

## Installation

### Local Development / Manual Install

Clone or copy this plugin directory into Antigravity's local plugin folder:

```bash
git clone https://github.com/bakzs/ibkr-antigravity-plugin.git ~/.gemini/config/plugins/ibkr
chmod +x ~/.gemini/config/plugins/ibkr/scripts/ibkr-mcp-proxy.mjs
```

Then enable or restart the `ibkr` plugin in Antigravity's **Plugins Manager**.

---

## How Authentication Works

1. Ask Antigravity to connect IBKR or reconcile your portfolio (triggers `ibkr_connect`).
2. Your browser opens IBKR's official OAuth screen (`https://api.ibkr.com`). Sign in and approve read-only (`mcp.read`) access.
3. IBKR redirects once to `http://127.0.0.1:<ephemeral-port>/callback`. The local proxy completes the PKCE token exchange directly with IBKR, shows the **Connected to Interactive Brokers** confirmation page, and unlocks all read-only IBKR MCP tools in the current session.

### Token Duration & Re-Authentication

- **Short-lived access tokens (typically 10 minutes):** Refreshed automatically in the background by `ibkr-mcp-proxy.mjs` before expiry.
- **Refresh tokens / rolling session:** IBKR does not publish a fixed calendar TTL for `mcp-public` refresh tokens; access normally persists across chats and restarts until Interactive Brokers invalidates the rolling broker session due to extended inactivity, password/security changes, or manual revocation.
- You will **not** need to re-authenticate on every chat. Run `ibkr_connect` again only if IBKR expires your refresh session and reports re-authentication required.

---

## Security & Hardening Architecture (v0.4.0)

| Control | Behavior |
| :--- | :--- |
| **Credential custody** | Your IBKR username, password, and 2FA stay strictly on Interactive Brokers (`api.ibkr.com`). Antigravity never sees login credentials. |
| **Enforced read-only proxy** | Pins OAuth scope to `mcp.read`, strips write/order tools from `tools/list`, and rejects mutating calls locally unless explicitly launched with `--allow-write`. |
| **Trusted HTTPS origin pinning** | All OAuth metadata, token exchange, refresh, revocation, issuer (`iss`), and browser launch URLs are validated against `https://` `*.ibkr.com` / `*.interactivebrokers.com` hosts with 30-second request timeouts. |
| **Hardened loopback callback** | Requires `GET` and exact `127.0.0.1:<port>` `Host` header (DNS-rebinding guard), single-use callback lock, `crypto.timingSafeEqual` `state` check, RFC 9207 `iss` check, strict CSP + `X-Frame-Options: DENY` headers, and URL query scrubbing. |
| **Safe browser & filesystem handling** | Uses environment-variable parameter passing (`$env:IBKR_AUTH_URL`) for Windows PowerShell browser launch, rejects symlinks at token/data paths, stores `${PLUGIN_DATA}/oauth_tokens.json` with `0600` (`-rw-------`) permissions, and redacts tokens from error logs. |
| **Clean sign-out & revocation** | Run `ibkr_sign_out` to revoke tokens (best-effort RFC 7009) and delete local tokens, or revoke access anytime in IBKR Client Portal under **Settings > Manage Third-Party Consents**. |

---

## Plugin Layout

```text
ibkr-antigravity-plugin/
├── plugin.json                        # Antigravity plugin manifest
├── mcp_config.json                    # Stdio MCP server definition (${PLUGIN_ROOT})
├── assets/
│   └── logo.svg                       # Custom portfolio emblem (light & dark UI safe)
├── rules/
│   └── AGENTS.md                      # Read-only & currency-discipline guardrails
├── scripts/
│   └── ibkr-mcp-proxy.mjs             # Hardened OAuth PKCE loopback MCP proxy
├── skills/
│   └── ibkr-portfolio/
│       └── SKILL.md                   # Portfolio reconciliation & look-through workflow
├── LICENSE                            # MIT License
└── README.md
```

---

## License

Released under the [MIT License](LICENSE).
