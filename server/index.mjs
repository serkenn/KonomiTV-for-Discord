// KonomiTV for Discord — 中継サーバー
// 役割: Discord の OAuth コード交換 / 視聴許可の判定 / KonomiTV API とライブ映像の中継 / チャンネル同期 (WebSocket)
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const env = process.env;
const PORT = Number(env.PORT || 7100);
const HOST = env.HOST || '127.0.0.1';
const KONOMITV_URL = (env.KONOMITV_URL || 'https://127-0-0-1.local.konomi.tv:7000').replace(/\/+$/, '');
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
const CHANNEL_ID_RE = /^[a-z0-9]{2,8}(-[0-9]{1,2})?$/;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_STREAMS_PER_SESSION = 2;
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'dist');

/** @type {Map<string, {user: {id: string, name: string, avatar: string | null}, exp: number, streams: number}>} */
const sessions = new Map();
/** @type {Map<string, {channel: string | null, by: string | null, clients: Set<import('ws').WebSocket>}>} */
const rooms = new Map();

const log = (...a) => console.log(new Date().toISOString(), ...a);

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
    p ? { title: p.title, description: p.description, start_time: p.start_time, end_time: p.end_time } : null;

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

async function handleStream(req, res, session, id, quality) {
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
        const up = await fetch(`${KONOMITV_URL}/api/streams/live/${id}/${quality}/mpegts`, { signal: ac.signal });
        if (!up.ok || !up.body) {
            release();
            return sendJson(res, 502, { error: 'konomitv_error', status: up.status });
        }
        log('stream start', session.user.name, id, quality);
        res.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Cache-Control': 'no-store, no-transform',
            'X-Accel-Buffering': 'no',
        });
        const body = Readable.fromWeb(up.body);
        body.on('error', () => res.destroy());
        body.on('end', () => log('stream end', session.user.name, id, quality));
        body.pipe(res);
    } catch (e) {
        release();
        if (!res.headersSent) sendJson(res, 502, { error: 'konomitv_unreachable' });
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
            return await handleStream(req, res, session, m[1], m[2]);
        }
        sendJson(res, 404, { error: 'not_found' });
    } catch (e) {
        log('request error', req.url, e.message);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
        else res.destroy();
    }
});

// ---------- WebSocket: 同じアクティビティ (instance) の人でチャンネルを揃える ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

function broadcast(room) {
    const members = [];
    const seen = new Set();
    for (const c of room.clients) {
        if (seen.has(c.user.id)) continue;
        seen.add(c.user.id);
        members.push(c.user);
    }
    const msg = JSON.stringify({ type: 'state', channel: room.channel, by: room.by, members });
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
        if (!room) rooms.set(instance, (room = { channel: null, by: null, clients: new Set() }));
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
                room.by = session.user.name;
                broadcast(room);
            }
        });
        ws.on('close', () => {
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
