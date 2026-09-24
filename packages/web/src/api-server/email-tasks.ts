import { apiClient } from '@/lib/api';

export async function sendEmailTaskNow(taskId: string, recipients: string[]): Promise<{ sent: number; failed: number }> {
  return apiClient.request(`/db/email-tasks/${encodeURIComponent(taskId)}/send-now`, {
    method: 'POST',
    body: JSON.stringify({ recipients }),
  });
}

export async function setEmailTaskSkipNext(taskId: string, skip: boolean): Promise<void> {
  await apiClient.request(`/db/email-tasks/${encodeURIComponent(taskId)}/skip-next`, {
    method: 'POST',
    body: JSON.stringify({ skip }),
  });
}
