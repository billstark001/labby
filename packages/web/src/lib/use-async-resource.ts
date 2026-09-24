import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

type Status = 'idle' | 'pending' | 'success' | 'error';
type Snapshot<T> = { key: readonly unknown[]; status: Status; data?: T; error?: unknown };

export type AsyncResource<T> = {
  data: T | undefined;
  error: unknown;
  status: Status;
  isPending: boolean;
  isInitialLoading: boolean;
  isRefetching: boolean;
  refetch: () => Promise<T | undefined>;
};

function sameKey(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

/** Successful data survives a refetch of the same key, never a change of identity. */
export function useAsyncResource<T>(query: () => Promise<T>, dependencies: readonly unknown[] = []): AsyncResource<T> {
  const queryRef = useRef(query);
  queryRef.current = query;
  const generation = useRef(0);
  const [snapshot, setSnapshot] = useState<Snapshot<T>>(() => ({ key: dependencies, status: 'idle' }));
  const current = sameKey(snapshot.key, dependencies) ? snapshot : { key: dependencies, status: 'idle' as const };

  const refetch = useCallback(async () => {
    const request = ++generation.current;
    const key = [...dependencies];
    setSnapshot(previous => ({
      key,
      status: 'pending',
      data: sameKey(previous.key, key) ? previous.data : undefined,
    }));
    try {
      const result = await queryRef.current();
      if (request === generation.current) setSnapshot({ key, status: 'success', data: result });
      return result;
    } catch (error) {
      if (request === generation.current) setSnapshot(previous => ({
        key,
        status: 'error',
        data: sameKey(previous.key, key) ? previous.data : undefined,
        error,
      }));
      return undefined;
    }
  }, dependencies);

  useEffect(() => {
    void refetch();
    return () => { generation.current += 1; };
  }, [refetch]);

  const isPending = current.status === 'idle' || current.status === 'pending';
  return {
    data: current.data,
    error: current.error,
    status: current.status,
    isPending,
    isInitialLoading: isPending && current.data === undefined,
    isRefetching: current.status === 'pending' && current.data !== undefined,
    refetch,
  };
}
