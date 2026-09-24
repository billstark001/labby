import { useRef, useState } from 'preact/hooks';
import { toast } from '@/components/ui/Toast';

export function usePendingAction() {
  const running = useRef<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: string, work: () => Promise<unknown>): Promise<boolean> {
    if (running.current !== null) return false;
    running.current = key;
    setPendingKey(key);
    setError(null);
    try { await work(); return true; }
    catch (cause) {
      const message = String(cause);
      setError(message);
      toast.error(message);
      return false;
    } finally {
      running.current = null;
      setPendingKey(null);
    }
  }

  return { pendingKey, error, run };
}
