import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import neuronovo, { polling } from './neuronovo.mjs';

const KEY = 'nn_live_test0123456789';
/** A fake Нейроново API on 127.0.0.1: `reply` answers each request; `seen` keeps them. */
let server, base;
let reply = () => [404, {}];
const seen = [];

before(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const call = { method: req.method, url: new URL(req.url, 'http://x'), headers: req.headers, body: Buffer.concat(chunks) };
    seen.push(call);
    const [status, body, type = 'application/json'] = await reply(call);
    res.writeHead(status, { 'content-type': type }).end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.OPENFILM_NEURONOVO_URL = `${base}/api/v1`;
  polling.ms = { image: 5, video: 5 };
});
after(() => server.close());

const ctx = (files = {}, model, signal = new AbortController().signal) => ({ key: KEY, model, root: '/project', signal, say: () => {}, read: async (p) => files[p] });

function png(w, h) {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

/** One task, made at `path`, `ready` asks until it is done, its file at /files/<name>. */
function task(path, type, file, ready = 2, extra = {}) {
  let asks = 0;
  const done = { id: 'tsk1', object: 'task', type, status: 'succeeded', result: { files: [{ type: 'preview', url: `${base}/files/preview.jpg` }, file] }, error: null, refund: null };
  return (call) => {
    if (call.method === 'POST' && call.url.pathname === `/api/v1${path}`) return [202, { id: 'tsk1', object: 'task', type, status: 'queued', result: null, ...extra }];
    if (call.url.pathname === '/api/v1/tasks/tsk1') { asks += 1; return [200, asks < ready ? { id: 'tsk1', status: 'processing' } : done]; }
    if (call.url.pathname === '/files/out.png') return [200, png(1536, 864), 'image/png'];
    if (call.url.pathname === '/files/out.mp4') return [200, Buffer.from('mp4'), 'video/mp4'];
    return [404, {}];
  };
}

test('a picture: asked for with the key, asked after, its signed link downloaded without the key', async () => {
  seen.length = 0;
  reply = task('/images/generations', 'image', { type: 'image', url: `${base}/files/out.png`, content_type: 'image/png' });
  const out = await neuronovo.run('image', { prompt: 'a cafe in the rain', out: 'cafe', ratio: '16:9' }, ctx());
  assert.equal(out.files[0].path, 'assets/image/cafe.png');
  assert.equal(out.index[0].from.model, 'nanobanana-2', 'its first model');
  const made = seen[0];
  assert.equal(made.headers.authorization, `Bearer ${KEY}`);
  assert.ok(made.headers['idempotency-key']);
  assert.deepEqual(JSON.parse(made.body), { model: 'nanobanana-2', prompt: 'a cafe in the rain', aspect_ratio: '16:9' });
  assert.ok(seen.length >= 3, 'asked after more than once');
  assert.equal(seen.at(-1).headers.authorization, undefined, 'the link is its own, no key goes there');
});

test('a picture shape the model does not make is left to the model and said so; --quality high asks for its largest size', async () => {
  seen.length = 0;
  reply = task('/images/generations', 'image', { type: 'image', url: `${base}/files/out.png` });
  const out = await neuronovo.run('image', { prompt: 'x', out: 'a', ratio: '21:9', quality: 'high' }, ctx({}, 'neuronovo-x'));
  assert.deepEqual(JSON.parse(seen[0].body), { model: 'neuronovo-x', prompt: 'x', resolution: '2K' });
  assert.match(out.receipt.notes[0], /does not make 21:9/);
});

test('a clip from the prompt: the length the model makes, its shape; the clip is the video file, not the preview', async () => {
  seen.length = 0;
  reply = task('/videos/generations', 'video', { type: 'video', url: `${base}/files/out.mp4`, content_type: 'video/mp4' });
  const out = await neuronovo.run('video', { prompt: 'a flight over the city', out: 'city', duration: 7, 'aspect-ratio': '16:9' }, ctx({}, 'neuronovo-x-video'));
  assert.deepEqual(JSON.parse(seen[0].body), { model: 'neuronovo-x-video', prompt: 'a flight over the city', mode: 'text_to_video', duration: 6, aspect_ratio: '16:9' });
  assert.equal(out.files[0].path, 'assets/video/city.mp4');
  assert.equal(Buffer.from(out.files[0].bytes).toString(), 'mp4');
  assert.equal(out.index[0].dur, 6);
  assert.match(out.receipt.notes.join(' '), /4, 6, 8, 10 second clips: 6 s/);
});

test('a clip from a first frame: the frame is uploaded, passed by its id, and gives the clip its shape', async () => {
  seen.length = 0;
  const made = task('/videos/generations', 'video', { type: 'video', url: `${base}/files/out.mp4` });
  reply = (call) => (call.method === 'POST' && call.url.pathname === '/api/v1/files' ? [201, { id: 'file12345678' }] : made(call));
  const out = await neuronovo.run('video', { prompt: 'wind', out: 'a', duration: 5, 'aspect-ratio': '9:16', 'first-frame': 'assets/image/a.png', 'last-frame': 'assets/image/b.png' },
    ctx({ 'assets/image/a.png': png(10, 10), 'assets/image/b.png': png(10, 10) }, 'kling-v3'));
  const upload = seen[0];
  assert.equal(upload.url.pathname, '/api/v1/files');
  assert.match(upload.headers['content-type'], /^multipart\/form-data/);
  const body = JSON.parse(seen.find((c) => c.url.pathname === '/api/v1/videos/generations').body);
  assert.deepEqual(body, { model: 'kling-v3', prompt: 'wind', mode: 'image_to_video', duration: 5, image: 'file12345678', last_frame: 'file12345678' });
  assert.equal(out.index[0].from.firstFrame, 'assets/image/a.png');
});

test('a task that failed says why and that what it cost came back; no balance is the same sentence for every provider', async () => {
  reply = (call) => call.method === 'POST'
    ? [202, { id: 'tsk1', status: 'queued' }]
    : [200, { id: 'tsk1', status: 'failed', error: { code: 'content_policy', message: 'Blocked by moderation' }, refund: { credits: 5 } }];
  await assert.rejects(neuronovo.run('image', { prompt: 'x', out: 'a' }, ctx()), /could not make it: Blocked by moderation\. What it cost was returned\./);
  reply = () => [402, { error: { code: 'insufficient_balance', message: 'Not enough' } }];
  await assert.rejects(neuronovo.run('image', { prompt: 'x', out: 'a' }, ctx()), (e) => e.code === 'balance');
});

test('it makes pictures and video only', async () => {
  await assert.rejects(neuronovo.run('tts', {}, ctx()), /does not do tts/);
  assert.deepEqual(neuronovo.verbs, ['image', 'video']);
  assert.equal(neuronovo.keysUrl, 'https://нейроново.рф/profile/api');
});
