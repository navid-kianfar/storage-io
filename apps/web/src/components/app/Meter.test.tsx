import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { METER_CRIT_RATIO, METER_WARN_RATIO, Meter, meterToneFor } from './Meter';
import { renderWithProviders } from '@/test/render';

describe('meterToneFor', () => {
  it('is neutral below the warn threshold', () => {
    expect(meterToneFor(0)).toBe('default');
    expect(meterToneFor(METER_WARN_RATIO - 0.01)).toBe('default');
  });

  it('warns exactly at 80% and criticals exactly at 90%', () => {
    expect(meterToneFor(METER_WARN_RATIO)).toBe('warn');
    expect(meterToneFor(METER_CRIT_RATIO - 0.001)).toBe('warn');
    expect(meterToneFor(METER_CRIT_RATIO)).toBe('crit');
    expect(meterToneFor(1.4)).toBe('crit');
  });

  it('has no tone when there is no quota', () => {
    expect(meterToneFor(null)).toBe('default');
  });
});

describe('Meter', () => {
  it('exposes the percentage to assistive tech', () => {
    renderWithProviders(<Meter value={0.56} label="Storage used" />);
    const meter = screen.getByRole('meter', { name: 'Storage used' });
    expect(meter).toHaveAttribute('aria-valuenow', '56');
  });

  it('clamps a value over 100% instead of overflowing the bar', () => {
    renderWithProviders(<Meter value={1.4} label="Quota" />);
    expect(screen.getByRole('meter', { name: 'Quota' })).toHaveAttribute('aria-valuenow', '100');
  });

  it('reports no current value when the quota is unknown', () => {
    renderWithProviders(<Meter value={null} label="Quota" />);
    expect(screen.getByRole('meter', { name: 'Quota' })).not.toHaveAttribute('aria-valuenow');
  });
});
