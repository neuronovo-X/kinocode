// @ts-check
/**
 * Нейроново with the person's own key: pictures (NanoBanana, GPT Image, Нейроново X) and video (Kling V3, SeeDance 2.5,
 * Нейроново X Видео). Every model runs as a task (https://нейроново.рф/docs/api): a request is made with
 * `Authorization: Bearer nn_live_…` and answers 202 with a task, which is asked after until it is `succeeded`; its files
 * are signed links that need no key, downloaded here. A first or last frame is uploaded first (`POST /files`) and passed
 * by its id. The model ids are the ones on each model's page in the docs.
 */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { billedBy, call, clamp, download, extOf, landing, list, madePicture, mimeOf, modelOf, needed, notes, number, serviceUrl, sleep, text } from './common.mjs';

/** @typedef {import('./contract.mjs').Provider} Provider @typedef {import('./contract.mjs').RunContext} RunContext */

const NAME = 'Нейроново';
const MODELS = {
  image: [
    { id: 'nanobanana-2', name: 'NanoBanana 2' },
    { id: 'nanobanana-2.1', name: 'NanoBanana 2.1' },
    { id: 'nanobanana-pro', name: 'NanoBanana Pro' },
    { id: 'gpt-image-2.5', name: 'GPT Image 2.5' },
    { id: 'neuronovo-x', name: 'Нейроново X' },
  ],
  video: [
    { id: 'seedance-2.5', name: 'SeeDance 2.5' },
    { id: 'kling-v3', name: 'Kling V3' },
    { id: 'neuronovo-x-video', name: 'Нейроново X Видео' },
  ],
};

const COMMON_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9'];
/**
 * Each picture model's shapes and sizes: `resolutions` (its default left out of a request, the largest for `--quality
 * high`), and how many reference pictures it takes (none are asked for here yet).
 * @type {Record<string, { ratios: string[], resolutions: string[] }>}
 */
const IMAGE = {
  'nanobanana-2': { ratios: [...COMMON_RATIOS, '4:1', '8:1', '1:4', '1:8'], resolutions: ['1K', '2K', '4K'] },
  'nanobanana-2.1': { ratios: [...COMMON_RATIOS, '4:1', '8:1', '1:4', '1:8'], resolutions: ['1K', '2K', '4K'] },
  'nanobanana-pro': { ratios: COMMON_RATIOS, resolutions: ['1K', '2K', '4K'] },
  'gpt-image-2.5': { ratios: COMMON_RATIOS, resolutions: ['1K', '2K', '4K'] },
  'neuronovo-x': { ratios: ['16:9', '4:3', '1:1', '3:4', '9:16'], resolutions: ['1K', '2K'] },
};

/**
 * Each video model's lengths (a range, or the whole seconds it makes), the shapes of a clip made from the prompt, and
 * whether it takes a last frame. A clip made from a first frame has the shape of the frame.
 * @type {Record<string, { name: string, seconds: number[] | [number, number], range: boolean, ratios: string[], last: boolean }>}
 */
const VIDEO = {
  'seedance-2.5': { name: 'SeeDance', seconds: [4, 5, 6, 8, 10, 12, 15, 20, 25, 30], range: false, ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], last: true },
  'kling-v3': { name: 'Kling', seconds: [3, 15], range: true, ratios: ['16:9', '9:16', '1:1'], last: true },
  'neuronovo-x-video': { name: 'Нейроново X Видео', seconds: [4, 6, 8, 10], range: false, ratios: ['16:9', '9:16'], last: false },
};

/** How long to wait between asking after a task (tests make it short). */
export const polling = { ms: { image: 3000, video: 5000 } };

/** @type {Provider} */
export default {
  id: 'neuronovo',
  name: NAME,
  env: 'NEURONOVO_API_KEY',
  keysUrl: 'https://нейроново.рф/profile/api',
  billingUrl: 'https://нейроново.рф/wallet',
  verbs: ['image', 'video'],
  models: MODELS,
  async run(verb, args, ctx) {
    if (verb === 'image') return image(args, ctx);
    if (verb === 'video') return video(args, ctx);
    throw new Error(`${NAME} does not do ${verb}.`);
  },
};

/** @param {RunContext} ctx */
const headers = (ctx) => ({ authorization: `Bearer ${ctx.key}` });
const base = () => serviceUrl('NEURONOVO', 'https://neuronovo.ru/api/v1');

/**
 * A picture from the prompt, in the shape and size asked within what the chosen model makes.
 * @param {Record<string, unknown>} args @param {RunContext} ctx
 */
async function image(args, ctx) {
  const prompt = needed(args, 'prompt');
  const model = modelOf(MODELS, 'image', ctx);
  const spec = IMAGE[model];
  const said = [];
  const ratio = text(args.ratio);
  if (ratio && !spec.ratios.includes(ratio)) said.push(`${model} does not make ${ratio}: its own shape was used`);
  if (args.transparent) said.push(`--transparent: ${model} makes opaque pictures`);
  const high = text(args.quality) === 'high';
  const body = { model, prompt, ...(ratio && spec.ratios.includes(ratio) ? { aspect_ratio: ratio } : {}), ...(high ? { resolution: spec.resolutions.at(-1) } : {}) };
  const task = await finished(body, 'images', ctx, polling.ms.image);
  const file = task.result?.files?.find((/** @type {any} */ f) => f?.type === 'image') ?? task.result?.files?.[0];
  if (!text(file?.url)) throw new Error(`${NAME} answered without a picture.`);
  const { bytes, type } = await download(NAME, file.url, ctx);
  const path = landing('image', args.out, extOf(file.content_type ?? type, 'png'));
  return { ...madePicture({ path, bytes, prompt, provider: 'neuronovo', model, notes: said }), cost: billedBy(NAME) };
}

/**
 * A clip, with sound where the model makes it: from the prompt, or from a first (and last) frame.
 * @param {Record<string, unknown>} args @param {RunContext} ctx
 */
async function video(args, ctx) {
  const prompt = needed(args, 'prompt');
  const path = landing('video', args.out, 'mp4');
  const model = modelOf(MODELS, 'video', ctx);
  const spec = VIDEO[model];
  const said = [];
  const first = text(args['first-frame']);
  let last = text(args['last-frame']);
  if (list(args['input-reference']).length) said.push(`${spec.name} takes no reference pictures: they were left out`);
  if (last && (!first || !spec.last)) { said.push(first ? `${spec.name} takes no last frame: it was left out` : 'a last frame needs a first frame: it was left out'); last = ''; }

  const asked = number(args.duration) ?? 5;
  const seconds = spec.range
    ? clamp(Math.round(asked), spec.seconds[0], spec.seconds[1])
    : spec.seconds.reduce((best, s) => (Math.abs(s - asked) < Math.abs(best - asked) ? s : best));
  if (seconds !== asked) said.push(spec.range ? `${spec.name} makes ${spec.seconds[0]} to ${spec.seconds[1]} second clips: ${seconds} s` : `${spec.name} makes ${spec.seconds.join(', ')} second clips: ${seconds} s`);
  const ratio = text(args['aspect-ratio']);
  const tall = ['9:21', '2:3', '3:4', '9:16'].includes(ratio);
  const shape = ratio && ratio !== 'adaptive' ? (spec.ratios.includes(ratio) ? ratio : tall ? '9:16' : spec.ratios.includes('1:1') && ['4:3', '1:1'].includes(ratio) ? '1:1' : '16:9') : null;
  if (shape && shape !== ratio) said.push(`${spec.name} makes ${spec.ratios.join(', ')} clips: ${shape}`);

  const body = {
    model, prompt, mode: first ? 'image_to_video' : 'text_to_video', duration: seconds,
    /* a clip from a first frame has the frame's shape */
    ...(shape && !first ? { aspect_ratio: shape } : {}),
    ...(first ? { image: await upload(first, ctx) } : {}),
    ...(last ? { last_frame: await upload(last, ctx) } : {}),
  };
  const task = await finished(body, 'videos', ctx, polling.ms.video);
  const file = task.result?.files?.find((/** @type {any} */ f) => f?.type === 'video');
  if (!text(file?.url)) throw new Error(`${NAME} answered without a clip.`);
  const { bytes } = await download(NAME, file.url, ctx);
  return {
    files: [{ path, bytes }],
    index: [{ src: path, kind: 'video', dur: seconds, hasAudio: true, from: {
      mode: 'generate', prompt, provider: 'neuronovo', model, sec: seconds,
      ...(first ? { firstFrame: first } : {}), ...(last ? { lastFrame: last } : {}),
    } }],
    receipt: { provider: 'neuronovo', model, src: path, dur: seconds, hasAudio: true, ...notes(said) },
    cost: billedBy(NAME),
  };
}

/**
 * A project picture uploaded (`POST /files`), its id answered. The same file again is answered with the same id.
 * @param {string} path @param {RunContext} ctx
 */
async function upload(path, ctx) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(await ctx.read(path))], { type: mimeOf(path) }), basename(path));
  const file = await (await call(NAME, `${base()}/files`, { method: 'POST', headers: headers(ctx), body: form }, ctx)).json();
  if (!text(file?.id)) throw new Error(`${NAME} did not take ${path}.`);
  return file.id;
}

/**
 * One task: made (`kind`: images or videos), asked after every `every` ms until it is done, answered whole. A cancelled
 * run cancels the task too while it still waits in the queue, which returns what it cost. Idempotency-Key: a request
 * sent twice is the one task.
 * @param {Record<string, unknown>} body @param {'images' | 'videos'} kind @param {RunContext} ctx @param {number} every
 */
async function finished(body, kind, ctx, every) {
  const key = randomUUID();
  const made = await (await call(NAME, `${base()}/${kind}/generations`, {
    method: 'POST', headers: { ...headers(ctx), 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body),
  }, ctx)).json();
  const id = text(made?.id);
  if (!id) throw new Error(`${NAME} did not take the request.`);
  const cancel = () => { fetch(`${base()}/tasks/${encodeURIComponent(id)}`, { method: 'DELETE', headers: headers(ctx) }).then((r) => r.body?.cancel(), () => {}); };
  ctx.signal.addEventListener('abort', cancel, { once: true });
  try {
    let task = made;
    for (;;) {
      if (task.status === 'succeeded') return task;
      if (task.status === 'failed' || task.status === 'cancelled') {
        const why = text(task.error?.message) || (task.status === 'cancelled' ? 'the task was cancelled' : 'it could not be made');
        const refund = Number(task.refund?.credits) > 0 ? ' What it cost was returned.' : '';
        throw new Error(`${NAME} could not make it: ${why.replace(/\.$/, '')}.${refund}`);
      }
      await sleep(every, ctx.signal);
      task = await (await call(NAME, `${base()}/tasks/${encodeURIComponent(id)}`, { headers: headers(ctx) }, ctx)).json();
    }
  } finally {
    ctx.signal.removeEventListener('abort', cancel);
  }
}
