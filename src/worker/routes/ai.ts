import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, type Env, planModel, transcriptionModel } from '../env';
import { ApiError, parseInput } from '../errors';
import { randomId } from '../lib/crypto';
import { estimateAudioCost, estimateTokenCost } from '../lib/pricing';
import { SNIFF_BYTES, matchesMime } from '../lib/sniff';
import { filterPlanTargets, parsePlan, wavDurationSec } from '../lib/plan';
import { OpenAiError, planEdit, transcribe } from '../openai';
import { iso, requireUser } from '../util';
import { loadOwnedProject, toProjectDTO } from './projects';
import { loadOwnedAsset } from './assets';
import { LIMITS, type AiOperationDTO } from '../../shared/api-types';
import { describeProjectForAi, type AiPlan } from '../../shared/ai-actions';
import type { Project } from '../../shared/model';

interface AiOpRow {
  id: string;
  user_id: string;
  project_id: string | null;
  kind: 'transcribe' | 'plan';
  model: string;
  status: 'running' | 'completed' | 'failed';
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  audio_seconds: number | null;
  cost_usd: number | null;
  error: string | null;
  created_at: number;
}

const toDTO = (r: AiOpRow): AiOperationDTO => ({
  id: r.id,
  kind: r.kind,
  model: r.model,
  status: r.status,
  latencyMs: r.latency_ms,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  audioSeconds: r.audio_seconds,
  costUsd: r.cost_usd,
  error: r.error,
  createdAt: iso(r.created_at),
});

const IdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const TRANSCRIBE_MIME = ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp3'];

function requireKey(env: Env): string {
  if (!env.OPENAI_API_KEY) throw new ApiError(503, 'ai_not_configured', 'AI features are not configured on this server (missing OpenAI API key)');
  return env.OPENAI_API_KEY;
}

/** Sliding one-hour window over recorded operations. */
async function checkAiRate(env: Env, userId: string) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM ai_operations WHERE user_id = ? AND created_at > ?')
    .bind(userId, Date.now() - 3_600_000)
    .first<{ n: number }>();
  if ((r?.n ?? 0) >= LIMITS.aiCallsPerHour)
    throw new ApiError(429, 'rate_limited', `AI limit reached (${LIMITS.aiCallsPerHour} calls per hour). Try again later.`, undefined, { 'Retry-After': '600' });
}

async function startOp(env: Env, userId: string, projectId: string, kind: AiOpRow['kind'], model: string) {
  const id = randomId('ai');
  await env.DB.prepare("INSERT INTO ai_operations (id, user_id, project_id, kind, model, status, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?)")
    .bind(id, userId, projectId, kind, model, Date.now())
    .run();
  return id;
}

async function finishOp(
  env: Env,
  id: string,
  f: { status: 'completed' | 'failed'; latencyMs: number; inputTokens?: number | null; outputTokens?: number | null; audioSeconds?: number | null; costUsd?: number | null; error?: string | null },
) {
  await env.DB.prepare('UPDATE ai_operations SET status = ?, latency_ms = ?, input_tokens = ?, output_tokens = ?, audio_seconds = ?, cost_usd = ?, error = ? WHERE id = ?')
    .bind(f.status, f.latencyMs, f.inputTokens ?? null, f.outputTokens ?? null, f.audioSeconds ?? null, f.costUsd ?? null, f.error?.slice(0, 500) ?? null, id)
    .run();
}

function providerError(e: unknown, operationId: string): ApiError {
  if (e instanceof OpenAiError) {
    const status = e.status === 429 ? 429 : e.status === 504 ? 504 : 502;
    return new ApiError(status, 'ai_provider_error', e.message, { operationId });
  }
  return new ApiError(502, 'ai_provider_error', 'AI request failed', { operationId });
}

export const aiRoutes = new Hono<AppEnv>()
  .post('/transcribe', async (c) => {
    const u = requireUser(c);
    const declared = Number(c.req.header('content-length') ?? '0');
    if (declared > LIMITS.maxTranscribeBytes + 64 * 1024)
      throw new ApiError(413, 'too_large', `Audio for transcription must be at most ${LIMITS.maxTranscribeBytes / 1048576} MB`);
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw new ApiError(400, 'invalid_input', 'Expected multipart/form-data with file, projectId, assetId, offsetSec');
    }
    const file = form.get('file');
    const fields = parseInput(
      z.object({
        projectId: IdSchema,
        assetId: IdSchema,
        offsetSec: z.coerce.number().finite().min(0).max(4 * 3600).default(0),
      }),
      { projectId: form.get('projectId') ?? undefined, assetId: form.get('assetId') ?? undefined, offsetSec: form.get('offsetSec') ?? undefined },
    );
    if (!file || typeof file === 'string') throw new ApiError(400, 'invalid_input', 'file: audio file is required');
    const blob = file as File;
    const mime = (blob.type || '').split(';')[0].toLowerCase();
    if (!TRANSCRIBE_MIME.includes(mime)) throw new ApiError(415, 'unsupported_media_type', 'file must be audio/wav or audio/mpeg');
    if (blob.size > LIMITS.maxTranscribeBytes) throw new ApiError(413, 'too_large', `Audio for transcription must be at most ${LIMITS.maxTranscribeBytes / 1048576} MB`);
    const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
    if (!matchesMime(head.subarray(0, SNIFF_BYTES), mime)) throw new ApiError(415, 'invalid_media', 'file content is not valid WAV/MP3 audio');
    await loadOwnedProject(c.env, fields.projectId, u.id);
    await loadOwnedAsset(c.env, fields.assetId, u.id);
    const key = requireKey(c.env);
    await checkAiRate(c.env, u.id);

    const model = transcriptionModel(c.env);
    const opId = await startOp(c.env, u.id, fields.projectId, 'transcribe', model);
    const t0 = Date.now();
    try {
      const ext = mime.includes('wav') ? 'wav' : 'mp3';
      const r = await transcribe(key, model, blob, `audio.${ext}`, fields.offsetSec, ext === 'wav' ? wavDurationSec(head) : null);
      const audioSeconds = r.durationSec;
      await finishOp(c.env, opId, { status: 'completed', latencyMs: Date.now() - t0, audioSeconds, costUsd: estimateAudioCost(model, audioSeconds) });
      return c.json({ segments: r.segments, words: r.words, language: r.language, durationSec: r.durationSec, operationId: opId });
    } catch (e) {
      const err = providerError(e, opId);
      await finishOp(c.env, opId, { status: 'failed', latencyMs: Date.now() - t0, error: err.message });
      throw err;
    }
  })
  .post('/plan', async (c) => {
    const u = requireUser(c);
    const body = parseInput(z.object({ projectId: IdSchema, instruction: z.string().trim().min(1, 'instruction is required').max(2000) }), await c.req.json());
    const row = await loadOwnedProject(c.env, body.projectId, u.id);
    const key = requireKey(c.env);
    await checkAiRate(c.env, u.id);
    const project = toProjectDTO(row).data as Project;

    const used = new Set(project.tracks.flatMap((t) => t.clips.flatMap((cl) => ('assetId' in cl ? [cl.assetId] : []))));
    const assets: Record<string, { name: string; kind: string; durationUs: number | null; hasAudio: boolean }> = {};
    if (used.size) {
      const rs = await c.env.DB.prepare('SELECT id, name, kind, metadata FROM assets WHERE owner_id = ? LIMIT 2000')
        .bind(u.id)
        .all<{ id: string; name: string; kind: string; metadata: string }>();
      for (const a of rs.results) {
        if (!used.has(a.id)) continue;
        let m: { durationUs?: number | null; hasAudio?: boolean } = {};
        try {
          m = JSON.parse(a.metadata);
        } catch {
          /* ignore */
        }
        assets[a.id] = { name: a.name, kind: a.kind, durationUs: m.durationUs ?? null, hasAudio: !!m.hasAudio };
      }
    }

    const model = planModel(c.env);
    const opId = await startOp(c.env, u.id, body.projectId, 'plan', model);
    const t0 = Date.now();
    let tokens: { inputTokens: number | null; outputTokens: number | null } = { inputTokens: null, outputTokens: null };
    try {
      const r = await planEdit(key, model, describeProjectForAi(project, assets), body.instruction);
      tokens = { inputTokens: r.inputTokens, outputTokens: r.outputTokens };
      let plan: AiPlan;
      if (r.refusal || !r.content) {
        plan = { summary: 'The assistant declined this request.', operations: [], unsupported: [(r.refusal ?? 'No response').slice(0, 500)] };
      } else {
        try {
          plan = parsePlan(r.content);
        } catch {
          throw new ApiError(502, 'ai_invalid_output', 'The AI returned an invalid plan; please rephrase and try again', { operationId: opId });
        }
      }
      plan = filterPlanTargets(plan, project);
      await finishOp(c.env, opId, { status: 'completed', latencyMs: Date.now() - t0, ...tokens, costUsd: estimateTokenCost(model, tokens.inputTokens, tokens.outputTokens) });
      return c.json({ plan, operationId: opId });
    } catch (e) {
      const err = e instanceof ApiError ? e : providerError(e, opId);
      await finishOp(c.env, opId, {
        status: 'failed',
        latencyMs: Date.now() - t0,
        ...tokens,
        costUsd: estimateTokenCost(model, tokens.inputTokens, tokens.outputTokens),
        error: err.message,
      });
      throw err;
    }
  })
  .get('/operations', async (c) => {
    const u = requireUser(c);
    const pid = c.req.query('projectId');
    const stmt = pid
      ? c.env.DB.prepare('SELECT * FROM ai_operations WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 100').bind(u.id, parseInput(IdSchema, pid))
      : c.env.DB.prepare('SELECT * FROM ai_operations WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').bind(u.id);
    const rs = await stmt.all<AiOpRow>();
    return c.json({ operations: rs.results.map(toDTO) });
  });
