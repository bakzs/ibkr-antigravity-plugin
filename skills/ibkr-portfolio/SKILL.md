---
name: ibkr-portfolio
description: >-
  Reconcile live Interactive Brokers (IBKR) accounts via the official IBKR MCP server.
  Use when checking live positions, multi-currency cash balances, FX conversion rates,
  open orders, recent executions, margin, unrealized P&L, portfolio allocation,
  ETF look-through concentration, earnings insights, thematic stock research,
  options chains, screeners, or cross-border US-situs tax exposure.
---

# IBKR Portfolio Reconciliation & Real-Time Research Workflow

Follow this workflow whenever connecting to or querying an Interactive Brokers account through the bundled `ibkr-mcp` server (`ibkr_ibkr-mcp`).

## 1. Non-Blocking 1-Click Authentication Flow

1. Check connection state first with `ibkr_auth_status` (inspect `<appDataDir>/mcp/ibkr_ibkr-mcp/*.json` schemas before calling lazy tools).
2. If `connected` is `false`, call `ibkr_connect` directly without overriding scopes (`mcp.read` is strictly pinned by the local proxy unless intentionally launched with `--allow-write`).
3. `ibkr_connect` returns **immediately** with `status: "awaiting_browser_approval"` and a clickable `authorization_url` while keeping an ephemeral `127.0.0.1` loopback listener alive for 5 minutes and opening the user's browser automatically.
4. Share the clickable `authorization_url` in chat as a convenient fallback if the browser window did not focus, and let the user approve sign-in directly on Interactive Brokers (zero authorization code copy-paste required).
5. Once approved, call `ibkr_auth_status` to confirm `connected: true` and invoke exposed read-only upstream IBKR tools via native `mcp_ibkr_ibkr-mcp_*` tools or `ibkr_list_tools` + `ibkr_call` in the same session.

## 2. Safety & Proxy-Enforced Read-Only Discipline

- **Defense in depth:** Both `rules/AGENTS.md` and `scripts/ibkr-mcp-proxy.mjs` enforce read-only mode by default (`read_only_enforced: true`). Non-`mcp.read` OAuth scopes and all 18 mutating/order upstream tools (order creation/submission/modification/cancellation, alerts, watchlist writes, saved screener edits, and feedback) are filtered and hard-blocked at the local proxy unless explicitly launched with `--allow-write`.
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
4. **Allocation & Attribution:**
   - Use `get_pa_allocation` and `get_pa_performance_all_periods` for PortfolioAnalyst asset-class/sector breakdowns and multi-period performance attribution.
5. **Consistency Verification:**
   - Verify `Positions + Cash + Accruals ≈ NAV` in the account's `BASE` currency reported by `get_account_balances` (e.g., USD, SGD, EUR, GBP, HKD) and call out any FX translation or accrual variance.

## 4. Concentration, Look-Through & Optional Cross-Border Check

- **ETF & Single-Name Look-Through:** When broad index or thematic ETFs (such as VWRA, CSPX, VOO, VTI, or QQQ) sit alongside individual equities, aggregate combined direct plus indirect top-name and sector exposure.
- **Cross-Border Tax Awareness (Conditional):** When the user is a non-US resident alien (for example in Singapore or another non-treaty/partial-treaty jurisdiction) or asks about withholding/estate efficiency, highlight US-situs holdings (US stocks and US-domiciled ETFs) relative to the US$60,000 non-resident alien US federal estate tax threshold and compare 30% statutory dividend withholding against 15% Ireland-domiciled UCITS equivalents.

## 5. Verified v1.2.1 Research, Screening & Options Workflows

Use exact ID chaining (never invent or guess internal IBKR IDs, and never display internal contract/expiration IDs when human-readable symbols/expiries suffice):

- **Earnings Insights:** Call `search_earnings_insights` (`{ "contract_ids": [...] }`) using `contract_id` integers from `search_contracts` or account positions, then pass a returned `id` verbatim to `get_earnings_insight` for full analyst previews (bull/base/bear scenarios, KPIs) or post-earnings recaps (guidance, historical reactions where `0.05` = 5% return and is not a forecast).
- **Investment Themes & Company Connections:**
  - For sector/trend queries, pass a short singular root noun (e.g., `"battery"`, `"quantum"`, `"solar"`) to `search_investment_topics`, then pass the returned `key` verbatim to `get_theme_details` (set `max_funds > 0` when the user also wants ETFs/mutual funds).
  - Resolve company tickers with `search_contracts`, then call `get_company_themes` for lightweight sector/peer rankings or `get_company_connections` (`include: ["link_info", "company_info"]`) for products, competitors, geography, and supporting evidence.
- **Multi-Factor Global Screeners:** Inspect existing client screeners with `list_saved_screeners` and execute them via `run_saved_screener`. When creating custom screens, call `get_screener_asset_classes` + `get_screener_capabilities` (plus `get_screener_industries` / `get_screener_themes` if filtering by theme or industry) before calling `preview_screener`.
- **Options Chains & Live Option Pricing:** Fetch underlying spot first with `get_price_snapshot`, call `get_option_parameters` (`option_sec_type: "OPT"` or `"FOP"`), pass a unique verbatim `expiration_id` to `get_option_data` bounded via `min_strike`/`max_strike` around spot (note returned `strike` values are strings and structural rows contain no quotes/IV), then call `get_price_snapshot` on returned numeric `call_contract_id` / `put_contract_id` values with top-level `exchange` for live prices, IV, OI, and volume.
