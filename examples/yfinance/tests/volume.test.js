import { describe, expect, it, vi } from 'vitest';
import { initVolume, refreshVolume, volumePoint, volumeAverage, volumeAveragePoint, volumeValues } from '../src/volume.js';

describe('reference volume', () => {
  it('matches candle overrides and previous-close direction', () => {
    const bar = { time: 1, open: 100, high: 102, low: 98, close: 101, volume: 50 };
    const style = { upColor: '#11aa22', downColor: '#cc3344', colorByPreviousClose: true };
    expect(volumePoint(bar, 102, style, true).color).toBe('#cc3344');
    expect(volumePoint(bar, undefined, style, true).color).toBe('#11aa22');
    expect(volumePoint({ ...bar, color: '#123456' }, 102, style, true).color).toBe('#123456');
    expect(volumePoint(bar, 102, style, false).color).toBeUndefined();
  });

  it('keeps the average warmup and unknown volume as gaps and computes a live tail from one window', () => {
    const bars = [10, 20, 30, 40].map((close, time) => ({ time, close }));
    expect(volumeAverage(bars, 3).map(bar => bar.close)).toEqual([NaN, NaN, 20, 30]);
    bars[3].close = 60;
    expect(volumeAveragePoint(bars, 3, 3).close).toBeCloseTo(110 / 3);
    bars.push({ time: 4, close: 50 });
    expect(volumeAveragePoint(bars, 4, 3).close).toBeCloseTo(140 / 3);
    bars[2].close = NaN;
    expect(volumeAverage(bars, 3).map(bar => bar.close)).toEqual([NaN, NaN, NaN, NaN, NaN]);
    expect(volumePoint({ time: 1, open: 1, close: 2 }, undefined, {}, true).close).toBeNaN();
  });

  it('validates saved values and limits averaging windows', () => {
    expect(volumeValues({ 'volume.maPeriod': 0, 'volume.showMA': 'yes', extra: true }))
      .toMatchObject({ 'volume.maPeriod': 1, 'volume.showMA': false });
    expect(volumeValues({ 'volume.maPeriod': 501 })['volume.maPeriod']).toBe(500);
    expect(volumeValues({ 'volume.maPeriod': NaN })['volume.maPeriod']).toBe(20);
    expect(volumeValues({ 'volume.maStyle': 'invalid' })['volume.maStyle']).toBe('solid');
  });
});

describe('volume pane on a transformed chart', () => {
  // A tick on a chart whose transform forms elements at times of its own can
  // complete several bricks or withdraw a provisional one, but arrives as one
  // update, so the pane takes the whole histogram again rather than its last
  // point, which would leave a gap or a stale bar on the shared axis.
  const run = (transform) => {
    const bars = [1, 2, 3].map(i => ({ time: i, open: i, high: i, low: i, close: i + 0.5, volume: i * 10 }));
    const series = () => ({ applyOptions: vi.fn(), setData: vi.fn(), update: vi.fn() });
    const app = {
      chart2: {
        primaryBars: () => bars,
        theme: () => ({ upColor: '#0a0', downColor: '#a00' }),
        primarySeriesInfo: () => ({ style: {} }),
        primarySeries: () => ({}),
        seriesTransform: () => (transform ? { type: transform } : null),
      },
      volume2: series(), volumeMA2: series(), volLegend2: null, volumeReadings2: new Map(),
    };
    // initVolume listens for theme changes on the page; these tests have none.
    vi.stubGlobal('document', { addEventListener: () => {} });
    try {
      initVolume(app);
      refreshVolume(2, { kind: 'update', time: 3 });
    } finally {
      vi.unstubAllGlobals();
    }
    return app.volume2;
  };

  it('rebuilds the histogram on a live update for Renko and the other element-forming transforms', () => {
    for (const kind of ['renko', 'range-bars', 'line-break', 'point-figure']) {
      const histogram = run(kind);
      expect(histogram.update, kind).not.toHaveBeenCalled();
      expect(histogram.setData, kind).toHaveBeenCalledTimes(1);
      expect(histogram.setData.mock.calls[0][0].map(point => point.close), kind).toEqual([10, 20, 30]);
    }
  });

  it('updates the last point in place on candles and Heikin Ashi', () => {
    for (const kind of [null, 'heikin-ashi']) {
      const histogram = run(kind);
      expect(histogram.setData, String(kind)).not.toHaveBeenCalled();
      expect(histogram.update.mock.calls[0][0], String(kind)).toMatchObject({ time: 3, close: 30 });
    }
  });
});
