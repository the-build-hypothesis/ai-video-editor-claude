/** Pure post-processing of AI plans and audio helpers. */
import { AiPlanSchema, type AiPlan } from '../../shared/ai-actions';
import type { Project } from '../../shared/model';

/** Drops operations that reference clip/track ids not present in the project; notes them in `unsupported`. */
export function filterPlanTargets(plan: AiPlan, p: Project): AiPlan {
  const trackIds = new Set(p.tracks.map((t) => t.id));
  const clipIds = new Set(p.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  const operations: AiPlan['operations'] = [];
  const unsupported = [...plan.unsupported];
  for (const op of plan.operations) {
    if (op.clipId !== null && !clipIds.has(op.clipId)) {
      unsupported.push(`Skipped ${op.type}: clip "${op.clipId.slice(0, 60)}" does not exist in this project`);
      continue;
    }
    if (op.trackId !== null && !trackIds.has(op.trackId)) {
      unsupported.push(`Skipped ${op.type}: track "${op.trackId.slice(0, 60)}" does not exist in this project`);
      continue;
    }
    operations.push(op);
  }
  return { summary: plan.summary, operations, unsupported: unsupported.slice(0, 10).map((s) => s.slice(0, 500)) };
}

/** Parse + validate raw model output. Throws on invalid JSON/schema. */
export function parsePlan(content: string): AiPlan {
  return AiPlanSchema.parse(JSON.parse(content));
}

/** Duration of a PCM WAV from its header (first ≤ 4 KB), or null. */
export function wavDurationSec(b: Uint8Array): number | null {
  if (b.length < 12) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= b.length) {
    const id = tag(off);
    const size = dv.getUint32(off + 4, true);
    if (id === 'fmt ' && off + 16 <= b.length) byteRate = dv.getUint32(off + 16, true);
    if (id === 'data') return byteRate > 0 ? size / byteRate : null;
    off += 8 + size + (size % 2);
  }
  return null;
}
