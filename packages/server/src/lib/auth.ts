import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';

import { V4 } from '@mpoonuru/paseto';

import { AppError } from './errors.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  UserRole,
  type AuthRole,
  type AuthVerificationCodeRecord,
  type AuthVerificationPurpose,
  type RefreshTokenRecord,
  type SqliteStore,
  type StoredUser,
} from '../store/index.js';

export { UserRole };
export type { AuthRole };

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
}

export interface AuthSession {
  userId: string;
  username: string;
  role: AuthRole;
}

interface AccessTokenPayload {
  typ: 'access';
  jti: string;
  userId: string;
  username: string;
  role: AuthRole;
}

interface RefreshTokenPayload {
  typ: 'refresh';
  jti: string;
  userId: string;
  username: string;
  role: AuthRole;
}

export interface AuthServiceOptions {
  store: SqliteStore;
  issuer: string;
  audience: string;
  accessTtl: string;
  refreshTtl: string;
  accessKey: Buffer | string;
  refreshKey: Buffer | string;
  /** Root user credentials from environment variables (never stored in DB). */
  rootUsername?: string;
  rootPassword?: string;
  rootEmail?: string;
  authCodeTtl?: string;
  sendSecurityMail?: (input: { to: string; subject: string; text: string; html?: string }) => Promise<void>;
}

function parseDurationMs(input: string): number {
  const match = input.trim().match(/^(\d+)\s*([smhd])$/i);
  if (!match) {
    throw new Error(`Unsupported duration: ${input}`);
  }

  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    case 'd': return value * 86_400_000;
    default: throw new Error(`Unsupported duration unit: ${unit}`);
  }
}

export function resolvePasetoKey(secret: string | undefined, purpose: string): Buffer | string {
  const trimmed = secret?.trim();
  if (trimmed?.startsWith('k4.local.')) {
    return trimmed;
  }

  const material = trimmed && trimmed.length > 0
    ? trimmed
    : randomBytes(32).toString('base64url');

  return createHash('sha256').update(`${material}:${purpose}`).digest();
}

export class AuthService {
  private static readonly AUTH_CODE_COOLDOWN_MS = 60_000;
  private readonly refreshTtlMs: number;
  private readonly authCodeTtlMs: number;
  private readonly rootUsername: string | undefined;
  private readonly rootPassword: string | undefined;
  private readonly rootEmail: string | undefined;

  constructor(private readonly options: AuthServiceOptions) {
    this.refreshTtlMs = parseDurationMs(options.refreshTtl);
    this.authCodeTtlMs = parseDurationMs(options.authCodeTtl ?? '15m');
    this.rootUsername = options.rootUsername?.trim() || undefined;
    this.rootPassword = options.rootPassword?.trim() || undefined;
    this.rootEmail = options.rootEmail?.trim() || undefined;
  }

  /** Issue a new user account. Only root can create admins; admin/root can create users. */
  async issueUser(input: {
    username: string;
    password: string;
    role: typeof UserRole.Admin | typeof UserRole.User;
    email?: string;
    issuerRole: AuthRole;
  }): Promise<StoredUser> {
    if (input.role === UserRole.Admin && input.issuerRole !== UserRole.Root) {
      throw new AppError('AUTH_FORBIDDEN', 'only root can issue admin accounts', 403);
    }
    if (input.issuerRole === UserRole.User) {
      throw new AppError('AUTH_FORBIDDEN', 'users cannot issue accounts', 403);
    }
    const existing = await this.options.store.findUserByIdentity(input.username);
    if (existing) {
      throw new AppError('VALIDATION_ERROR', 'username already exists', 409);
    }
    const user: StoredUser = {
      id: randomUUID(),
      username: input.username.trim(),
      email: input.email?.trim(),
      role: input.role,
      passwordHash: hashPassword(input.password),
      disabled: false,
      createdAt: Date.now(),
    };
    await this.options.store.createUser(user);
    return user;
  }

  async getAccountProfile(userId: string): Promise<{ userId: string; username: string; email?: string; emailVerified: boolean; role: AuthRole; }> {
    if (userId === 'root') {
      return {
        userId: 'root',
        username: this.rootUsername ?? 'root',
        email: this.rootEmail,
        emailVerified: Boolean(this.rootEmail),
        role: UserRole.Root,
      };
    }

    const user = await this.options.store.getUserById(userId);
    if (!user || user.disabled) {
      throw new AppError('AUTH_INVALID', 'user is unavailable', 401);
    }
    return {
      userId: user.id,
      username: user.username,
      email: user.email,
      emailVerified: Boolean(user.email && user.emailVerifiedAt),
      role: user.role,
    };
  }

  async requestEmailVerification(userId: string): Promise<void> {
    const user = await this.requireNonRootUser(userId);
    if (!user.email) {
      throw new AppError('VALIDATION_ERROR', 'email is not set for this account', 400);
    }
    const code = this.createVerificationCode();
    await this.issueSecurityCode({
      purpose: 'verify-email',
      userId: user.id,
      targetEmail: user.email,
      pendingEmail: null,
      code,
    });
    await this.sendSecurityMail(user.email, '[Labby] Verify your email', [
      `Verification code: ${code}`,
      `This code expires in ${Math.floor(this.authCodeTtlMs / 60_000)} minutes.`,
    ]);
  }

  async confirmEmailVerification(userId: string, code: string): Promise<void> {
    const user = await this.requireNonRootUser(userId);
    const record = await this.options.store.getLatestActiveAuthVerificationCode({
      purpose: 'verify-email',
      userId: user.id,
    });
    this.assertCodeValid(record, code);
    await this.options.store.consumeAuthVerificationCode(record!.tokenId);

    await this.options.store.updateUser({
      ...user,
      emailVerifiedAt: Date.now(),
    });
  }

  async requestPasswordReset(identity: string): Promise<void> {
    const user = await this.options.store.findUserByIdentity(identity);
    if (!user || user.disabled || !user.email) {
      return;
    }

    const code = this.createVerificationCode();
    await this.issueSecurityCode({
      purpose: 'reset-password',
      userId: user.id,
      targetEmail: user.email,
      pendingEmail: null,
      code,
    });
    await this.sendSecurityMail(user.email, '[Labby] Reset your password', [
      `Password reset code: ${code}`,
      `If you did not request this, you can ignore this email.`,
    ]);
  }

  async confirmPasswordReset(identity: string, code: string, newPassword: string): Promise<void> {
    const user = await this.options.store.findUserByIdentity(identity);
    if (!user || user.disabled) {
      throw new AppError('AUTH_INVALID', 'user is unavailable', 401);
    }
    const record = await this.options.store.getLatestActiveAuthVerificationCode({
      purpose: 'reset-password',
      userId: user.id,
    });
    this.assertCodeValid(record, code);
    await this.options.store.consumeAuthVerificationCode(record!.tokenId);

    await this.options.store.updateUser({
      ...user,
      passwordHash: hashPassword(newPassword),
    });
    await this.options.store.revokeAllRefreshTokensForUser(user.id);
    await this.options.store.pruneExpiredRefreshTokens();
  }

  async requestEmailChange(userId: string, currentPassword: string, newEmail: string): Promise<void> {
    const user = await this.requireNonRootUser(userId);
    const normalizedNewEmail = newEmail.trim().toLowerCase();
    if (!verifyPassword(currentPassword, user.passwordHash)) {
      throw new AppError('AUTH_INVALID', 'current password is invalid', 401);
    }
    if (!normalizedNewEmail || !normalizedNewEmail.includes('@')) {
      throw new AppError('VALIDATION_ERROR', 'new email is invalid', 400);
    }
    const existed = await this.options.store.findUserByIdentity(normalizedNewEmail);
    if (existed && existed.id !== user.id) {
      throw new AppError('VALIDATION_ERROR', 'email is already in use', 409);
    }

    const code = this.createVerificationCode();
    await this.issueSecurityCode({
      purpose: 'change-email',
      userId: user.id,
      targetEmail: normalizedNewEmail,
      pendingEmail: normalizedNewEmail,
      code,
    });
    await this.sendSecurityMail(normalizedNewEmail, '[Labby] Confirm email change', [
      `Email change code: ${code}`,
      `Enter this code in Labby to complete the email update.`,
    ]);
  }

  async confirmEmailChange(userId: string, code: string): Promise<void> {
    const user = await this.requireNonRootUser(userId);
    const record = await this.options.store.getLatestActiveAuthVerificationCode({
      purpose: 'change-email',
      userId: user.id,
    });
    this.assertCodeValid(record, code);
    await this.options.store.consumeAuthVerificationCode(record!.tokenId);

    const nextEmail = record!.pendingEmail ?? record!.targetEmail;
    await this.options.store.updateUser({
      ...user,
      email: nextEmail,
      emailVerifiedAt: Date.now(),
    });
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.requireNonRootUser(userId);
    if (!verifyPassword(currentPassword, user.passwordHash)) {
      throw new AppError('AUTH_INVALID', 'current password is invalid', 401);
    }
    await this.options.store.updateUser({
      ...user,
      passwordHash: hashPassword(newPassword),
    });
    await this.options.store.revokeAllRefreshTokensForUser(user.id);
    await this.options.store.pruneExpiredRefreshTokens();
  }

  private async requireNonRootUser(userId: string): Promise<StoredUser> {
    if (userId === 'root') {
      throw new AppError('AUTH_FORBIDDEN', 'root account does not support this operation', 403);
    }
    const user = await this.options.store.getUserById(userId);
    if (!user || user.disabled) {
      throw new AppError('AUTH_INVALID', 'user is unavailable', 401);
    }
    return user;
  }

  private createVerificationCode(): string {
    return `${Math.floor(100000 + Math.random() * 900000)}`;
  }

  private hashVerificationCode(purpose: AuthVerificationPurpose, code: string, tokenId: string): string {
    return createHash('sha256')
      .update(`${purpose}:${tokenId}:${code.trim()}:${this.options.issuer}`)
      .digest('hex');
  }

  private constantTimeEqual(left: string, right: string): boolean {
    const l = Buffer.from(left, 'utf8');
    const r = Buffer.from(right, 'utf8');
    if (l.length !== r.length) return false;
    return timingSafeEqual(l, r);
  }

  private assertCodeValid(record: AuthVerificationCodeRecord | undefined, code: string): asserts record is AuthVerificationCodeRecord {
    if (!record) {
      throw new AppError('AUTH_INVALID', 'verification code is invalid or expired', 401);
    }
    const expected = this.hashVerificationCode(record.purpose, code, record.tokenId);
    if (!this.constantTimeEqual(record.codeHash, expected)) {
      throw new AppError('AUTH_INVALID', 'verification code is invalid or expired', 401);
    }
  }

  private async sendSecurityMail(to: string, subject: string, lines: string[]): Promise<void> {
    if (!this.options.sendSecurityMail) {
      throw new AppError('INTERNAL_ERROR', 'email delivery is unavailable; server SMTP is required', 503);
    }
    await this.options.sendSecurityMail({
      to,
      subject,
      text: lines.join('\n'),
      html: `<p>${lines.join('</p><p>')}</p>`,
    });
  }

  private async issueSecurityCode(input: {
    purpose: AuthVerificationPurpose;
    userId: string;
    targetEmail: string;
    pendingEmail: string | null;
    code: string;
  }): Promise<AuthVerificationCodeRecord> {
    const latest = await this.options.store.getLatestAuthVerificationCode({
      purpose: input.purpose,
      userId: input.userId,
      targetEmail: input.targetEmail,
    });
    const now = Date.now();
    if (latest && now - latest.createdAt < AuthService.AUTH_CODE_COOLDOWN_MS) {
      const waitMs = AuthService.AUTH_CODE_COOLDOWN_MS - (now - latest.createdAt);
      const waitSec = Math.max(1, Math.ceil(waitMs / 1000));
      throw new AppError('RATE_LIMITED', `please wait ${waitSec}s before requesting another verification code`, 429);
    }

    const tokenId = randomUUID();
    const createdAt = now;
    const record: AuthVerificationCodeRecord = {
      tokenId,
      purpose: input.purpose,
      userId: input.userId,
      targetEmail: input.targetEmail,
      pendingEmail: input.pendingEmail,
      codeHash: this.hashVerificationCode(input.purpose, input.code, tokenId),
      expiresAt: createdAt + this.authCodeTtlMs,
      createdAt,
      consumedAt: null,
    };
    await this.options.store.saveAuthVerificationCode(record);
    return record;
  }

  async login(identity: string, password: string): Promise<AuthTokens> {
    // Check root user first (not in DB)
    if (this.rootUsername && this._isRootIdentity(identity)) {
      if (!this.rootPassword || password !== this.rootPassword) {
        throw new AppError('AUTH_INVALID', 'invalid credentials', 401);
      }
      return this.issueRootTokenPair();
    }

    const user = await this.options.store.findUserByIdentity(identity);
    if (!user || user.disabled || !verifyPassword(password, user.passwordHash)) {
      throw new AppError('AUTH_INVALID', 'invalid credentials', 401);
    }

    await this.options.store.pruneExpiredRefreshTokens();
    return this.issueTokenPair(user);
  }

  private _isRootIdentity(identity: string): boolean {
    const norm = identity.trim().toLowerCase();
    if (this.rootUsername && norm === this.rootUsername.toLowerCase()) return true;
    if (this.rootEmail && norm === this.rootEmail.toLowerCase()) return true;
    return false;
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const payload = await this.decryptRefreshToken(refreshToken);

    // Root refresh tokens are special: no DB record, just re-issue
    if (payload.role === UserRole.Root) {
      if (!this.rootUsername) {
        throw new AppError('AUTH_INVALID', 'root user is not configured', 401);
      }
      return this.issueRootTokenPair();
    }

    const record = await this.options.store.getRefreshToken(payload.jti);
    if (!record || record.revokedAt !== null || record.expiresAt <= Date.now()) {
      throw new AppError('AUTH_INVALID', 'refresh token is invalid', 401);
    }

    const user = await this.options.store.getUserById(payload.userId);
    if (!user || user.disabled) {
      throw new AppError('AUTH_INVALID', 'user is unavailable', 401);
    }

    const nextTokens = await this.issueTokenPair(user);
    const nextPayload = await this.decryptRefreshToken(nextTokens.refresh_token);
    await this.options.store.revokeRefreshToken(record.tokenId, nextPayload.jti);
    await this.options.store.pruneExpiredRefreshTokens();
    return nextTokens;
  }

  async verifyAccessToken(token: string): Promise<AuthSession> {
    let payload: AccessTokenPayload;
    try {
      payload = await V4.decrypt<AccessTokenPayload>(token, this.options.accessKey, {
        audience: this.options.audience,
        issuer: this.options.issuer,
      });
    } catch {
      throw new AppError('AUTH_INVALID', 'access token is invalid', 401);
    }

    if (payload.typ !== 'access') {
      throw new AppError('AUTH_INVALID', 'access token is invalid', 401);
    }

    // Root session: verify root is still configured
    if (payload.role === UserRole.Root) {
      if (!this.rootUsername) {
        throw new AppError('AUTH_INVALID', 'root user is not configured', 401);
      }
      return {
        userId: 'root',
        username: this.rootUsername,
        role: UserRole.Root,
      };
    }

    const user = await this.options.store.getUserById(payload.userId);
    if (!user || user.disabled) {
      throw new AppError('AUTH_INVALID', 'user is unavailable', 401);
    }

    return {
      userId: user.id,
      username: user.username,
      role: user.role,
    };
  }

  async logout(userId: string): Promise<void> {
    if (userId === 'root') return; // Root has no DB records to revoke
    await this.options.store.revokeAllRefreshTokensForUser(userId);
    await this.options.store.pruneExpiredRefreshTokens();
  }

  private async issueRootTokenPair(): Promise<AuthTokens> {
    const accessToken = await V4.encrypt(
      {
        typ: 'access',
        jti: randomUUID(),
        userId: 'root',
        username: this.rootUsername!,
        role: UserRole.Root,
      } satisfies AccessTokenPayload,
      this.options.accessKey,
      {
        expiresIn: this.options.accessTtl,
        audience: this.options.audience,
        issuer: this.options.issuer,
        subject: String(UserRole.Root),
        iat: true,
      },
    );

    const refreshToken = await V4.encrypt(
      {
        typ: 'refresh',
        jti: randomUUID(),
        userId: 'root',
        username: this.rootUsername!,
        role: UserRole.Root,
      } satisfies RefreshTokenPayload,
      this.options.refreshKey,
      {
        expiresIn: this.options.refreshTtl,
        audience: this.options.audience,
        issuer: this.options.issuer,
        subject: String(UserRole.Root),
        iat: true,
      },
    );

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
    };
  }

  private async issueTokenPair(user: StoredUser): Promise<AuthTokens> {
    const refreshRecord: RefreshTokenRecord = {
      tokenId: randomUUID(),
      userId: user.id,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.refreshTtlMs,
      revokedAt: null,
      replacedByTokenId: null,
    };

    const accessToken = await V4.encrypt(
      {
        typ: 'access',
        jti: randomUUID(),
        userId: user.id,
        username: user.username,
        role: user.role,
      } satisfies AccessTokenPayload,
      this.options.accessKey,
      {
        expiresIn: this.options.accessTtl,
        audience: this.options.audience,
        issuer: this.options.issuer,
        subject: String(user.role),
        iat: true,
      },
    );

    const refreshToken = await V4.encrypt(
      {
        typ: 'refresh',
        jti: refreshRecord.tokenId,
        userId: user.id,
        username: user.username,
        role: user.role,
      } satisfies RefreshTokenPayload,
      this.options.refreshKey,
      {
        expiresIn: this.options.refreshTtl,
        audience: this.options.audience,
        issuer: this.options.issuer,
        subject: String(user.role),
        iat: true,
      },
    );

    await this.options.store.saveRefreshToken(refreshRecord);

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
    };
  }

  private async decryptRefreshToken(token: string): Promise<RefreshTokenPayload> {
    let payload: RefreshTokenPayload;
    try {
      payload = await V4.decrypt<RefreshTokenPayload>(token, this.options.refreshKey, {
        audience: this.options.audience,
        issuer: this.options.issuer,
      });
    } catch {
      throw new AppError('AUTH_INVALID', 'refresh token is invalid', 401);
    }

    if (payload.typ !== 'refresh') {
      throw new AppError('AUTH_INVALID', 'refresh token is invalid', 401);
    }

    return payload;
  }
}
