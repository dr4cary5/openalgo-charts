import {
  dataVariantKey, sharedHistoryRequests,
  type Bar, type BarsRequest, type IndicatorBarsProviderAccess,
  type IndicatorSnapshotRequest, type RequestedBarsSnapshot, type TimeframeFeed,
} from 'openalgo-charts';
import { alignRequestedExpression } from './requested-context';

/** Availability is provider knowledge, not inferred from the next observed candle. */
export interface TimeframeProviderOptions {
  availability(bar: Readonly<Bar>, request: IndicatorSnapshotRequest): { at: number | null; confirmed: boolean };
  /** Supply historical value versions, or replay requests are rejected. */
  historicalSnapshot?: (request: IndicatorSnapshotRequest) => Promise<RequestedBarsSnapshot>;
  /** UTC seconds, also used for the five-minute closed-history cache lifetime. */
  now?: () => number;
}

interface Entry { bars: readonly Bar[]; from: number; to: number; exhausted: boolean; stored: number }

function wire(req: IndicatorSnapshotRequest): BarsRequest {
  return { symbol: req.symbol, exchange: req.exchange ?? '', interval: req.interval, signal: req.signal,
    ...(req.variant ? { variant: req.variant } : {}) };
}

function merge(before: readonly Bar[], after: readonly Bar[]): Bar[] {
  return Array.from(new Map([...before, ...after].map(bar => [bar.time, { ...bar }])).values()).sort((a, b) => a.time - b.time);
}

function alive(req: IndicatorSnapshotRequest): void {
  if (req.signal?.aborted) throw req.signal.reason;
}

/** An empty run of warmup windows longer than this, in seconds, means the source has no older history. */
const EMPTY_SPAN = 30 * 86400;
/** The most an empty warmup window grows the next one by, so a single read stays bounded. */
const MAX_EMPTY_GROWTH = 64;

/** Independent, bounded confirmed history, shared requests and a refreshable forming tail. */
export function createTimeframeProvider(feed: TimeframeFeed, options: TimeframeProviderOptions): IndicatorBarsProviderAccess {
  const pool = sharedHistoryRequests(feed), cache = new Map<string, Entry>();
  const now = options.now ?? (() => Date.now() / 1000);
  const snapshot = (bars: readonly Bar[], req: IndicatorSnapshotRequest): RequestedBarsSnapshot => {
    const values = bars.map(bar => options.availability(bar, req));
    const result = { bars: bars.map(bar => ({ ...bar })), availableAt: values.map(value => value.at), confirmed: values.map(value => value.confirmed) };
    alignRequestedExpression([], result, () => ({}));
    return result;
  };
  const remember = (key: string, entry: Entry): void => {
    cache.delete(key);
    cache.set(key, entry);
    let count = 0;
    for (const item of cache.values()) count += item.bars.length;
    while (cache.size > 24 || count > 250_000) {
      const first = cache.keys().next().value!;
      count -= cache.get(first)!.bars.length;
      cache.delete(first);
    }
  };
  const requestSnapshot = async (req: IndicatorSnapshotRequest): Promise<RequestedBarsSnapshot> => {
    alive(req);
    const warmup = req.warmupBars ?? 0;
    if (!Number.isInteger(warmup) || warmup < 0 || warmup > 100_000 || !Number.isFinite(req.from) || !Number.isFinite(req.to) || req.from > req.to) {
      throw new Error('Invalid timeframe history window or warmup count');
    }
    if (req.asOf !== undefined) {
      if (!options.historicalSnapshot) throw new Error('Historical value snapshots are unavailable for this source');
      const result = await options.historicalSnapshot(req);
      alive(req);
      alignRequestedExpression([], result, () => ({}));
      return result;
    }
    const base = wire(req), plan = feed.resolve({ ...base, from: req.from, to: req.to });
    const key = JSON.stringify([plan.market.key, req.symbol, req.exchange, req.interval, dataVariantKey(req.variant)]);
    let entry = cache.get(key);
    if (entry && now() - entry.stored > 300) { cache.delete(key); entry = undefined; }
    let bars = entry ? entry.bars.map(bar => ({ ...bar })) : [];
    let cursor = entry?.from ?? req.from, exhausted = entry?.exhausted ?? false;
    if (!entry || req.from < entry.from || req.to > entry.to) {
      const from = !entry || req.from < entry.from ? req.from : entry.to;
      if (req.to > from) bars = merge(bars, await pool.getBars({ ...base, from, to: req.to }));
      cursor = Math.min(cursor, req.from);
    }
    let result = snapshot(bars.filter(bar => bar.time < req.to), req);
    const eligible = (): number => result.bars.filter((bar, i) => bar.time < req.from
      && result.confirmed[i] && result.availableAt[i] !== null && result.availableAt[i]! <= req.from).length;
    // A window is sized to the bars still needed, so eighteen 15-minute bars
    // is four and a half hours: a weekend or a holiday is many empty windows in
    // a row. Each empty one doubles the next, and history is only declared
    // missing once the empty run is four windows long and spans more than
    // EMPTY_SPAN, so a closed market is crossed in a few reads while a source
    // with nothing older still fails honestly. A daily window already spans
    // weeks, so daily warmup stops after four empty windows as it always did.
    let emptyPages = 0, emptySince = cursor, growth = 1;
    for (let calls = 0; eligible() < warmup && !exhausted; calls++) {
      if (calls >= 512 || bars.length >= 100_000) throw new Error('Timeframe warmup history limit reached');
      const before = cursor;
      const page = await pool.getBarsPage({ ...base, before, countBack: Math.max(1, warmup - eligible()) * growth });
      bars = merge(page.bars, bars);
      const next = page.nextBefore ?? page.bars[0]?.time;
      exhausted = page.hasMore === false || (plan.source.earliest !== undefined && next !== undefined && next <= plan.source.earliest);
      if (!exhausted && (next === undefined || next >= cursor)) throw new Error('Warmup history page did not advance');
      if (page.bars.length === 0) {
        if (emptyPages === 0) emptySince = before;
        emptyPages++;
        growth = Math.min(growth * 2, MAX_EMPTY_GROWTH);
      } else {
        emptyPages = 0;
        growth = 1;
      }
      if (next !== undefined) cursor = Math.min(cursor, next);
      if (!exhausted && emptyPages >= 4 && emptySince - cursor > EMPTY_SPAN) {
        throw new Error('Insufficient confirmed history: no source bars in more than 30 days before the warmup');
      }
      result = snapshot(bars.filter(bar => bar.time < req.to), req);
    }
    alive(req);
    // Unknown availability is a barrier. Cache only the confirmed prefix so
    // subsequent reads refetch every mutable/unknown observation after it.
    let closed = 0;
    while (closed < result.bars.length && result.confirmed[closed] && result.availableAt[closed] !== null) closed++;
    remember(key, { bars: result.bars.slice(0, closed), from: cursor, to: result.bars[closed]?.time ?? req.to, exhausted, stored: entry?.stored ?? now() });
    return result;
  };
  return { supportsWarmup: true, requestBars: req => pool.getBars({ ...wire(req), from: req.from, to: req.to }), requestSnapshot };
}
