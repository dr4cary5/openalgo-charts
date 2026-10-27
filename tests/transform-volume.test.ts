import { describe, expect, it } from 'vitest';
import { Chart, generateBars, registerIndicator, type Bar } from '../src/index';
import {
  registerTransformChartTypes, runTransform, HeikinAshiTransform, KagiTransform, LineBreakTransform,
  PointFigureTransform, RangeBarsTransform, RenkoTransform,
} from '../src/transform/index';
import type { ISeriesTransform } from '../src/transform/transform';
import '../src/indicators/index';
import { fakeDocument } from './helpers/fake-dom';

registerTransformChartTypes();

// A price-driven element is many source bars, or a part of one. Until 2.6.8
// Renko, range bars, line break and point and figure emitted elements with no
// volume at all, so every study reading volume on those charts (On-Balance
// Volume, VWAP, a host's own Weis Wave) read nothing and drew a flat zero,
// while the same studies worked on every time-based chart.

function makeChart(): Chart {
  const chart = new Chart(fakeDocument().createElement('div'), {
    document: fakeDocument(),
    pixelRatio: () => 1,
    shortcuts: false,
    raf: { schedule: (cb: () => void) => { cb(); return 1; }, cancel: () => {} },
  });
  chart.applySize(800, 600);
  return chart;
}

const T = 1_700_000_000;
const bar = (i: number, close: number, volume?: number, open = close): Bar => ({
  time: T + i * 60, open, high: Math.max(open, close), low: Math.min(open, close), close,
  ...(volume === undefined ? {} : { volume }),
});
const walk = (count: number): Bar[] => generateBars(T, count, 60);
const total = (bars: readonly Bar[]): number => bars.reduce((sum, b) => sum + (b.volume ?? 0), 0);

/** Every element a transform forms, with the index of the source bar that completed each. */
function formed(transform: ISeriesTransform, bars: readonly Bar[]): { elements: Bar[]; by: number[] } {
  transform.reset();
  const elements: Bar[] = [];
  const by: number[] = [];
  bars.forEach((b, i) => { for (const e of transform.push(b)) { elements.push(e); by.push(i); } });
  return { elements, by };
}

describe('volume on price-driven elements', () => {
  it('gives a Renko brick the volume traded while it formed, all of it on the first brick a bar completes', () => {
    const bars = [
      bar(0, 100, 10), // anchor, no brick yet
      bar(1, 100.3, 20), // under a box: no brick
      bar(2, 101.6, 30), // three up bricks: 100 to 101.5
      bar(3, 101.7, 5), // no brick
      bar(4, 100.4, 7), // two down bricks: 101.5 to 100.5
    ];
    const { elements } = formed(new RenkoTransform({ boxSize: 0.5 }), bars);
    expect(elements.map(e => [e.open, e.close])).toEqual([[100, 100.5], [100.5, 101], [101, 101.5], [101.5, 101], [101, 100.5]]);
    expect(elements.map(e => e.volume)).toEqual([60, 0, 0, 12, 0]);
  });

  it('gives a range bar the volume of every bar inside it, including the one still forming', () => {
    const bars = [bar(0, 100, 4), bar(1, 100.4, 6), bar(2, 101, 9), bar(3, 101.2, 3), bar(4, 101.5, 2)];
    const t = new RangeBarsTransform({ range: 1 });
    const { elements } = formed(t, bars);
    expect(elements.map(e => e.volume)).toEqual([19]);
    expect(t.flush().map(e => e.volume)).toEqual([5]);
  });

  it('gives a line break line the volume since the line before it', () => {
    const bars = [bar(0, 100, 8), bar(1, 101, 2), bar(2, 100.5, 3), bar(3, 102, 4), bar(4, 99, 6)];
    const { elements } = formed(new LineBreakTransform({ lines: 3 }), bars);
    // 100 opens; 101 breaks up (8 + 2); 100.5 does not break; 102 breaks up (3 + 4); 99 breaks down.
    expect(elements.map(e => e.close)).toEqual([101, 102, 99]);
    expect(elements.map(e => e.volume)).toEqual([10, 7, 6]);
  });

  it('gives a point and figure column its own bars, the reversal bar opening the next one', () => {
    const bars = [
      bar(0, 100, 1), // anchor
      bar(1, 103, 2), // sets direction up: an X column
      bar(2, 105, 4), // extends it
      bar(3, 101, 8), // reverses by 4 boxes: the X column completes, this bar opens the O column
      bar(4, 100, 16), // extends the O column
    ];
    const t = new PointFigureTransform({ boxSize: 1, reversal: 3, method: 'close' });
    const { elements } = formed(t, bars);
    expect(elements).toHaveLength(1);
    expect(elements[0]!.volume).toBe(1 + 2 + 4);
    // The column in progress carries the reversal bar and every bar after it.
    expect(t.flush().map(e => e.volume)).toEqual([8 + 16]);
  });

  it('loses and doubles no volume over a long walk, through flush and on every transform', () => {
    const bars = walk(2000);
    const cases: [string, () => ISeriesTransform][] = [
      ['renko', () => new RenkoTransform({ boxSize: 0.5 })],
      ['renko hl', () => new RenkoTransform({ boxSize: 0.5, method: 'hl' })],
      ['renko atr', () => new RenkoTransform({ mode: 'atr' })],
      ['range bars', () => new RangeBarsTransform({ range: 1 })],
      ['line break', () => new LineBreakTransform({ lines: 3 })],
      ['point and figure', () => new PointFigureTransform({ boxSize: 0.5, reversal: 3 })],
    ];
    for (const [name, make] of cases) {
      const { elements, by } = formed(make(), bars);
      expect(elements.length, name).toBeGreaterThan(20);
      expect(elements.every(e => typeof e.volume === 'number' && e.volume >= 0), name).toBe(true);
      if (name === 'point and figure') {
        // A completed column holds the bars before the reversal that closed it.
        const last = by[by.length - 1]!;
        expect(total(elements), name).toBe(total(bars.slice(0, last)));
      } else {
        expect(total(elements), name).toBe(total(bars.slice(0, by[by.length - 1]! + 1)));
      }
    }
  });

  it('leaves elements without a volume when no bar reports one, exactly as before', () => {
    const bars = walk(400).map(({ volume: _drop, ...rest }) => rest);
    for (const t of [new RenkoTransform({ boxSize: 0.5 }), new RangeBarsTransform({ range: 1 }),
      new LineBreakTransform({ lines: 3 }), new PointFigureTransform({ boxSize: 0.5, reversal: 3 })]) {
      const elements = runTransform(t, bars);
      expect(elements.length).toBeGreaterThan(5);
      expect(elements.some(e => 'volume' in e)).toBe(false);
    }
  });

  it('does not change Heikin Ashi or Kagi', () => {
    const bars = walk(300);
    expect(runTransform(new HeikinAshiTransform(), bars).map(e => e.volume)).toEqual(bars.map(b => b.volume));
    // Kagi keeps its line thickness in volume, which its renderer reads.
    const kagi = runTransform(new KagiTransform({ reversal: 0.5 }), bars);
    expect(kagi.length).toBeGreaterThan(5);
    expect(kagi.every(e => e.volume === 0 || e.volume === 1)).toBe(true);
  });
});

describe('volume studies on a transformed chart', () => {
  registerIndicator({
    id: 'volume-probe', name: 'Volume probe', placement: 'pane', inputs: [],
    plots: [{ key: 'value', type: 'line', title: 'Volume' }],
    calc: bars => ({ value: bars.map(b => (typeof b.volume === 'number' ? b.volume : null)) }),
  });

  it('feeds On-Balance Volume and a host study the bricks\' volume, history and live', () => {
    const chart = makeChart();
    const series = chart.addSeries('candlestick');
    const bars = walk(600);
    series.setData(bars.slice(0, 500));
    chart.setSeriesTransform(series, { type: 'renko', options: { boxSize: 0.5 } });
    const obv = chart.addIndicator('obv');
    const probe = chart.addIndicator('volume-probe');

    const check = (): void => {
      const bricks = chart.primaryBars();
      expect(bricks.length).toBeGreaterThan(20);
      const seen = probe.values().value!;
      expect(seen).toEqual(bricks.map(b => b.volume ?? null));
      expect(seen.every(v => typeof v === 'number')).toBe(true);
      const values = obv.values().obv!;
      // The flat zero the trader saw: every value 0. Now it moves with the bricks.
      expect(values.some(v => typeof v === 'number' && v !== 0)).toBe(true);
      let acc = 0;
      const expected = bricks.map((b, i) => {
        if (i > 0) acc += b.close > bricks[i - 1]!.close ? b.volume! : b.close < bricks[i - 1]!.close ? -b.volume! : 0;
        return acc;
      });
      expect(values).toEqual(expected);
    };
    check();
    // Live: ticks on a forming bar, then new bars, through the chart's own run.
    for (const b of bars.slice(500)) {
      series.update({ ...b, close: b.open, high: b.open, low: b.open, volume: 1 });
      series.update(b);
    }
    check();
    // And the live run matches the batch transform of the same bars, volume included.
    expect(chart.primaryBars()).toEqual(runTransform(new RenkoTransform({ boxSize: 0.5 }), bars));
  });
});
