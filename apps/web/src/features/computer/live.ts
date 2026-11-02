import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useRealtime, useRealtimeStatus } from '../transcript/realtime.js';
import {
  applyComputerStatus,
  applyScreenControl,
  computerQuery,
  restartComputer,
  startComputer,
  type Computer,
  type ComputerState,
} from './api.js';

// The account's computer kept current from the shared socket:
// `computer.status` reaches every socket of the owner, `screen.control` comes
// with the Bot subscriptions the shell already holds. An event the cache cannot
// place (no computer yet, a new screen) refetches instead, and so does every
// (re)connect: a start the server began on its own (the Mac app's launch, an
// owner's message, plan 9.5) may have moved on before the socket was open.

export function useComputer() {
  const query = useQuery(computerQuery);
  const { client } = useRealtime();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    const write = (next: ComputerState | undefined) => {
      if (next) queryClient.setQueryData(computerQuery.queryKey, next);
      else void queryClient.invalidateQueries({ queryKey: computerQuery.queryKey, exact: true });
    };
    const current = () => queryClient.getQueryData(computerQuery.queryKey);
    const offStatus = client.on('computer.status', (event) => {
      write(applyComputerStatus(current(), event));
      setError(event.payload.status === 'error' ? (event.payload.error ?? null) : null);
    });
    const offControl = client.on('screen.control', (event) => {
      write(applyScreenControl(current(), event));
    });
    return () => {
      offStatus();
      offControl();
    };
  }, [client, queryClient]);

  const { status } = useRealtimeStatus();
  useEffect(() => {
    if (status === 'open') {
      void queryClient.invalidateQueries({ queryKey: computerQuery.queryKey, exact: true });
    }
  }, [status, queryClient]);

  return { ...query, statusError: error };
}

/** Writes a computer the server answered into the cached state. */
export function useWriteComputer() {
  const queryClient = useQueryClient();
  return (computer: Computer | null) =>
    queryClient.setQueryData(computerQuery.queryKey, (state: ComputerState | undefined) => ({
      available: state?.available ?? true,
      computer: computer ?? state?.computer ?? null,
    }));
}

/**
 * The owner's Start (Computer page, Preview, file browser): the only way the
 * UI starts the computer besides taking a screen over. File listings refetch
 * once it runs.
 */
export function useStartComputer() {
  const queryClient = useQueryClient();
  const write = useWriteComputer();
  return useMutation({
    mutationFn: startComputer,
    onSuccess: (computer) => {
      write(computer);
      void queryClient.invalidateQueries({ queryKey: ['computer', 'files'] });
    },
  });
}

/** The Computer page's Restart; file listings refetch once it runs again. */
export function useRestartComputer() {
  const queryClient = useQueryClient();
  const write = useWriteComputer();
  return useMutation({
    mutationFn: restartComputer,
    onSuccess: (computer) => {
      write(computer);
      void queryClient.invalidateQueries({ queryKey: ['computer', 'files'] });
    },
  });
}

/** Refetches the computer's state, e.g. after a socket closed because it is off. */
export function useRefreshComputer() {
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: computerQuery.queryKey, exact: true }),
    [queryClient],
  );
}
