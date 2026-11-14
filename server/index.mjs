// KonomiTV for Discord — 中継サーバー
// 役割: Discord の OAuth コード交換 / 視聴許可の判定 / KonomiTV のライブ映像とデータ放送の中継 (副音声・主+副の切り替え) /
//       EPGStation の録画の中継 / 実況コメントの中継 / チャンネルと録画の同期 (WebSocket)
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { canMixAudio, spawnAudioMixer, swapAudioPids } from './audio.mjs';
import { createJikkyoHub } from './jikkyo.mjs';

const env = process.env;
const PORT = Number(env.PORT || 7100);
const HOST = env.HOST || '127.0.0.1';
const KONOMITV_URL = (env.KONOMITV_URL || 'https://127-0-0-1.local.konomi.tv:7000').replace(/\/+$/, '');
// 録画の一覧と再生は EPGStation から取る。空にすると録画タブを出さない。
const EPGSTATION_URL = (env.EPGSTATION_URL ?? 'http://127.0.0.1:8888').trim().replace(/\/+$/, '');
const CLIENT_ID = (env.DISCORD_CLIENT_ID || '').trim();
const CLIENT_SECRET = (env.DISCORD_CLIENT_SECRET || '').trim();
const list = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_GUILDS = new Set(list(env.ALLOWED_GUILD_IDS));
const ALLOWED_USERS = new Set(list(env.ALLOWED_USER_IDS));
// 開発用: Discord を通さずに誰でも入れる。HOST が 127.0.0.1 のときだけ有効にできる。
const DEV_NO_AUTH = env.DEV_NO_AUTH === '1';
if (DEV_NO_AUTH && HOST !== '127.0.0.1') {
    console.error('DEV_NO_AUTH=1 は HOST=127.0.0.1 のときだけ使えます');
    process.exit(1);
}

const QUALITIES = ['1080p', '720p', '540p', '480p', '360p', '240p'];
// 主音声 / 副音声 / 主+副 (左に主音声、右に副音声)
const AUDIO_MODES = ['main', 'sub', 'both'];
const CHANNEL_ID_RE = /^[a-z0-9]{2,8}(-[0-9]{1,2})?$/;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
// 映像 (録画の変換配信を含む) とデータ放送で 1 人 2 本。切り替え中は一時的に倍になる
const MAX_STREAMS_PER_SESSION = 6;
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'dist');

/** @type {Map<string, {user: {id: string, name: string, avatar: string | null}, exp: number, streams: number}>} */
const sessions = new Map();
/**
 * channel: みんなで見ている放送中のチャンネル。rec: みんなで見ている録画 (どちらか一方)。
 * @type {Map<string, {channel: string | null, rec: object | null, by: string | null, clients: Set<import('ws').WebSocket>}>}
 */
const rooms = new Map();

const log = (...a) => console.log(new Date().toISOString(), ...a);
const jikkyo = createJikkyoHub({ konomitvUrl: KONOMITV_URL, log });

function sendJson(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data),
        'Cache-Control': 'no-store',
    });
    res.end(data);
}

function readBody(req, limit = 16 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', c => {
            size += c.length;
            if (size > limit) {
                reject(new Error('body too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function getSession(req, url) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('t');
    if (!token) return null;
    const s = sessions.get(token);
    if (!s) return null;
    if (s.exp < Date.now()) {
        sessions.delete(token);
        return null;
    }
    return s;
}

setInterval(() => {
    const now = Date.now();
    for (const [k, s] of sessions) if (s.exp < now && s.streams === 0) sessions.delete(k);
}, 10 * 60 * 1000).unref();

// ---------- Discord 認証 ----------

async function discordGet(path, accessToken) {
    const r = await fetch(`https://discord.com/api/v10${path}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`Discord API ${path} -> ${r.status}`);
    return r.json();
}

async function handleToken(req, res) {
    let body;
    try {
        body = JSON.parse((await readBody(req)) || '{}');
    } catch {
        return sendJson(res, 400, { error: 'bad_request' });
    }

    let user;
    let accessToken = null;
    if (DEV_NO_AUTH) {
        user = { id: 'dev-' + randomBytes(3).toString('hex'), name: '開発ユーザー', avatar: null };
    } else {
        if (!CLIENT_ID || !CLIENT_SECRET) {
            return sendJson(res, 503, { error: 'not_configured', message: 'DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET が未設定です' });
        }
        if (ALLOWED_GUILDS.size === 0 && ALLOWED_USERS.size === 0) {
            return sendJson(res, 503, { error: 'not_configured', message: 'ALLOWED_GUILD_IDS か ALLOWED_USER_IDS を設定してください' });
        }
        if (typeof body.code !== 'string' || body.code.length > 200) return sendJson(res, 400, { error: 'bad_request' });
        try {
            const r = await fetch('https://discord.com/api/oauth2/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: CLIENT_ID,
                    client_secret: CLIENT_SECRET,
                    grant_type: 'authorization_code',
                    code: body.code,
                }),
                signal: AbortSignal.timeout(10000),
            });
            if (!r.ok) {
                log('token exchange failed', r.status);
                return sendJson(res, 401, { error: 'token_exchange_failed' });
            }
            accessToken = (await r.json()).access_token;
            const me = await discordGet('/users/@me', accessToken);
            // クライアントの申告は信用せず、Discord API で本人とサーバー所属を確かめる
            let allowed = ALLOWED_USERS.has(me.id);
            if (!allowed && ALLOWED_GUILDS.size > 0) {
                const guilds = await discordGet('/users/@me/guilds?limit=200', accessToken);
                allowed = guilds.some(g => ALLOWED_GUILDS.has(g.id));
            }
            if (!allowed) {
                log('denied', me.id, me.username);
                return sendJson(res, 403, { error: 'forbidden', message: 'このアクティビティを見る権限がありません' });
            }
            user = { id: me.id, name: me.global_name || me.username, avatar: me.avatar || null };
        } catch (e) {
            log('auth error', e.message);
            return sendJson(res, 502, { error: 'discord_unreachable' });
        }
    }

    const session = randomBytes(32).toString('base64url');
    sessions.set(session, { user, exp: Date.now() + SESSION_TTL_MS, streams: 0 });
    log('login', user.id, user.name);
    sendJson(res, 200, { access_token: accessToken, session, user });
}

// ---------- KonomiTV 中継 ----------

let channelsCache = { at: 0, data: null };

const pickProgram = p =>
    p
        ? {
              title: p.title,
              description: p.description,
              start_time: p.start_time,
              end_time: p.end_time,
              // 副音声があるかどうかの判断に使う (主音声がデュアルモノなら、右チャンネルが副音声になる)
              primary_audio_type: p.primary_audio_type ?? null,
              secondary_audio_type: p.secondary_audio_type ?? null,
          }
        : null;

async function handleChannels(res) {
    if (!channelsCache.data || Date.now() - channelsCache.at > 5000) {
        const r = await fetch(`${KONOMITV_URL}/api/channels`, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) return sendJson(res, 502, { error: 'konomitv_error', status: r.status });
        const raw = await r.json();
        const out = [];
        for (const [type, chs] of Object.entries(raw)) {
            for (const c of chs) {
                if (!c.is_display || !c.is_watchable) continue;
                out.push({
                    id: c.display_channel_id,
                    type,
                    name: c.name,
                    number: c.channel_number,
                    service_id: c.service_id,
                    is_radio: c.is_radiochannel,
                    viewers: c.viewer_count,
                    present: pickProgram(c.program_present),
                    following: pickProgram(c.program_following),
                });
            }
        }
        channelsCache = { at: Date.now(), data: out };
    }
    sendJson(res, 200, { channels: channelsCache.data, qualities: QUALITIES });
}

async function handleLogo(res, id) {
    const r = await fetch(`${KONOMITV_URL}/api/channels/${id}/logo`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) {
        res.writeHead(404).end();
        return;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, {
        'Content-Type': r.headers.get('content-type') || 'image/png',
        'Content-Length': buf.length,
        'Cache-Control': 'private, max-age=86400',
    });
    res.end(buf);
}

/** 主+副: ffmpeg で音声だけ作り直して流す */
function pipeThroughMixer(body, res) {
    const ff = spawnAudioMixer();
    let stderr = '';
    ff.stderr.on('data', d => (stderr = (stderr + d).slice(-400)));
    // ffmpeg が先に終わったときに書き込めなくなるのは気にしない
    ff.stdin.on('error', () => {});
    ff.on('error', e => {
        log('ffmpeg error', e.message);
        res.destroy();
    });
    ff.on('close', (code, signal) => {
        if (code !== 0 && !res.destroyed) {
            log('ffmpeg exited', code ?? signal, stderr.trim());
            res.destroy();
        }
    });
    res.on('close', () => ff.kill('SIGKILL'));
    body.pipe(ff.stdin);
    ff.stdout.pipe(res);
}

/**
 * KonomiTV の終わりのないレスポンスをそのまま流す。
 * kind: 'mpegts' は映像、'psi-archived-data' はデータ放送 (d ボタン) の元データ。
 * audio: 映像の音声。'sub' は副音声、'both' は主+副。
 */
async function handleStream(req, res, session, id, quality, kind = 'mpegts', audio = 'main') {
    if (session.streams >= MAX_STREAMS_PER_SESSION) return sendJson(res, 429, { error: 'too_many_streams' });
    session.streams++;
    const ac = new AbortController();
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        session.streams--;
        ac.abort();
    };
    res.on('close', release);
    try {
        const up = await fetch(`${KONOMITV_URL}/api/streams/live/${id}/${quality}/${kind}`, { signal: ac.signal });
        if (!up.ok || !up.body) {
            release();
            return sendJson(res, 502, { error: 'konomitv_error', status: up.status });
        }
        const isVideo = kind === 'mpegts';
        log(isVideo ? 'stream start' : 'data start', session.user.name, id, quality, ...(audio === 'main' ? [] : [`audio=${audio}`]));
        res.writeHead(200, {
            'Content-Type': isVideo ? 'video/mp2t' : 'application/octet-stream',
            'Cache-Control': 'no-store, no-transform',
            'X-Accel-Buffering': 'no',
        });
        const body = Readable.fromWeb(up.body);
        body.on('error', () => res.destroy());
        if (isVideo) body.on('end', () => log('stream end', session.user.name, id, quality));
        if (audio === 'sub') body.pipe(swapAudioPids()).on('error', () => res.destroy()).pipe(res);
        else if (audio === 'both') pipeThroughMixer(body, res);
        else body.pipe(res);
    } catch (e) {
        release();
        if (!res.headersSent) sendJson(res, 502, { error: 'konomitv_unreachable' });
        else res.destroy();
    }
}

// ---------- 録画 (EPGStation) ----------

/** 録画ファイル ID -> 直接配信してよいファイルか。一覧や 1 件取得で返したファイルを覚えておく */
const recFiles = new Map();
let recFilesRefreshedAt = 0;
/** チャンネル名と、その場で変換するときに選べる画質の一覧 */
let epgMeta = { at: 0, channels: new Map(), modes: {} };

async function epgJson(path) {
    const r = await fetch(`${EPGSTATION_URL}${path}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw Object.assign(new Error(`EPGStation ${path} -> ${r.status}`), { status: r.status });
    return r.json();
}

async function ensureEpgMeta() {
    if (Date.now() - epgMeta.at < 10 * 60 * 1000) return;
    const [channels, config] = await Promise.all([epgJson('/api/channels'), epgJson('/api/config')]);
    epgMeta = {
        at: Date.now(),
        channels: new Map(channels.map(c => [c.id, c.halfWidthName || c.name])),
        modes: config.streamConfig?.recorded ?? {},
    };
}

function rememberFile(v) {
    const ext = (v.filename ?? '').toLowerCase().match(/\.(mp4|webm)$/)?.[1] ?? null;
    // ブラウザがそのまま再生できるのは、エンコード済みの mp4 / webm だけ
    const direct = v.type === 'encoded' && ext !== null;
    recFiles.set(v.id, { direct });
    return { id: v.id, type: v.type, name: v.name, size: v.size, direct, ext };
}

function shapeRecord(r) {
    return {
        id: r.id,
        name: r.name,
        description: r.description ?? '',
        start: r.startAt,
        end: r.endAt,
        channel: epgMeta.channels.get(r.channelId) ?? '',
        recording: !!r.isRecording,
        thumbnail: r.thumbnails?.[0] ?? null,
        files: (r.videoFiles ?? []).map(rememberFile),
    };
}

async function handleRecordedList(res, url) {
    const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0));
    const keyword = (url.searchParams.get('keyword') || '').trim().slice(0, 100);
    await ensureEpgMeta();
    const query = new URLSearchParams({ isHalfWidth: 'true', offset: String(offset), limit: '30' });
    if (keyword) query.set('keyword', keyword);
    const raw = await epgJson(`/api/recorded?${query}`);
    sendJson(res, 200, { records: raw.records.map(shapeRecord), total: raw.total, modes: epgMeta.modes });
}

/** 1 件だけ返す。ほかの人が再生した録画が、自分の一覧 (検索中や未読み込みの続き) にないときに使う */
async function handleRecordedItem(res, id) {
    await ensureEpgMeta();
    try {
        const raw = await epgJson(`/api/recorded/${id}?isHalfWidth=true`);
        sendJson(res, 200, { record: shapeRecord(raw), modes: epgMeta.modes });
    } catch (e) {
        if (e.status === 404) return sendJson(res, 404, { error: 'not_found' });
        throw e;
    }
}

/**
 * 配信してよい録画ファイルか。一覧を経由せずに来たとき (サーバー再起動直後など) は全件を引き直して確かめる。
 * 存在しない ID を何度も送られても EPGStation を叩きすぎないよう、引き直しは 30 秒に 1 回まで。
 */
async function knownRecFile(id) {
    if (!recFiles.has(id) && Date.now() - recFilesRefreshedAt > 30 * 1000) {
        recFilesRefreshedAt = Date.now();
        const raw = await epgJson('/api/recorded?isHalfWidth=true&offset=0&limit=1000');
        for (const r of raw.records) for (const v of r.videoFiles ?? []) rememberFile(v);
    }
    return recFiles.get(id) ?? null;
}

/** 途中から録画したものは番組表の長さより短いので、ファイルの実際の長さを返す */
async function handleRecordedDuration(res, id) {
    if (!(await knownRecFile(id))) return sendJson(res, 404, { error: 'not_found' });
    const d = await epgJson(`/api/videos/${id}/duration`);
    sendJson(res, 200, { duration: Number(d.duration) || 0 });
}

// ---------- 録画の実況コメント (過去ログ) ----------
// KonomiTV が同じ TS を読み込んでいれば、録画の開始時刻に合わせた過去ログを返してくれる

async function konomiJson(path, timeout = 10000) {
    const r = await fetch(`${KONOMITV_URL}${path}`, { signal: AbortSignal.timeout(timeout) });
    if (!r.ok) throw Object.assign(new Error(`KonomiTV ${path} -> ${r.status}`), { status: r.status });
    return r.json();
}

/** KonomiTV の録画 (ファイル名 -> 番号) */
let konomiVideos = { at: 0, ids: new Map() };
/** 録画番号 -> 過去ログ (同じ録画を何人かで見るときに取り直さない) */
const recCommentCache = new Map();

async function findKonomiVideo(filename) {
    const age = Date.now() - konomiVideos.at;
    // 5 分ごとに取り直す。見つからないときは、新しく録画されたかもしれないので 30 秒たっていれば取り直す
    if (age > 5 * 60 * 1000 || (!konomiVideos.ids.has(filename) && age > 30 * 1000)) {
        const ids = new Map();
        for (let page = 1; page <= 100; page++) {
            const d = await konomiJson(`/api/videos?order=desc&page=${page}`);
            const list = d.recorded_programs ?? [];
            for (const v of list) {
                const file = v.recorded_video?.file_path;
                if (typeof file === 'string') ids.set(file.slice(file.lastIndexOf('/') + 1), v.id);
            }
            if (list.length === 0 || ids.size >= d.total) break;
        }
        konomiVideos = { at: Date.now(), ids };
    }
    return konomiVideos.ids.get(filename) ?? null;
}

async function handleRecordedComments(res, recordedId) {
    let record;
    try {
        record = await epgJson(`/api/recorded/${recordedId}?isHalfWidth=true`);
    } catch (e) {
        if (e.status === 404) return sendJson(res, 404, { error: 'not_found' });
        throw e;
    }
    const ts = (record.videoFiles ?? []).find(v => v.type === 'ts');
    if (!ts) return sendJson(res, 200, { comments: [], detail: 'TS ファイルが残っていない録画には、コメントを出せません' });
    const videoId = await findKonomiVideo(ts.filename);
    if (videoId === null) {
        return sendJson(res, 200, { comments: [], detail: 'KonomiTV がまだこの録画を読み込んでいないため、コメントを出せません' });
    }
    const cached = recCommentCache.get(videoId);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return sendJson(res, 200, cached.body);

    const d = await konomiJson(`/api/videos/${videoId}/jikkyo`, 60 * 1000);
    if (!d.is_success) return sendJson(res, 200, { comments: [], detail: d.detail || 'コメントを取得できませんでした' });
    // [録画の先頭からの秒数, 本文, 流し方, 大きさ, 色]。投稿者の ID は送らない
    const comments = (d.comments ?? [])
        .filter(c => typeof c.text === 'string' && c.text !== '' && c.text.length <= 200 && Number.isFinite(c.time))
        .map(c => [Math.round(c.time * 100) / 100, c.text, c.type, c.size, c.color]);
    const body = { comments, detail: null };
    recCommentCache.set(videoId, { at: Date.now(), body });
    if (recCommentCache.size > 20) recCommentCache.delete(recCommentCache.keys().next().value);
    sendJson(res, 200, body);
}

async function handleRecordedThumbnail(res, id) {
    const r = await fetch(`${EPGSTATION_URL}/api/thumbnails/${id}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return void res.writeHead(404).end();
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, {
        'Content-Type': r.headers.get('content-type') || 'image/jpeg',
        'Content-Length': buf.length,
        'Cache-Control': 'private, max-age=86400',
    });
    res.end(buf);
}

/** 保存済みの mp4 / webm をそのまま流す。シークできるように Range をそのまま通す */
async function handleRecordedFile(req, res, id) {
    const file = await knownRecFile(id);
    if (!file?.direct) return sendJson(res, 404, { error: 'not_found' });
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    let up;
    try {
        up = await fetch(`${EPGSTATION_URL}/api/videos/${id}`, { headers, signal: ac.signal });
    } catch {
        // 見ている側が先に切った (シークで取り直したなど) か、EPGStation に届かない
        if (!res.headersSent) sendJson(res, 502, { error: 'epgstation_unreachable' });
        return;
    }
    if (!up.body || (up.status !== 200 && up.status !== 206)) {
        return sendJson(res, up.status === 416 ? 416 : 502, { error: 'epgstation_error', status: up.status });
    }
    const out = { 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes' };
    for (const h of ['content-type', 'content-length', 'content-range']) {
        const v = up.headers.get(h);
        if (v) out[h] = v;
    }
    res.writeHead(up.status, out);
    const body = Readable.fromWeb(up.body);
    body.on('error', () => res.destroy());
    body.pipe(res);
}

/** TS などを EPGStation にその場で mp4 / webm へ変換させて流す。ss は開始位置 (秒) */
async function handleRecordedTranscode(res, session, id, format, mode, ss) {
    if (!(await knownRecFile(id))) return sendJson(res, 404, { error: 'not_found' });
    if (session.streams >= MAX_STREAMS_PER_SESSION) return sendJson(res, 429, { error: 'too_many_streams' });
    session.streams++;
    const ac = new AbortController();
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        session.streams--;
        ac.abort();
    };
    res.on('close', release);
    try {
        const up = await fetch(`${EPGSTATION_URL}/api/streams/recorded/${id}/${format}?ss=${ss}&mode=${mode}`, {
            signal: ac.signal,
        });
        if (!up.ok || !up.body) {
            release();
            return sendJson(res, 502, { error: 'epgstation_error', status: up.status });
        }
        log('recorded start', session.user.name, id, format, mode, `ss=${ss}`);
        res.writeHead(200, {
            'Content-Type': format === 'webm' ? 'video/webm' : 'video/mp4',
            'Cache-Control': 'no-store, no-transform',
            'X-Accel-Buffering': 'no',
        });
        const body = Readable.fromWeb(up.body);
        body.on('error', () => res.destroy());
        body.pipe(res);
    } catch {
        release();
        if (!res.headersSent) sendJson(res, 502, { error: 'epgstation_unreachable' });
        else res.destroy();
    }
}

// ---------- 静的ファイル ----------

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json',
    '.map': 'application/json',
    '.woff2': 'font/woff2',
};

async function serveStatic(res, pathname) {
    let rel;
    try {
        rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    } catch {
        res.writeHead(400).end();
        return;
    }
    let file = join(DIST, rel);
    if (file !== DIST && !file.startsWith(DIST + sep)) {
        res.writeHead(403).end();
        return;
    }
    let st = await stat(file).catch(() => null);
    if (!st || st.isDirectory()) {
        file = join(DIST, 'index.html');
        st = await stat(file).catch(() => null);
        if (!st) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('client is not built');
            return;
        }
    }
    const isAsset = file.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
        'Content-Type': MIME[extname(file)] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).pipe(res);
}

// ---------- HTTP ----------

// Discord のプロキシ経由だと /.proxy/ が付いた形でも届くので、どちらでも同じ扱いにする
const stripProxy = p => (p.startsWith('/.proxy/') ? p.slice(7) : p);

const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url || '/', 'http://localhost');
        const path = stripProxy(url.pathname);

        if (!path.startsWith('/api/')) {
            if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
            return await serveStatic(res, path);
        }
        if (path === '/api/config' && req.method === 'GET') {
            return sendJson(res, 200, {
                clientId: CLIENT_ID,
                scopes: ['identify', ...(ALLOWED_GUILDS.size > 0 ? ['guilds'] : [])],
                dev: DEV_NO_AUTH,
                recorded: EPGSTATION_URL !== '',
                audioMix: canMixAudio,
            });
        }
        if (path === '/api/token' && req.method === 'POST') return await handleToken(req, res);

        const session = getSession(req, url);
        if (!session) return sendJson(res, 401, { error: 'unauthorized' });
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });

        if (path === '/api/channels') return await handleChannels(res);
        let m = path.match(/^\/api\/channels\/([^/]+)\/logo$/);
        if (m && CHANNEL_ID_RE.test(m[1])) return await handleLogo(res, m[1]);
        m = path.match(/^\/api\/stream\/([^/]+)\/([^/]+)$/);
        if (m && CHANNEL_ID_RE.test(m[1]) && QUALITIES.includes(m[2])) {
            const audio = url.searchParams.get('audio') ?? 'main';
            if (!AUDIO_MODES.includes(audio) || (audio === 'both' && !canMixAudio)) {
                return sendJson(res, 400, { error: 'bad_audio' });
            }
            return await handleStream(req, res, session, m[1], m[2], 'mpegts', audio);
        }
        m = path.match(/^\/api\/psi\/([^/]+)\/([^/]+)$/);
        if (m && CHANNEL_ID_RE.test(m[1]) && QUALITIES.includes(m[2])) {
            return await handleStream(req, res, session, m[1], m[2], 'psi-archived-data');
        }
        if (EPGSTATION_URL && path.startsWith('/api/recorded')) {
            if (path === '/api/recorded') return await handleRecordedList(res, url);
            m = path.match(/^\/api\/recorded\/thumbnail\/(\d{1,9})$/);
            if (m) return await handleRecordedThumbnail(res, Number(m[1]));
            m = path.match(/^\/api\/recorded\/item\/(\d{1,9})$/);
            if (m) return await handleRecordedItem(res, Number(m[1]));
            m = path.match(/^\/api\/recorded\/duration\/(\d{1,9})$/);
            if (m) return await handleRecordedDuration(res, Number(m[1]));
            m = path.match(/^\/api\/recorded\/comments\/(\d{1,9})$/);
            if (m) return await handleRecordedComments(res, Number(m[1]));
            m = path.match(/^\/api\/recorded\/file\/(\d{1,9})$/);
            if (m) return await handleRecordedFile(req, res, Number(m[1]));
            m = path.match(/^\/api\/recorded\/stream\/(\d{1,9})\/(mp4|webm)\/([0-9])$/);
            if (m) {
                const ss = Math.max(0, Math.floor(Number(url.searchParams.get('ss')) || 0));
                return await handleRecordedTranscode(res, session, Number(m[1]), m[2], Number(m[3]), ss);
            }
        }
        sendJson(res, 404, { error: 'not_found' });
    } catch (e) {
        log('request error', req.url, e.message);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
        else res.destroy();
    }
});

// ---------- WebSocket: 同じアクティビティ (instance) の人でチャンネルや録画を揃える ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

function broadcast(room) {
    const members = [];
    const seen = new Set();
    for (const c of room.clients) {
        if (seen.has(c.user.id)) continue;
        seen.add(c.user.id);
        members.push(c.user);
    }
    // 録画は「いまの再生位置」に直してから配る (あとから入った人もそこから見始められる)
    let rec = null;
    if (room.rec) {
        const elapsed = room.rec.playing ? (Date.now() - room.rec.at) / 1000 : 0;
        rec = { ...room.rec, pos: room.rec.pos + elapsed, at: undefined };
    }
    const msg = JSON.stringify({ type: 'state', channel: room.channel, rec, by: room.by, members });
    for (const c of room.clients) if (c.readyState === 1) c.send(msg);
}

server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const session = stripProxy(url.pathname) === '/api/ws' ? getSession(req, url) : null;
    const instance = url.searchParams.get('instance') || '';
    if (!session || !/^[\w-]{1,100}$/.test(instance)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
        ws.user = session.user;
        ws.alive = true;
        let room = rooms.get(instance);
        if (!room) rooms.set(instance, (room = { channel: null, rec: null, by: null, clients: new Set() }));
        room.clients.add(ws);
        broadcast(room);

        ws.on('pong', () => (ws.alive = true));
        ws.on('message', raw => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                return;
            }
            if (msg?.type === 'select' && typeof msg.channel === 'string' && CHANNEL_ID_RE.test(msg.channel)) {
                room.channel = msg.channel;
                room.rec = null;
                room.by = session.user.name;
                broadcast(room);
            } else if (
                msg?.type === 'rec' &&
                Number.isSafeInteger(msg.recordedId) &&
                msg.recordedId > 0 &&
                Number.isFinite(msg.pos) &&
                msg.pos >= 0 &&
                msg.pos < 7 * 24 * 3600
            ) {
                // 配信形式 (mp4 / webm など) は各自で選ぶので、そろえるのは録画・位置・再生中かどうかだけ
                room.channel = null;
                room.rec = { recordedId: msg.recordedId, pos: msg.pos, playing: msg.playing !== false, at: Date.now() };
                room.by = session.user.name;
                broadcast(room);
            } else if (
                msg?.type === 'comments' &&
                (msg.channel === null || (typeof msg.channel === 'string' && CHANNEL_ID_RE.test(msg.channel)))
            ) {
                // 実況コメントは各自が見ているチャンネルの分だけ受け取る (同期をオフにしている人もいるため)
                jikkyo.subscribe(ws, msg.channel);
            }
        });
        ws.on('close', () => {
            jikkyo.unsubscribe(ws);
            room.clients.delete(ws);
            if (room.clients.size === 0) rooms.delete(instance);
            else broadcast(room);
        });
        ws.on('error', () => ws.terminate());
    });
});

setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.alive) {
            ws.terminate();
            continue;
        }
        ws.alive = false;
        ws.ping();
    }
}, 30000).unref();

server.listen(PORT, HOST, () => {
    log(`KonomiTV for Discord: http://${HOST}:${PORT}  ->  ${KONOMITV_URL}`);
    if (DEV_NO_AUTH) log('!! DEV_NO_AUTH=1: 認証なしで動いています (開発用)');
    else if (!CLIENT_ID || !CLIENT_SECRET) log('!! Discord の Client ID / Secret が未設定です');
    else if (ALLOWED_GUILDS.size === 0 && ALLOWED_USERS.size === 0) log('!! 視聴を許可するサーバー / ユーザーが未設定です (全員拒否)');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
