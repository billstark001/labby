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
  format: z.enum(['sqlite', 'msgpack']).optional(),
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

const embeddingUpdateOptionsSchema = z.object({
  learningRate: z.number().optional(),
  minIters: z.number().int().positive().optional(),
  maxIters: z.number().int().positive().optional(),
  stabilityWindow: z.number().int().positive().optional(),
  stabilityTolerance: z.number().nonnegative().optional(),
}).optional();

export const tripletUpdateSchema = z.object({
  anchorId: z.string().min(1),
  positiveId: z.string().min(1),
  negativeId: z.string().min(1),
  margin: z.number().positive().optional(),
  updateOptions: embeddingUpdateOptionsSchema,
});

export const pairUpdateSchema = z.object({
  leftId: z.string().min(1),
  rightId: z.string().min(1),
  targetDistance: z.number().nonnegative(),
  updateOptions: embeddingUpdateOptionsSchema,
});

export const tripletRecommendSchema = z.object({
  excludedPairs: z.array(z.string().min(3)).optional(),
});

export const supervisionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('pair'),
    leftId: z.string().min(1),
    rightId: z.string().min(1),
    targetDistance: z.number().nonnegative(),
    updateOptions: embeddingUpdateOptionsSchema,
  }),
  z.object({
    kind: z.literal('ranked'),
    anchorId: z.string().min(1),
    orderedIds: z.array(z.string().min(1)).min(2),
    margin: z.number().positive().optional(),
    updateOptions: embeddingUpdateOptionsSchema,
  }),
]);
