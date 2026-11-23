# Interactive Brokers (IBKR) Safety & Data Discipline Rules

1. **Read-only by default:** Only perform read-only portfolio, balance, position, FX, quote, open-order, and execution-history queries unless the user explicitly asks to draft a specific order.
2. **Never trade autonomously:** Never submit, place, modify, cancel, or confirm any order, and never initiate any funds transfer or invoke order-submission tools unless the user explicitly requests drafting an order and confirms the exact ticker/contract, side (buy/sell), quantity, order type, limit price (if applicable), and target account.
3. **Timestamps and currencies:** Always report the exact retrieval timestamp, separate each position's trading currency from the account's base currency (e.g., SGD vs. USD), and flag stale, pre-market, or cross-exchange asynchronous marks.
4. **No double-counting liquidity:** Treat Cash, Available Funds, and Buying Power as overlapping measures—never add them together as separate pools of deployable capital.
