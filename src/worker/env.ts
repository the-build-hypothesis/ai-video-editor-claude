import type { Context } from 'hono';

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_TRANSCRIPTION_MODEL?: string;
  ADMIN_EMAILS?: string;
  APP_PUBLIC_URL?: string;
}

export interface UserRow {
  id: string;
  email: string | null;
  password_hash: string | null;
  is_guest: number;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
}

export interface AppVars {
  requestId: string;
  user: UserRow | null;
  sessionHash: string | null;
}

export type AppEnv = { Bindings: Env; Variables: AppVars };
export type Ctx = Context<AppEnv>;

export const APP_VERSION = '0.1.0';

export const planModel = (env: Env) => env.OPENAI_MODEL || 'gpt-4o-mini';
export const transcriptionModel = (env: Env) => env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1';
