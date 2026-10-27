/**
 * An OHLC bar's weight follows the zoom. Packed bars stay hairlines, and as
 * zooming in gives each bar room the range and both ticks grow bolder, so a
 * zoomed-in bar chart reads as bars rather than threads between wide gaps.
 * Before 2.6.8 the stroke was one device pixel at every spacing.
 */
import { describe, it, expect } from 'vitest';
import type { Bar } from '../src/model/bar';
import { barStrokeWidth, drawBars } from '../src/render/bars';
import { optimalBarWidth } from '../src/render/candles';
import { makeCtx } from './helpers/fake-ctx';

const toY = (v: number): number => 200 - v;
const bar: Bar = { time: 1, open: 110, high: 140, low: 60, close: 90 };

/** The rectangles one bar draws: [x, y, w, h] each, range first, then open and close ticks. */
function rects(spacing: number, dpr: number, highLowOnly = false): number[][] {
  const { ctx, rec } = makeCtx();
  drawBars(ctx, [{ x: 100, bar }], toY, spacing, dpr, { upColor: '#0a0', downColor: '#a00' }, highLowOnly);
  return rec.ops.filter(o => o.type === 'fillRect').map(o => o.args as number[]);
}

describe('OHLC bar stroke', () => {
  it('draws packed bars exactly as before: a one pixel range and ticks on the price', () => {
    const tick = Math.max(1, Math.floor(optimalBarWidth(6, 1) / 2));
    expect(rects(6, 1)).toEqual([
      [100, 60, 1, 80], // high 140 to low 60
      [100 - tick, 90, tick, 1], // open 110
      [100, 110, tick, 1], // close 90
    ]);
  });

  it('grows with the bar spacing and the device pixel ratio', () => {
    const widths = [4, 6, 10, 15, 20, 33, 60].map(spacing => barStrokeWidth(spacing, 1));
    expect(widths).toEqual([1, 1, 2, 3, 4, 6, 12]);
    expect(barStrokeWidth(20, 2)).toBe(8);
    expect(barStrokeWidth(4, 2)).toBe(2); // never below a device pixel
  });

  it('gives a zoomed-in bar ticks as thick as its range, centred on open and close, and longer than half the stroke', () => {
    const [range, open, close] = rects(33, 1);
    expect(range).toEqual([97, 60, 6, 80]);
    expect(open![3]).toBe(6);
    expect(close![3]).toBe(6);
    // Centred on the price: open 110 is y 90, close 90 is y 110.
    expect(open![1]).toBe(87);
    expect(close![1]).toBe(107);
    // Each tick shows beyond the stroke on its own side.
    expect(open![0]).toBeLessThan(range![0]!);
    expect(close![0]! + close![2]!).toBeGreaterThan(range![0]! + range![2]!);
  });

  it('thickens a high-low bar the same way and still draws no ticks', () => {
    expect(rects(33, 1, true)).toEqual([[97, 60, 6, 80]]);
  });
});
