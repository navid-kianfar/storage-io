import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useObjectListing } from './api';
import { api } from '@/lib/api/client';

/**
 * The object browser reaches its bucket by opaque id and only learns the
 * (serverId, bucket name) pair the listing endpoint is addressed by once
 * `GET /buckets/:bucketId` answers. Until then its scope is the empty
 * placeholder, and an ungated listing query builds
 * `/servers//buckets//objects` — a guaranteed 404 on every cold load of the
 * page, and a console error in a console that is supposed to be clean.
 *
 * So the listing must not fire until the scope is resolved. That is what the
 * page's `scopeReady` flag is for, and this is the regression that flag guards.
 */

function wrapper({ children }: { readonly children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const EMPTY_SCOPE = { serverId: '', bucket: '' } as const;
const RESOLVED_SCOPE = { serverId: 'srv-1', bucket: 'media-assets' } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useObjectListing', () => {
  it('sends no request while the bucket id has not resolved to a scope', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ items: [], prefixes: [] });

    // `enabled` left at its default: an unresolved scope must hold the query on
    // its own, so a caller that forgets to pass the flag still cannot fire it.
    renderHook(() => useObjectListing(EMPTY_SCOPE, { prefix: '', showVersions: false }), { wrapper });

    // Give the query client a chance to start a fetch it should never start.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(get).not.toHaveBeenCalled();
  });

  it('addresses the resolved server and bucket once the scope is ready', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ items: [], prefixes: [] });

    renderHook(() => useObjectListing(RESOLVED_SCOPE, { prefix: '', showVersions: false }, true), { wrapper });

    await waitFor(() => expect(get).toHaveBeenCalled());
    const firstCall = get.mock.calls[0];
    const path = firstCall?.[0];
    expect(path).toBe('/servers/srv-1/buckets/media-assets/objects');
    expect(path).not.toContain('//');
  });
});
