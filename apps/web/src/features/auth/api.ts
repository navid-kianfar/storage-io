import type { LoginRequest, LoginResponse, Me } from '@storage-io/contracts';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { queryKeys } from '@/lib/query/keys';

/**
 * Auth is the one query the whole app waits on: the protected layout renders
 * nothing until `useMe` settles, so a page never briefly renders with no session.
 */

const ME_PATH = '/auth/me';
const LOGIN_PATH = '/auth/login';
const LOGOUT_PATH = '/auth/logout';

export function useMe(): UseQueryResult<Me> {
  return useQuery({
    queryKey: queryKeys.auth.me(),
    queryFn: () => api.get<Me>(ME_PATH),
    // A 401 here is the answer, not a failure worth retrying.
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) => api.post<LoginResponse>(LOGIN_PATH, body),
    onSuccess: (response) => {
      queryClient.setQueryData(queryKeys.auth.me(), response.user);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>(LOGOUT_PATH),
    onSuccess: () => {
      // Everything in the cache belonged to that session.
      queryClient.clear();
    },
  });
}
