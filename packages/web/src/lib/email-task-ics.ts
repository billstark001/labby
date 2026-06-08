export function getPublicEmailTaskIcsUrl(taskId: string): string {
  const path = `/public/email-tasks/${encodeURIComponent(taskId)}/schedule.ics`;
  if (typeof window === 'undefined') {
    return path;
  }
  return `${window.location.origin}${path}`;
}
