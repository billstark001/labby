import { apiClient } from '@/lib/api';

export async function sendEmailTaskNow(taskId: string): Promise<void> {
  await apiClient.request(`/db/email-tasks/${encodeURIComponent(taskId)}/send-now`, {
    method: 'POST',
  });
}

export async function setEmailTaskSkipNext(taskId: string, skip: boolean): Promise<void> {
  await apiClient.request(`/db/email-tasks/${encodeURIComponent(taskId)}/skip-next`, {
    method: 'POST',
    body: JSON.stringify({ skip }),
  });
}
