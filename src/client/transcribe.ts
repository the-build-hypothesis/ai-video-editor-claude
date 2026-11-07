import { api } from './api';
import { mediaCache } from './engine/media-cache';
import { encodeWavSegment } from './engine/probe';
import { useEditor } from './store';
import { findClip, newId, clipEndUs, type CaptionSegment } from '../shared/model';
import { setCaptions } from '../shared/commands';
import { LIMITS } from '../shared/api-types';

interface Word {
  startSec: number;
  endSec: number;
  word: string;
}

/** Group word timings into readable caption chunks (≤ 42 chars, ≤ 3.5 s, break after punctuation). */
export function chunkWords(words: Word[], maxChars = 42, maxDur = 3.5): { startSec: number; endSec: number; text: string }[] {
  const out: { startSec: number; endSec: number; text: string }[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ startSec: cur[0].startSec, endSec: cur[cur.length - 1].endSec, text: cur.map((w) => w.word.trim()).join(' ').replace(/\s+([,.!?;:])/g, '$1') });
    cur = [];
  };
  for (const w of words) {
    const text = [...cur, w].map((x) => x.word.trim()).join(' ');
    if (cur.length && (text.length > maxChars || w.endSec - cur[0].startSec > maxDur)) flush();
    cur.push(w);
    if (/[.!?]$/.test(w.word.trim())) flush();
  }
  flush();
  return out;
}

/**
 * Transcribe the audio of a timeline clip and convert it into caption segments placed at the
 * clip's timeline position. Only the clip's used source range is sent (16 kHz mono WAV) to minimise
 * data shared with the provider.
 */
export async function transcribeClip(clipId: string, opts: { replace: boolean; onStatus?: (s: string) => void }): Promise<number> {
  const st = useEditor.getState();
  const p = st.project!;
  const f = findClip(p, clipId);
  if (!f || (f.clip.kind !== 'video' && f.clip.kind !== 'audio')) throw new Error('Select a video or audio clip with speech.');
  const clip = f.clip;
  opts.onStatus?.('Decoding audio…');
  const buf = await mediaCache.loadAudio(clip.assetId);
  if (!buf) throw new Error('This clip has no decodable audio track.');
  const srcStart = clip.sourceStartUs / 1e6;
  const srcEnd = srcStart + (clip.durationUs * clip.speed) / 1e6;
  opts.onStatus?.('Preparing audio…');
  const wav = await encodeWavSegment(buf, srcStart, srcEnd);
  if (wav.size > LIMITS.maxTranscribeBytes) throw new Error(`Clip audio is too long to transcribe in one request (${(wav.size / 1048576).toFixed(1)} MB > ${LIMITS.maxTranscribeBytes / 1048576} MB). Split the clip into parts under ~12 minutes.`);
  const form = new FormData();
  form.append('file', wav, 'audio.wav');
  form.append('projectId', p.id);
  form.append('assetId', clip.assetId);
  form.append('offsetSec', '0');
  opts.onStatus?.('Transcribing with OpenAI…');
  const r = await api.transcribe(form);
  const chunks = r.words?.length ? chunkWords(r.words) : r.segments;
  const toTimeline = (sec: number) => Math.round(clip.timelineStartUs + (sec * 1e6) / clip.speed);
  const end = clipEndUs(clip);
  const segs: CaptionSegment[] = chunks
    .map((c) => ({ id: newId('cap'), startUs: Math.min(end, toTimeline(c.startSec)), endUs: Math.min(end, toTimeline(c.endSec)), text: c.text.trim() }))
    .filter((s) => s.text && s.endUs > s.startUs);
  // Ensure minimum on-screen time and no overlaps between consecutive captions.
  for (let i = 0; i < segs.length; i++) {
    const next = segs[i + 1];
    if (segs[i].endUs - segs[i].startUs < 600_000) segs[i].endUs = Math.min(segs[i].startUs + 600_000, next ? next.startUs : end);
    if (next && segs[i].endUs > next.startUs) segs[i].endUs = next.startUs;
  }
  const valid = segs.filter((s) => s.endUs > s.startUs);
  const ok = useEditor.getState().edit('Create captions', (pp) => {
    const existing = opts.replace ? [] : pp.captions.segments.filter((s) => s.endUs <= clip.timelineStartUs || s.startUs >= end);
    return setCaptions(pp, { segments: [...existing, ...valid], sourceAssetId: clip.assetId, language: r.language ?? null });
  });
  if (!ok) throw new Error('Could not apply captions to the project.');
  return valid.length;
}

export function toSrt(segments: CaptionSegment[]): string {
  const ts = (us: number) => {
    const ms = Math.round(us / 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const r = ms % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
  };
  return segments.map((s, i) => `${i + 1}\n${ts(s.startUs)} --> ${ts(s.endUs)}\n${s.text}\n`).join('\n');
}
