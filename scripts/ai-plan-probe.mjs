// Manual probe of the AI planner against a running server (costs a few cents of gpt-4o-mini).
// Usage: node scripts/ai-plan-probe.mjs [baseUrl]
import fs from 'node:fs';
const BASE = process.argv[2] ?? 'http://localhost:5173';
let cookie = '';
async function req(method, path, body, headers = {}) {
  const h = { 'X-FF-Client': '1', cookie, ...headers };
  let b = body;
  if (body && !(body instanceof Buffer)) { h['Content-Type'] = 'application/json'; b = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers: h, body: b });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
}
await req('POST', '/api/auth/guest', {});
async function asset(file, kind, mime, meta) {
  const buf = fs.readFileSync(file);
  const { asset } = await req('POST', '/api/assets', { name: file.split('/').pop(), kind, mimeType: mime, sizeBytes: buf.length, metadata: meta });
  await req('PUT', `/api/assets/${asset.id}/content`, buf, { 'Content-Type': mime });
  return asset.id;
}
const a = await asset('fixtures/clip-a-speech-720p.mp4', 'video', 'video/mp4', { durationUs: 12657000, width: 1280, height: 720, hasAudio: true });
const b = await asset('fixtures/clip-b-silent-1080p.mp4', 'video', 'video/mp4', { durationUs: 20000000, width: 1920, height: 1080, hasAudio: false });
const m = await asset('fixtures/music.mp3', 'audio', 'audio/mpeg', { durationUs: 45035000, width: null, height: null, hasAudio: true });
const { project } = await req('POST', '/api/projects', { name: 'Probe', aspect: '16:9', fps: 30 });
const data = project.data;
const v1 = data.tracks.find((t) => t.id === 'v1');
v1.clips.push({ id: 'clipA', kind: 'video', assetId: a, name: 'interview.mp4', timelineStartUs: 0, durationUs: 12657000, sourceStartUs: 0 });
v1.clips.push({ id: 'clipB', kind: 'video', assetId: b, name: 'broll.mp4', timelineStartUs: 12657000, durationUs: 10000000, sourceStartUs: 0 });
data.tracks.find((t) => t.id === 'a1').clips.push({ id: 'music1', kind: 'audio', assetId: m, name: 'music.mp3', timelineStartUs: 0, durationUs: 45035000, sourceStartUs: 0 });
const saved = await req('PUT', `/api/projects/${project.id}`, { data, baseVersion: project.version });
if (!saved.project) { console.log('save failed', JSON.stringify(saved).slice(0, 400)); process.exit(1); }
const prompts = process.argv.slice(3).length ? process.argv.slice(3) : [
  'Add a title at the start and fade the music out at the end.',
  'Make the music quieter under the interview and end it when the video ends.',
  'Put a 1 second dissolve between the two clips and make the b-roll black and white.',
  'Delete the b-roll.',
  'Add a lower third saying "Jane Doe — Producer" at 2 seconds.',
  'Replace the sky with a sunset and add a 3D spinning logo.',
];
for (const p of prompts) {
  const r = await req('POST', '/api/ai/plan', { projectId: project.id, instruction: p });
  console.log('\n> ' + p);
  if (!r.plan) { console.log('  ERROR', JSON.stringify(r).slice(0, 300)); continue; }
  console.log('  summary:', r.plan.summary);
  for (const o of r.plan.operations) console.log('  op:', JSON.stringify(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null))));
  if (r.plan.unsupported.length) console.log('  unsupported:', r.plan.unsupported.join(' | '));
}
