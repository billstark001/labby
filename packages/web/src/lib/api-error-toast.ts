import { toast } from '@/components/ui/Toast';
import { i18n } from '@/i18n';

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
  if (status !== 403 && status < 500) return;
  const normalized = status >= 500 ? i18n.t('serviceTemporarilyUnavailable', String(status)) : message.trim() || i18n.t('insufficientPermissions');
  const key = `${status}:${normalized}`;
  if (shouldDeduplicate(key)) return;
  toast.error(normalized);
}
