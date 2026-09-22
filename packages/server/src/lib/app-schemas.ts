import { z } from 'zod';

export const loginBodySchema = z.object({
  password: z.string().min(1),
  identity: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
}).refine(value => Boolean(value.identity || value.username || value.email), {
  message: 'identity, username, or email is required',
});

export const refreshBodySchema = z.object({
  refresh_token: z.string().min(1),
});

export const issueUserBodySchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(8),
  email: z.string().email().optional(),
  role: z.number().int().min(0).max(1),
});

export const authCodeConfirmSchema = z.object({
  code: z.string().min(4).max(16),
});

export const requestPasswordResetSchema = z.object({
  identity: z.string().min(1),
});

export const confirmPasswordResetSchema = z.object({
  identity: z.string().min(1),
  code: z.string().min(4).max(16),
  newPassword: z.string().min(8),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

export const requestChangeEmailSchema = z.object({
  currentPassword: z.string().min(1),
  newEmail: z.string().email(),
});

export const backupActionSchema = z.object({
  format: z.literal('msgpack').optional(),
  target: z.enum(['email', 'google-drive', 'onedrive']).optional(),
});

export const solverInputSchema = z.object({
  configId: z.string().min(1),
  personIds: z.array(z.string()).optional(),
});

export const solverIncrementalInputSchema = z.object({
  configId: z.string().min(1),
  previousPlanId: z.string().min(1),
  changeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  index: z.number().int().nonnegative().optional(),
  mode: z.enum(['full', 'questioners-only']).optional(),
  personIds: z.array(z.string()).optional(),
}).refine(
  value => value.changeDate !== undefined || value.index !== undefined,
  { message: 'changeDate or index is required' },
);

export const solverMetricsInputSchema = z.object({
  scheduleId: z.string().min(1),
  sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const templatePreviewSchema = z.object({
  templateText: z.string(),
  context: z.record(z.string(), z.unknown()).default({}),
  format: z.enum(['markdown', 'html']).optional(),
  language: z.enum(['en', 'zh-CN', 'ja-JP']).optional(),
});

export const rankingRecommendSchema = z.object({
  size: z.number().int().min(2).max(8).optional(),
  excludedKeys: z.array(z.string().max(2048)).max(200).optional(),
  includeDisabled: z.boolean().optional(),
}).strict();

export const rankingJudgmentSchema = z.object({
  id: z.string().uuid(),
  anchorId: z.string().uuid(),
  groups: z.array(z.array(z.string().uuid()).min(1).max(12)).min(1).max(12),
  confidence: z.number().positive().max(1),
  createdAt: z.number().int().nonnegative(),
}).strict().refine(j => {
  const ids = j.groups.flat();
  return ids.length >= 2 && ids.length <= 12 && new Set(ids).size === ids.length && !ids.includes(j.anchorId);
}, { message: 'Ranking requires 2–12 distinct candidates excluding the anchor' });
