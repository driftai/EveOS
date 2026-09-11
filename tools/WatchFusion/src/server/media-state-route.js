import { getMember, getRoom, hasRoom, publicState, resolveRoomId, broadcastState } from './room-store.js';
import { json, now, readBody } from './http-utils.js';
import { classifyMediaUrl } from './media-resolver.js';
import { assertPublicHttpUrl } from './public-url.js';

export async function handleMediaStateRoute(req, res, parts) {
  if (parts[0] !== 'api' || parts[1] !== 'rooms' || parts[3] !== 'media-source' || req.method !== 'POST') return false;
  const resolvedId = resolveRoomId(parts[2]);
  if (!resolvedId || !hasRoom(resolvedId)) return json(res, 404, { error: 'room not found' });
  const room = getRoom(resolvedId);
  const memberId = String(req.headers['x-member-id'] || '');
  const member = getMember(room, memberId);
  if (!member) return json(res, 401, { error: 'join the room first' });
  if (memberId !== room.hostId) return json(res, 403, { error: 'only the current host can load media' });

  try {
    const body = await readBody(req);
    const media = body.media || {};

    // 1. Embedded VoxelVision source
    if (media.type === 'voxelvision' || media.kind === 'voxelvision' || body.kind === 'voxelvision') {
      room.source = {
        kind: 'voxelvision',
        type: 'voxelvision',
        url: 'voxelvision://home',
        videoId: null,
        entryUrl: '/voxelvision/',
        title: String(media.title || body.title || 'VoxelVision').slice(0, 200),
        originalUrl: 'voxelvision://home',
        provider: 'voxelvision'
      };
      room.playback = { paused: true, ended: false, position: 0, rate: 1, updatedAt: now() };
      room.lastActivity = now();
      broadcastState(room);
      return json(res, 200, { ok: true, state: publicState(room) });
    }

    // 2. Nuvio media integration source
    if (media.type === 'nuvio' || media.kind === 'nuvio' || body.kind === 'nuvio') {
      room.source = {
        kind: 'nuvio',
        type: 'nuvio',
        url: media.url || body.url || null,
        videoId: null,
        entryUrl: '/nuvio/dist/index.html',
        title: String(media.title || body.title || 'Nuvio Media').slice(0, 200),
        originalUrl: body.originalUrl || media.url || 'nuvio://media',
        provider: 'nuvio',
        metadata: media.metadata || {}
      };
      room.playback = { paused: true, ended: false, position: 0, rate: 1, updatedAt: now() };
      room.lastActivity = now();
      broadcastState(room);
      return json(res, 200, { ok: true, state: publicState(room) });
    }

    // 3. Direct HLS or video file source
    const parsed = classifyMediaUrl(media.url);
    if (!parsed || parsed.kind === 'page') return json(res, 400, { error: 'media source must be a direct HLS, media-file, Nuvio, or VoxelVision source' });
    const publicUrl = await assertPublicHttpUrl(parsed.url);
    let referer = String(media.referer || body.originalUrl || '').trim();
    if (!referer || referer.includes('.watami.win') || referer.includes('.piltover.li') || referer.includes('.m3u8')) {
      referer = 'https://www.miruro.ru/';
    }
    room.source = {
      kind: 'media',
      type: parsed.kind,
      url: publicUrl,
      videoId: null,
      originalUrl: body.originalUrl || publicUrl,
      referer: referer || null,
      title: String(media.title || '').slice(0, 200) || null,
      server: String(media.server || '').slice(0, 120) || null,
      audio: ['sub', 'dub'].includes(media.audio) ? media.audio : null,
      subtitles: Array.isArray(media.subtitles) ? media.subtitles.slice(0, 12).map(item => ({ file: String(item.file || ''), label: String(item.label || 'English').slice(0, 80) })).filter(item => item.file) : []
    };
    room.playback = { paused: true, ended: false, position: 0, rate: 1, updatedAt: now() };
    room.lastActivity = now();
    broadcastState(room);
    return json(res, 200, { ok: true, state: publicState(room) });
  } catch (error) {
    return json(res, 400, { error: error.message || 'invalid media source' });
  }
}
