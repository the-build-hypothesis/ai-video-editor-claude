/** Approximate OpenAI pricing (USD) used for cost estimates in ai_operations. Update as prices change. */

export const TOKEN_PRICES_PER_MILLION: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
};

export const AUDIO_PRICES_PER_MINUTE: Record<string, number> = {
  'whisper-1': 0.006,
  'gpt-4o-transcribe': 0.006,
  'gpt-4o-mini-transcribe': 0.003,
};

/** Strip dated snapshot suffixes, e.g. gpt-4o-mini-2024-07-18 → gpt-4o-mini. */
export function baseModel(model: string): string {
  return model.trim().toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function estimateTokenCost(model: string, inputTokens: number | null, outputTokens: number | null): number | null {
  const p = TOKEN_PRICES_PER_MILLION[baseModel(model)];
  if (!p || inputTokens === null || outputTokens === null) return null;
  return round6((inputTokens * p.input + outputTokens * p.output) / 1_000_000);
}

export function estimateAudioCost(model: string, audioSeconds: number | null): number | null {
  const p = AUDIO_PRICES_PER_MINUTE[baseModel(model)];
  if (p === undefined || audioSeconds === null || !Number.isFinite(audioSeconds)) return null;
  return round6((Math.max(0, audioSeconds) / 60) * p);
}
