import { describe, expect, it, vi } from 'vitest';
import type { Bar } from '../src/model/bar';
import type { IndicatorSnapshotRequest } from '../src/model/indicator-registry';
import { SessionCalendar } from '../src/feed/instrument';
import type { BarsPageRequest, BarsRequest } from '../src/feed/types';
import { withTimeframes } from '../src/feed/timeframe-feed';
import { createTimeframeProvider } from '../src/indicators/timeframe-provider';

const day = 86400, first = Date.parse('2025-01-01T00:00:00Z') / 1000;
const calendar = new SessionCalendar({ timezone: 'UTC', sessions: ['0900-1600:23456'] });
const history: Bar[] = Array.from({ length: 400 }, (_, i) => first + i * day)
  .filter(time => ![0, 6].includes(new Date(time * 1000).getUTCDay()))
  .map((time, i) => ({ time, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i }));
const req: IndicatorSnapshotRequest = { symbol: 'TEST', exchange: 'TEST', interval: 'D', from: history[230]!.time, to: history[235]!.time, warmupBars: 200 };
function fixture(input = history) {
  let revision = 'v1';
  const getBars = vi.fn(async (r: BarsRequest) => input.filter(bar => bar.time >= r.from! && bar.time < r.to!));
  const getBarsPage = vi.fn(async (r: BarsPageRequest) => {
    const eligible = input.filter(bar => bar.time < r.before);
    return { bars: eligible.slice(-5), hasMore: eligible.length > 5, nextBefore: eligible[Math.max(0, eligible.length - 5)]?.time ?? first };
  });
  const feed = withTimeframes({ getBars, getBarsPage }, { market: () => ({ key: revision, calendar, sources: [{ interval: 'D', earliest: first, bounds: time => ({ time, from: time, to: time + day }) }] }) });
  const availability = vi.fn((bar: Readonly<Bar>) => ({ at: bar.time + 16 * 3600, confirmed: true }));
  return { feed, getBars, getBarsPage, availability, revise: () => { revision = 'v2'; } };
}

describe('independent timeframe snapshots', () => {
  it('bounds empty-window traversal when a new listing has no retention metadata', async () => {
    const input = history.slice(220, 230);
    const getBars = vi.fn(async (r: BarsRequest) => input.filter(bar => bar.time >= r.from! && bar.time < r.to!));
    const feed = withTimeframes({ getBars }, { market: () => ({ key: 'new-listing', calendar, sources: [
      { interval: 'D', bounds: time => ({ time, from: time, to: time + day }) },
    ] }) });
    const provider = createTimeframeProvider(feed, { availability: bar => ({ at: bar.time + day, confirmed: true }) });
    await expect(provider.requestSnapshot!(req)).rejects.toThrow(/Insufficient.*history/i);
    expect(getBars.mock.calls.length).toBeLessThanOrEqual(6);
    feed.destroy();
  });
  it('continues after one empty window instead of assuming history is exhausted', async () => {
    const f = fixture();
    f.getBarsPage.mockResolvedValueOnce({ bars: [], hasMore: true, nextBefore: req.from - 1 });
    const result = await createTimeframeProvider(f.feed, { availability: f.availability }).requestSnapshot!(req);
    expect(result.bars.filter(bar => bar.time < req.from)).toHaveLength(200);
    f.feed.destroy();
  });

  it('loads 200 observations before an intraday window despite weekends and short pages', async () => {
    const f = fixture(), provider = createTimeframeProvider(f.feed, { availability: f.availability });
    const result = await provider.requestSnapshot!(req);
    expect(result.bars.filter(bar => bar.time < req.from)).toHaveLength(200);
    expect(result.bars[result.bars.length - 1]!.time).toBe(history[234]!.time);
    expect(f.getBarsPage).toHaveBeenCalledTimes(40);
    expect(provider.supportsWarmup).toBe(true);
    f.feed.destroy();
  });
  it('does not fabricate observations for a newly listed instrument', async () => {
    const f = fixture(history.slice(110, 235));
    const provider = createTimeframeProvider(f.feed, { availability: f.availability });
    expect((await provider.requestSnapshot!(req)).bars.filter(bar => bar.time < req.from)).toHaveLength(120);
    f.feed.destroy();
  });
  it('does not download daily history on each tick and keeps a stable oldest seed', async () => {
    const f = fixture(), provider = createTimeframeProvider(f.feed, { availability: f.availability });
    const initial = await provider.requestSnapshot!(req);
    const pages = f.getBarsPage.mock.calls.length, reads = f.getBars.mock.calls.length;
    const again = await provider.requestSnapshot!({ ...req });
    expect(again).toEqual(initial);
    expect(f.getBarsPage).toHaveBeenCalledTimes(pages);
    expect(f.getBars).toHaveBeenCalledTimes(reads);
    const advanced = await provider.requestSnapshot!({ ...req, from: history[231]!.time, to: history[236]!.time });
    expect(advanced.bars[0]!.time).toBe(initial.bars[0]!.time);
    expect(f.getBars.mock.calls[f.getBars.mock.calls.length - 1]![0].from).toBeGreaterThanOrEqual(req.to);
    f.feed.destroy();
  });
  it('calendar revision invalidates cached availability and variants have separate identities', async () => {
    const f = fixture(), provider = createTimeframeProvider(f.feed, { availability: f.availability });
    await provider.requestSnapshot!(req);
    const before = f.getBarsPage.mock.calls.length;
    f.revise();
    await provider.requestSnapshot!(req);
    expect(f.getBarsPage.mock.calls.length).toBeGreaterThan(before);
    await provider.requestSnapshot!({ ...req, variant: { adjustment: 'raw' } });
    expect(f.getBars.mock.calls[f.getBars.mock.calls.length - 1]![0].variant).toEqual({ adjustment: 'raw' });
    f.feed.destroy();
  });
  it('rejects asOf without historical versions', async () => {
    const f = fixture(), provider = createTimeframeProvider(f.feed, { availability: f.availability });
    await expect(provider.requestSnapshot!({ ...req, asOf: req.to })).rejects.toThrow(/historical/i);
    expect(f.getBars).not.toHaveBeenCalled();
    const historicalSnapshot = vi.fn(async () => ({ bars: [], confirmed: [], availableAt: [] }));
    await createTimeframeProvider(f.feed, { availability: f.availability, historicalSnapshot }).requestSnapshot!({ ...req, asOf: req.to });
    expect(historicalSnapshot).toHaveBeenCalledTimes(1);
    f.feed.destroy();
  });
  it('preserves unknown availability and refreshes a forming tail', async () => {
    const f = fixture();
    let closed = false;
    const provider = createTimeframeProvider(f.feed, { availability: bar => ({ at: bar.time === history[234]!.time && !closed ? null : bar.time + 16 * 3600, confirmed: closed || bar.time < history[234]!.time }) });
    const initial = await provider.requestSnapshot!(req);
    expect(initial.availableAt[initial.availableAt.length - 1]).toBeNull();
    closed = true;
    const final = await provider.requestSnapshot!(req);
    expect(final.confirmed[final.confirmed.length - 1]).toBe(true);
    expect(f.getBars.mock.calls[f.getBars.mock.calls.length - 1]![0].from).toBe(history[234]!.time);
    f.feed.destroy();
  });
  it('one cancelled consumer does not cancel another and failures are retryable', async () => {
    const f = fixture(), provider = createTimeframeProvider(f.feed, { availability: f.availability });
    const controller = new AbortController();
    const one = provider.requestSnapshot!({ ...req, signal: controller.signal });
    const two = provider.requestSnapshot!(req);
    controller.abort();
    await expect(one).rejects.toMatchObject({ name: 'AbortError' });
    expect((await two).bars.length).toBeGreaterThan(200);
    f.revise();
    f.getBars.mockRejectedValueOnce(new Error('unavailable'));
    await expect(provider.requestSnapshot!(req)).rejects.toThrow('unavailable');
    expect((await provider.requestSnapshot!(req)).bars.length).toBeGreaterThan(200);
    f.feed.destroy();
  });
});

describe('warmup across a weekend or a holiday', () => {
  // An intraday study pages back in windows sized to the bars it still needs:
  // eighteen 15-minute bars is a four and a half hour window. Before 2.6.8 four
  // empty windows in a row ended the warmup with "insufficient history", so a
  // chart whose history began on a Monday could never reach Friday's bars,
  // and a 15-minute EMA on a 5-minute chart showed an error instead of a line.
  const M15 = 900;
  const weekdays = new SessionCalendar({ timezone: 'UTC', sessions: ['1330-2000:23456'] });
  /** Fifteen-minute bars 13:30 to 20:00 UTC on the given days. */
  const sessionBars = (days: string[]): Bar[] => days.flatMap(d => {
    const open = Date.parse(`${d}T13:30:00Z`) / 1000;
    return Array.from({ length: 26 }, (_, i) => ({ time: open + i * M15, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i }));
  });
  const provider = (input: Bar[]) => {
    const getBars = vi.fn(async (r: BarsRequest) => input.filter(bar => bar.time >= r.from! && bar.time < r.to!));
    const feed = withTimeframes({ getBars }, { market: () => ({ key: 'us', calendar: weekdays, sources: [
      { interval: '15m', bounds: time => ({ time, from: time, to: time + M15 }) },
    ] }) });
    return { feed, getBars, provider: createTimeframeProvider(feed, { availability: bar => ({ at: bar.time + M15, confirmed: true }) }) };
  };
  const monday = Date.parse('2026-09-28T13:30:00Z') / 1000;
  const warmupReq = (from: number): IndicatorSnapshotRequest => ({ symbol: 'AAPL', exchange: 'US', interval: '15m', from, to: from + 26 * M15, warmupBars: 18 });

  it('crosses a weekend to reach the Friday before a Monday', async () => {
    const f = provider(sessionBars(['2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28']));
    const result = await f.provider.requestSnapshot!(warmupReq(monday));
    const before = result.bars.filter(bar => bar.time < monday);
    expect(before.length).toBeGreaterThanOrEqual(18);
    expect(new Date(before[before.length - 1]!.time * 1000).toISOString()).toBe('2026-09-25T19:45:00.000Z');
    f.feed.destroy();
  });

  it('crosses a long holiday weekend, still in a handful of reads', async () => {
    // Thursday, then a Friday holiday and the weekend: four days without a bar.
    const f = provider(sessionBars(['2026-09-23', '2026-09-24', '2026-09-28']));
    const result = await f.provider.requestSnapshot!(warmupReq(monday));
    expect(result.bars.filter(bar => bar.time < monday).length).toBeGreaterThanOrEqual(18);
    expect(f.getBars.mock.calls.length).toBeLessThanOrEqual(12);
    f.feed.destroy();
  });

  it('crosses a weekend even when only a couple of bars are still needed', async () => {
    // The first window finds part of the warmup, so the rest asks for two
    // bars: windows of half an hour, doubling, cover only seven and a half
    // hours in four reads. The weekend still has to be crossed.
    const f = provider(sessionBars(['2026-09-24', '2026-09-25', '2026-09-28']));
    const from = monday + M15;
    const result = await f.provider.requestSnapshot!({ ...warmupReq(from), warmupBars: 3 });
    const before = result.bars.filter(bar => bar.time < from);
    expect(before.length).toBeGreaterThanOrEqual(3);
    // Across the weekend: Friday's bars are in the warmup.
    expect(before.some(bar => new Date(bar.time * 1000).toISOString().startsWith('2026-09-25'))).toBe(true);
    f.feed.destroy();
  });

  it('still says honestly that there is no older history, after a bounded number of reads', async () => {
    const f = provider(sessionBars(['2026-09-28']));
    await expect(f.provider.requestSnapshot!(warmupReq(monday))).rejects.toThrow(/Insufficient confirmed history/);
    expect(f.getBars.mock.calls.length).toBeLessThanOrEqual(60);
    f.feed.destroy();
  });
});
