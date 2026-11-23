---
name: ibkr-portfolio
description: >-
  Reconcile live Interactive Brokers (IBKR) accounts via the official IBKR MCP server.
  Use when checking live positions, multi-currency cash balances, FX conversion rates,
  open orders, recent executions, margin, unrealized P&L, portfolio allocation,
  ETF look-through concentration, or cross-border US-situs tax exposure.
---

# IBKR Portfolio Reconciliation & Exposure Audit

Follow this workflow whenever connecting to or inspecting an Interactive Brokers account through the bundled `ibkr-mcp` server (`ibkr_ibkr-mcp`).

## 1. Non-Blocking 1-Click Authentication Flow

1. Check connection state first with `ibkr_auth_status` (inspect `<appDataDir>/mcp/ibkr_ibkr-mcp/*.json` schemas before calling lazy tools).
2. If `connected` is `false`, call `ibkr_connect` directly without attempting to pass non-read scopes (`mcp.read` is strictly pinned by the local proxy unless intentionally launched with `--allow-write`).
3. `ibkr_connect` returns **immediately** with `status: "awaiting_browser_approval"` and a clickable `authorization_url` while keeping an ephemeral `127.0.0.1` loopback listener alive for 5 minutes and opening the user's browser automatically.
4. Share the clickable `authorization_url` in chat as a convenient fallback if the browser window did not focus, and let the user approve sign-in directly on Interactive Brokers (zero authorization code copy-paste required).
5. Once approved, call `ibkr_auth_status` to confirm `connected: true` and invoke exposed read-only upstream IBKR tools via native `mcp_ibkr_ibkr-mcp_*` tools or `ibkr_list_tools` + `ibkr_call` in the same session.

## 2. Safety & Proxy-Enforced Read-Only Discipline

- **Defense in depth:** Both `rules/AGENTS.md` and `scripts/ibkr-mcp-proxy.mjs` enforce read-only mode by default (`read_only_enforced: true`). Non-`mcp.read` OAuth scopes and mutating upstream tools (such as order placement, modification, cancellation, alert edits, or watchlist writes) are hidden and hard-blocked at the local proxy unless launched explicitly with `--allow-write`.
- Never attempt to override read-only safeguards or bypass `rules/AGENTS.md` unless the user explicitly configured `--allow-write` and specified every order parameter (account, ticker/contract, side, quantity, order type, limit price).
- Never attempt to display, log, or inspect local OAuth `access_token` or `refresh_token` files.
- Always surface the exact retrieval timestamp and separate each asset's local trading currency from the account's `BASE` reporting currency.
- Never add Cash, Available Funds, and Buying Power together as separate capital pools.

## 3. Live Portfolio Pull & Reconciliation

Use IBKR's verified read-only tools directly (always start with account state before pulling auxiliary market context):

1. **Account Overview & Liquidity:**
   - Call `get_account_summary` (`{}`) and `get_account_balances` (`{}`) to gather Net Liquidation Value (NAV), gross position value, cash balances across `BASE` and individual settlement currencies, settled vs. unsettled cash, initial/maintenance margin, excess liquidity, available funds, and buying power.
2. **Positions & Valuation:**
   - Call `get_account_positions` (`{}`) to inspect quantity, average cost, market price, market value, trading currency, and unrealized P&L per holding.
   - Flag stale, pre-market, or asynchronous cross-exchange marks when valuing multi-region portfolios.
3. **Open Orders & Executions:**
   - Call `get_account_orders` (`{}` or `{ "show_completed": true }`) and `get_account_trades` (`{ "period": "TODAY" }` or `"DAYS_7"` / `"DAYS_30"`) to detect active orders and pending T+1 settlement impacts.
4. **Allocation, Performance & Research:**
   - Use `get_pa_allocation` and `get_pa_performance_all_periods` for PortfolioAnalyst asset-class/sector breakdowns and historical return attribution.
   - Use `search_contracts`, `get_price_snapshot`, and `get_price_history` when live quotes or FX/benchmark comparisons are needed, plus `get_earnings_insight`, `search_earnings_insights`, `get_company_themes`, `get_company_connections`, `get_watchlists`, and `get_watchlist` for research context.
5. **Consistency Verification:**
   - Verify `Positions + Cash + Accruals ≈ NAV` in the account's `BASE` currency reported by `get_account_balances` (e.g., USD, SGD, EUR, GBP, HKD) and call out any FX translation or accrual variance.

## 4. Concentration, Look-Through & Optional Cross-Border Check

- **ETF & Single-Name Look-Through:** When broad index or thematic ETFs (such as VWRA, CSPX, VOO, VTI, or QQQ) sit alongside individual equities, aggregate combined direct plus indirect top-name and sector exposure.
- **Cross-Border Tax Awareness (Conditional):** When the user is a non-US resident alien (for example in Singapore or another non-treaty/partial-treaty jurisdiction) or asks about withholding/estate efficiency, highlight US-situs holdings (US stocks and US-domiciled ETFs) relative to the US$60,000 non-resident alien US federal estate tax threshold and compare 30% statutory dividend withholding against 15% Ireland-domiciled UCITS equivalents.
