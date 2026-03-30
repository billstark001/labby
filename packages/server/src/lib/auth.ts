import { createHash, randomBytes, randomUUID } from 'crypto';

import { V4 } from '@mpoonuru/paseto';

import { AppError } from './errors.js';
import { hashPassword, verifyPassword } from './password.js';
import type { AuthRole, RefreshTokenRecord, SqliteStore, StoredUser } from '../store/sqlite.js';

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
  private readonly refreshTtlMs: number;

  constructor(private readonly options: AuthServiceOptions) {
    this.refreshTtlMs = parseDurationMs(options.refreshTtl);
  }

  async bootstrapUser(input: {
    username: string;
    password: string;
    role?: AuthRole;
    email?: string;
  }): Promise<StoredUser> {
    return this.options.store.createUserIfMissing({
      id: randomUUID(),
      username: input.username.trim(),
      email: input.email?.trim(),
      role: input.role ?? 'admin',
      passwordHash: hashPassword(input.password),
      disabled: false,
      createdAt: Date.now(),
    });
  }

  async login(identity: string, password: string): Promise<AuthTokens> {
    const user = this.options.store.findUserByIdentity(identity);
    if (!user || user.disabled || !verifyPassword(password, user.passwordHash)) {
      throw new AppError('AUTH_INVALID', 'invalid credentials', 401);
    }

    this.options.store.pruneExpiredRefreshTokens();
    return this.issueTokenPair(user);
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const payload = await this.decryptRefreshToken(refreshToken);
    const record = this.options.store.getRefreshToken(payload.jti);
    if (!record || record.revokedAt !== null || record.expiresAt <= Date.now()) {
      throw new AppError('AUTH_INVALID', 'refresh token is invalid', 401);
    }

    const user = this.options.store.getUserById(payload.userId);
    if (!user || user.disabled) {
      throw new AppError('AUTH_INVALID', 'user is unavailable', 401);
    }

    const nextTokens = await this.issueTokenPair(user);
    const nextPayload = await this.decryptRefreshToken(nextTokens.refresh_token);
    this.options.store.revokeRefreshToken(record.tokenId, nextPayload.jti);
    this.options.store.pruneExpiredRefreshTokens();
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

    const user = this.options.store.getUserById(payload.userId);
    if (!user || user.disabled) {
      throw new AppError('AUTH_INVALID', 'user is unavailable', 401);
    }

    return {
      userId: user.id,
      username: user.username,
      role: user.role,
    };
  }

  logout(userId: string): void {
    this.options.store.revokeAllRefreshTokensForUser(userId);
    this.options.store.pruneExpiredRefreshTokens();
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
        subject: user.role,
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
        subject: user.role,
        iat: true,
      },
    );

    this.options.store.saveRefreshToken(refreshRecord);

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