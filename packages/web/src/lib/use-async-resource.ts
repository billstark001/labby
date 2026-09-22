import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

export type AsyncResource<T> = {
  data: T | undefined;
  error: unknown;
  status: 'idle' | 'pending' | 'success' | 'error';
  isPending: boolean;
  isInitialLoading: boolean;
  isRefetching: boolean;
  refetch: () => Promise<T | undefined>;
};

/** Shared content-query state. Keeps stale data visible while a refetch is pending. */
export function useAsyncResource<T>(query: () => Promise<T>, dependencies: readonly unknown[] = []): AsyncResource<T> {
  const queryRef = useRef(query);
  queryRef.current = query;
  const generation = useRef(0);
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [status, setStatus] = useState<AsyncResource<T>['status']>('idle');

  const refetch = useCallback(async () => {
    const request = ++generation.current;
    setStatus('pending');
    setError(undefined);
    try {
      const result = await queryRef.current();
      if (request === generation.current) {
        setData(result);
        setStatus('success');
      }
      return result;
    } catch (reason) {
      if (request === generation.current) {
        setError(reason);
        setStatus('error');
      }
      return undefined;
    }
  }, dependencies);

  useEffect(() => {
    void refetch();
    return () => { generation.current += 1; };
  }, [refetch]);

  const isPending = status === 'pending';
  return {
    data,
    error,
    status,
    isPending,
    isInitialLoading: isPending && data === undefined,
    isRefetching: isPending && data !== undefined,
    refetch,
  };
}
