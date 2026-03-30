import type {
  AttemptStatus,
  Platform,
  PresenceStatus,
  PushJobState,
  PushProvider,
  ReceiptType,
} from "./primitives.js";

export interface DeviceRow {
  id: string;
  tenant_id: string | null;
  user_id: string;
  platform: Platform;
  push_provider: PushProvider;
  push_token: string;
  app_instance_id: string;
  app_version: string;
  device_model: string;
  last_seen_at: number;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
}

export interface PresenceSessionRow {
  id: string;
  user_id: string;
  device_id: string;
  status: PresenceStatus;
  heartbeat_at: number;
  expire_at: number;
}

export interface CallPushJobRow {
  id: string;
  idempotency_key: string;
  call_id: string;
  user_id: string;
  from_uri: string;
  state: PushJobState;
  created_at: number;
  updated_at: number;
}

export interface CallPushAttemptRow {
  id: string;
  job_id: string;
  device_id: string;
  provider: PushProvider;
  provider_message_id: string | null;
  status: AttemptStatus;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
}

export interface ClientReceiptRow {
  id: string;
  call_id: string;
  device_id: string;
  receipt_type: ReceiptType;
  received_at: number;
}
