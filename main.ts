// Launch-sniper paper-trading bot for the pump.fun replay sprint (agent-fun/replay/v2).
//
// The harness sends a hello, then one batch per slot with that slot's chain events, and the bot
// answers each batch with the orders it decides on that slot. Orders fill two slots later at
// the reserves then current, so anything that needs a long attention span is already lost:
// this bot trades only the opening seconds of brand-new curves. It watches every coin from its
// CreateEvent, reads the opening tape — how much real SOL the curve holds, how many distinct
// outside wallets bought, whether the creator has sold, how one-sided the flow is — and buys
// only quiet, validated launches. It then leaves fast: fixed take-profit and stop-loss, a hard
// maximum hold, and an instant exit the moment the creator sells. One entry per coin, which
// also builds the distinct-mints count the guardrails ask for. Every decision is a pure
// function of the batches received — no clock, no randomness, no environment — so the two
// grading executions produce identical action logs.

import { LAMPORTS_PER_SOL, runBot, type BotState, type OrderInput } from './vendor/makefun-bot.ts';

/** SOL staked per position before the per-coin size cap trims it. */
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 10n; // 0.1 SOL
/** Never open a position under this: the round-trip guardrail floor is 0.01 SOL of buys. */
const MIN_STAKE_LAMPORTS = LAMPORTS_PER_SOL / 50n; // 0.02 SOL
/** A launch may be bought only in its first slots (age = current slot - create slot). */
const MAX_AGE_SLOTS = 5;
/** Real SOL the curve must hold at decision time: enough that the 1% size cap is a real order,
 *  not so much that the launch phase is already over. */
const MIN_REAL_QUOTE = LAMPORTS_PER_SOL / 10n; // 0.1 SOL
const MAX_REAL_QUOTE = LAMPORTS_PER_SOL * 30n; // 30 SOL
/** Opening-tape filters: at least one outside buyer, at most a handful (a launch bundled by a
 *  crowd of wallets in its first slots is usually the creator's cluster waiting to dump), and
 *  sells so far at most 30% of buys. */
const MIN_OUTSIDE_BUYERS = 1;
const MAX_OUTSIDE_BUYERS = 3;
const MAX_SELL_RATIO_BPS = 3_000;
/** Do not chase: the price may be at most 60% over the create price when we decide. */
const MAX_RUNUP_BPS = 6_000;
/** Exit thresholds on the position's marked gain (bps of cost) and its lifetime. */
const TAKE_PROFIT_BPS = 1_500; // +15%
const STOP_LOSS_BPS = -1_200; // -12%
const MAX_HOLD_SLOTS = 12;
const DEAD_AIR_SLOTS = 60;
/** Slippage tolerance: launches move fast; a refused exit is worse than a slightly worse fill. */
const BUY_SLIPPAGE_BPS = 2_500;
const SELL_SLIPPAGE_BPS = 2_500;
/** A decided coin we no longer hold is pruned this many slots after its last trade, so the
 *  launch records stay bounded over a long window. Pruning can never change a decision: an
 *  entry is only ever decided within MAX_AGE_SLOTS of the create slot. */
const PRUNE_AFTER_SLOTS = 5_000;

interface Coin {
  createSlot: number;
  creator: string;
  createPrice: number;
  creatorSold: boolean;
  outsideBuyers: Set<string>;
  buyQuote: bigint;
  sellQuote: bigint;
  trades: number;
  lastSlot: number;
  decided: boolean;
}

interface HeldInfo {
  sinceSlot: number;
}

const coins = new Map<string, Coin>();
const held = new Map<string, HeldInfo>();

/** Spot price (quote lamports per token unit) from virtual reserves, as a float for heuristics. */
function priceOf(vq: bigint, vt: bigint): number {
  return vt === 0n ? 0 : Number(vq) / Number(vt);
}

/** What selling `tokens` into the curve's virtual reserves returns before fees (constant product). */
function quoteOut(vq: bigint, vt: bigint, tokens: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  return (vq * tokens) / (vt + tokens);
}

/** The position's marked gain in bps of its cost, marked at the current reserves. */
function gainBps(state: BotState, mint: string): number | null {
  const pos = state.positions.get(mint);
  const curve = state.curves.get(mint);
  if (pos === undefined || curve === undefined || pos.cost_lamports === 0n) return null;
  const out = quoteOut(curve.virtual_quote_reserves, curve.virtual_token_reserves, pos.token_amount);
  return Number(((out - pos.cost_lamports) * 10_000n) / pos.cost_lamports);
}

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: OrderInput[] = [];

    // Fold this batch's events into the per-coin launch records.
    const active = new Set<string>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!coins.has(e.mint)) {
          coins.set(e.mint, {
            createSlot: batch.slot,
            creator: e.creator,
            createPrice: priceOf(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves)),
            creatorSold: false,
            outsideBuyers: new Set<string>(),
            buyQuote: 0n,
            sellQuote: 0n,
            trades: 0,
            lastSlot: batch.slot,
            decided: false,
          });
        }
        continue;
      }
      if (e.event !== 'TradeEvent') continue;
      active.add(e.mint);
      const c = coins.get(e.mint);
      if (c === undefined) continue;
      c.trades += 1;
      c.lastSlot = batch.slot;
      if (e.is_buy) {
        c.buyQuote += BigInt(e.sol_amount);
        if (e.user !== c.creator) c.outsideBuyers.add(e.user);
      } else {
        c.sellQuote += BigInt(e.sol_amount);
        if (e.user === c.creator) c.creatorSold = true;
      }
    }

    // Mints with an order already in flight: never stack a second order on the same coin.
    const pendingMints = new Set<string>();
    for (const p of state.pending.values()) pendingMints.add(p.order.mint);

    // --- exits first: they free the position slots and the cash that entries then reuse ---
    for (const [mint, pos] of state.positions) {
      let info = held.get(mint);
      if (info === undefined) {
        info = { sinceSlot: batch.slot };
        held.set(mint, info);
      }
      if (pendingMints.has(mint)) continue;
      const curve = state.curves.get(mint);
      const gain = gainBps(state, mint);
      if (curve === undefined || gain === null) continue;
      const c = coins.get(mint);
      const creatorDumped = c !== undefined && c.creatorSold;
      const heldLong = batch.slot - info.sinceSlot >= MAX_HOLD_SLOTS;
      const deadAir = batch.slot - (c?.lastSlot ?? batch.slot) >= DEAD_AIR_SLOTS;
      const exit =
        gain >= TAKE_PROFIT_BPS ||
        gain <= STOP_LOSS_BPS ||
        heldLong ||
        creatorDumped ||
        (deadAir && gain < 0) ||
        curve.complete;
      if (exit) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
        pendingMints.add(mint);
      }
    }
    // Forget positions the account no longer holds (closed by a fill, a completion or a write-off).
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }
    // Prune launch records that are decided, unheld and long quiet (see PRUNE_AFTER_SLOTS).
    for (const [mint, c] of coins) {
      if (c.decided && !state.positions.has(mint) && batch.slot - c.lastSlot >= PRUNE_AFTER_SLOTS) {
        coins.delete(mint);
      }
    }

    // --- entries: buy quiet, validated launches inside their first slots ---
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    for (const mint of active) {
      if (orders.length >= caps.max_orders_per_batch || slots <= 0) break;
      if (state.positions.has(mint) || pendingMints.has(mint)) continue;
      const c = coins.get(mint);
      if (c === undefined || c.decided) continue;
      const age = batch.slot - c.createSlot;
      if (age > MAX_AGE_SLOTS) {
        c.decided = true; // the launch window for this coin has passed for good
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        c.decided = true;
        continue;
      }
      if (c.creatorSold) {
        c.decided = true; // the creator is out before we are in: never touch it
        continue;
      }
      if (curve.real_quote_reserves < MIN_REAL_QUOTE || curve.real_quote_reserves > MAX_REAL_QUOTE) continue;
      if (c.trades < 2) continue;
      if (c.outsideBuyers.size < MIN_OUTSIDE_BUYERS || c.outsideBuyers.size > MAX_OUTSIDE_BUYERS) continue;
      if (c.buyQuote === 0n || c.sellQuote * 10_000n > c.buyQuote * BigInt(MAX_SELL_RATIO_BPS)) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (c.createPrice <= 0 || price <= 0) continue;
      const runupBps = Math.floor(((price - c.createPrice) / c.createPrice) * 10_000);
      if (runupBps > MAX_RUNUP_BPS || runupBps < -1_000) continue;
      const cap = state.maxBuyLamports(mint);
      const stake = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (stake < MIN_STAKE_LAMPORTS) continue;
      if (free < stake + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: stake, max_slippage_bps: BUY_SLIPPAGE_BPS });
      c.decided = true;
      pendingMints.add(mint);
      free -= stake + tx;
      slots -= 1;
    }

    return orders;
  },
});
