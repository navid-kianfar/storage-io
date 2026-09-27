import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Combobox, type ComboboxOption } from './Combobox';
import { renderWithProviders } from '@/test/render';

const OPTIONS: readonly ComboboxOption[] = [
  { value: 'minio-prod-01', label: 'minio-prod-01', description: 'MinIO · us-east-1' },
  { value: 'seaweed-archive', label: 'seaweed-archive', description: 'SeaweedFS · dc-2' },
  { value: 'ceph-lab', label: 'ceph-lab', description: 'Ceph RGW · lab', keywords: ['rados'] },
];

function Harness({ clearable = false }: { readonly clearable?: boolean }) {
  const [value, setValue] = useState<string | null>(null);
  return (
    <Combobox
      aria-label="Server"
      options={OPTIONS}
      value={value}
      onValueChange={setValue}
      clearable={clearable}
    />
  );
}

describe('Combobox', () => {
  it('shows the placeholder until something is chosen, then the label', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    const trigger = screen.getByRole('combobox', { name: 'Server' });
    expect(trigger).toHaveTextContent('Select an option');

    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: /seaweed-archive/ }));

    expect(screen.getByRole('combobox', { name: 'Server' })).toHaveTextContent('seaweed-archive');
  });

  it('filters on the label, the description and the hidden keywords', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    await user.click(screen.getByRole('combobox', { name: 'Server' }));
    const search = screen.getByRole('combobox', { name: '' });

    await user.type(search, 'dc-2');
    expect(screen.getByRole('option', { name: /seaweed-archive/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /minio-prod-01/ })).not.toBeInTheDocument();

    await user.clear(search);
    // "rados" appears nowhere on screen; it is a keyword on the Ceph option.
    await user.type(search, 'rados');
    expect(screen.getByRole('option', { name: /ceph-lab/ })).toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    await user.click(screen.getByRole('combobox', { name: 'Server' }));
    await user.type(screen.getByRole('combobox', { name: '' }), 'nothing-like-this');

    expect(screen.getByText('No option matches')).toBeInTheDocument();
  });

  it('clears back to nothing when clearable', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness clearable />);

    await user.click(screen.getByRole('combobox', { name: 'Server' }));
    await user.click(await screen.findByRole('option', { name: /ceph-lab/ }));
    expect(screen.getByRole('combobox', { name: 'Server' })).toHaveTextContent('ceph-lab');

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByRole('combobox', { name: 'Server' })).toHaveTextContent('Select an option');
  });
});
