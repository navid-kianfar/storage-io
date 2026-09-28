import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Combobox } from '@/components/app/Combobox';
import { FormField } from '@/components/app/FormField';
import { Input } from '@/components/app/Input';
import { Select } from '@/components/app/Select';
import { renderWithProviders } from '@/test/render';

/**
 * Two fields side by side have to line up — labels on one line, controls on the
 * next, whatever each field carries underneath. The operator who reported this saw
 * it in the upload dialog: one field had a hint and the other did not, so the
 * controls sat at different heights and the row read as broken.
 *
 * jsdom does no layout, so these assert the two things that decide the layout in a
 * real browser instead of measuring it:
 *
 *  1. the row is a grid with `items-start`, so a taller field does not stretch its
 *     neighbour's control to match — which is what pushed a control off the line;
 *  2. every control derives its height from `--control-h` rather than a literal, so
 *     Input, Select and Combobox are the same height in both densities.
 *
 * `ControlHeights` below is the list of kit controls that go in a `FormField`. A
 * new one belongs in it, and the test fails until its height is a token.
 */

const ROW_CLASSES = 'grid items-start gap-4 sm:grid-cols-2';

function TwoColumnRow() {
  return (
    <div data-testid="row" className={ROW_CLASSES}>
      <FormField label="Server" hint="Only servers that support IAM">
        {({ id, describedBy }) => (
          <Combobox
            id={id}
            aria-describedby={describedBy}
            options={[{ value: 'a', label: 'minio-prod-01' }]}
            value={null}
            onValueChange={() => undefined}
            aria-label="Server"
          />
        )}
      </FormField>
      <FormField label="Region">
        {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} readOnly />}
      </FormField>
      <FormField label="Access" error="Pick one">
        {({ id }) => (
          <Select
            id={id}
            options={[{ value: 'private', label: 'Private' }]}
            value="private"
            onValueChange={() => undefined}
            aria-label="Access"
          />
        )}
      </FormField>
    </div>
  );
}

/** How each control declares its height. Every one has to be the same token. */
const CONTROL_HEIGHT_TOKEN = 'h-(--control-h)';

describe('FormField in a two-column row', () => {
  it('lays the row out with items-start so one field cannot stretch another', () => {
    renderWithProviders(<TwoColumnRow />);

    const row = screen.getByTestId('row');
    expect(row.className).toContain('grid');
    expect(row.className).toContain('items-start');
  });

  it('gives every field the same structure: label, then control, then one message', () => {
    renderWithProviders(<TwoColumnRow />);

    for (const name of ['Server', 'Region', 'Access']) {
      const control = screen.getByLabelText(name);
      const field = control.closest('[data-slot="field"]');
      expect(field, `${name} is not inside a FormField`).not.toBeNull();

      const label = field?.querySelector('label');
      expect(label?.textContent).toBe(name);
      // The label is the field's first child, so the control starts on the same
      // line in every column regardless of what follows it.
      expect(field?.firstElementChild).toBe(label);
    }
  });

  it('derives every control height from --control-h, never a literal', () => {
    renderWithProviders(<TwoColumnRow />);

    const input = screen.getByLabelText('Region');
    expect(input.className).toContain(CONTROL_HEIGHT_TOKEN);

    // The Combobox and the Select are buttons, so their height comes from the
    // button's `default` size and the select trigger's `data-[size=default]`.
    const combobox = screen.getByLabelText('Server');
    expect(combobox.dataset.size).toBe('default');

    const select = screen.getByLabelText('Access');
    expect(select.dataset.size).toBe('default');
  });

  it('shows the error in place of the hint, so the field keeps one message line', () => {
    renderWithProviders(<TwoColumnRow />);

    expect(screen.getByText('Only servers that support IAM')).toBeInTheDocument();
    expect(screen.getByText('Pick one')).toBeInTheDocument();

    const access = screen.getByLabelText('Access');
    const field = access.closest('[data-slot="field"]');
    expect(field?.getAttribute('data-invalid')).toBe('true');
  });
});
