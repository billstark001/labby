import { toast } from '@/components/ui/Toast';

let lastToastAt = 0;
let lastToastKey = '';

function shouldDeduplicate(key: string): boolean {
  const now = Date.now();
  if (key === lastToastKey && now - lastToastAt < 1200) {
    return true;
  }
  lastToastKey = key;
  lastToastAt = now;
  return false;
}

export function notifyHttpError(status: number, message: string): void {
  if (status !== 403) return;
  const normalized = message.trim() || 'insufficient permissions';
  const key = `${status}:${normalized}`;
  if (shouldDeduplicate(key)) return;
  toast.error(normalized);
}
