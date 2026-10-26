// @dexterm/autotrade — the autotrade engine (AUTOTRADE-SPEC, task-1503 AT-1). PAPER ONLY.
//
// strategy   the dexterm-strategy/1 document, exit profiles 1.0.0..1.2.0, the validator, presets
// engine     entry rules on the screener grammar, sizing, the clamp, the constant-product fill model
// monitor    mechanical exits + wake events (no LLM)
// replay     the recorded tape (MarketTick) read from the recorder DB or a committed fixture
// session    the decision protocol, dossier/delta text, the stub session (types for the runner card)
// runner     the run loop (lockstep for backtests, paced for replays, live for `autotrade run`), lock + rendezvous
// ledger     the hash-chained run ledger, runs/<runId>.jsonl, chain verification (task-1505)
// sessions   the user's own `claude -p` sessions, day caps + allowance guard, the mcp dossier (task-1505)
// live-source  Store-fed MarketTicks: the screener pool every 10 s, candidate/held coins every 5 s (task-1505)
// runner-config / account  runner.json (dexterm-runner/1) and the four Claude account kinds (task-1505)
// backtest   the report, every-candidate mode, runner recall, held-out split + sweeps
// store      ~/.dexterm/strategies/<id>.json CRUD + the append-only .journal.jsonl
// desk-executor   orders through the app's paper desk (armed paper-only mandate, exit plans, quote-sized cost recovery)
// monitor-daemon  the position monitor process: §5 exits on the desk, one wake message per tick, restart recovery
// safety     stop / flatten / pause (the control file), the kill switch + dead-man every step, the run audit, session isolation (task-1509)
// fleet      parallel strategies: N strategies on one feed, each with its own book, ledger, caps and budget, under global caps (task-1529)
// fleet-config / fleet-control  autotrade.json (dexterm-autotrade/1), per-strategy control files, the fleet status + comparison table
// paper-accounts  shared paper accounts: many strategies trading from one simulated wallet, one strategy on many (task-1538)
// trade-ledger  the run ledgers as unified trade ledger drafts (task-1530, read-only)
// execution-port  where an approved entry goes: the paper port (local single-use proofs) and the live stub (task-1527)
// chat       Telegram notify, control and approve-to-trade through the user's own bot; chat/ (task-1527)
// yolo       task-1532: the full-port replay (rugs, loss spread, how often it zeroed the wallet); paper only
// signal / outbox / signal-channels / receipts / real-mode  task-1645: mode real = the paper engine + a LIVE TRADE FIRE
//            signal per fill to the user's own executor (webhook, command hook, JSONL, MCP feed, Telegram copy); no key
// limits / executor-health / report  task-1654: every real-mode limit user-set per scope (stricter wins), executor
//            heartbeats + the silence pause, the paper-vs-real divergence report and the digest
//
// The screener filter grammar is imported by path from the CLI's screener (one parser for the screen and
// for strategies); nothing in this package touches a key or a wallet, and nothing places a live order (task-1571). The desk executor
// trades only through the paper desk (a paper executor, by construction) on a keyless quote.

export * from './strategy.ts';
export * from './engine.ts';
export * from './monitor.ts';
export * from './replay.ts';
export * from './session.ts';
export * from './runner.ts';
export * from './ledger.ts';
export * from './sessions.ts';
export * from './live-source.ts';
export * from './runner-config.ts';
export * from './basis-text.ts';
export * from './account.ts';
export * from './backtest.ts';
export * from './store.ts';
export * from './desk-executor.ts';
export * from './monitor-daemon.ts';
export * from './safety.ts';
export * from './fleet-config.ts';
export * from './fleet-control.ts';
export * from './fleet.ts';
export * from './paper-accounts.ts';
export * from './trade-ledger.ts';
export * from './execution-port.ts';
export * from './chat/index.ts';
export * from './yolo.ts';
export * from './signal.ts';
export * from './outbox.ts';
export * from './signal-channels.ts';
export * from './receipts.ts';
export * from './real-mode.ts';
export * from './journey.ts';
export * from './forward.ts';
export * from './service.ts';
export * from './service-guard.ts';
export * from './service-recover.ts';
export * from './service-install.ts';
export * from './limits.ts';
export * from './paper-limits.ts';
export * from './executor-health.ts';
export * from './report.ts';
