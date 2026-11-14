// 実況コメント (NX-Jikkyo)。
// チャンネルごとにサーバーから 1 本だけ接続して、そのチャンネルを見ている人全員に配る。
// Discord のアクティビティの中からは外部の WebSocket に直接つなげない (CSP) ので、ここで中継する。
import { WebSocket } from 'ws';

const USER_AGENT = 'KonomiTV-for-Discord';
// 誰も見なくなってから接続を切るまでの時間 (チャンネルを行き来したときにつなぎ直さないため)
const IDLE_CLOSE_MS = 30 * 1000;
const FLUSH_MS = 250;
const MAX_TEXT = 200;

// KonomiTV と同じ色 (ニコニコのコマンド名 -> 色)
const COLORS = {
    white: '#FFEAEA',
    red: '#F02840',
    pink: '#FD7E80',
    orange: '#FDA708',
    yellow: '#FFE133',
    green: '#64DD17',
    cyan: '#00D4F5',
    blue: '#4763FF',
    purple: '#D500F9',
    black: '#1E1310',
    white2: '#CCCC99',
    niconicowhite: '#CCCC99',
    red2: '#CC0033',
    truered: '#CC0033',
    pink2: '#FF33CC',
    orange2: '#FF6600',
    passionorange: '#FF6600',
    yellow2: '#999900',
    madyellow: '#999900',
    green2: '#00CC66',
    elementalgreen: '#00CC66',
    cyan2: '#00CCCC',
    blue2: '#3399FF',
    marineblue: '#3399FF',
    purple2: '#6633CC',
    nobleviolet: '#6633CC',
    black2: '#666666',
};
const POSITIONS = { ue: 'top', naka: 'right', shita: 'bottom' };
const SIZES = new Set(['big', 'medium', 'small']);

/** コメントのコマンド (mail) から、流し方・大きさ・色を取り出す */
export function parseMail(mail) {
    let type = 'right';
    let size = 'medium';
    let color = COLORS.white;
    if (typeof mail === 'string') {
        for (const command of mail.split(' ')) {
            if (POSITIONS[command]) type = POSITIONS[command];
            else if (SIZES.has(command)) size = command;
            else if (COLORS[command]) color = COLORS[command];
            else if (/^#[0-9a-f]{6}$/i.test(command)) color = command;
        }
    }
    return { type, size, color };
}

/**
 * @param {{ konomitvUrl: string, log: (...args: unknown[]) => void }} options
 */
export function createJikkyoHub({ konomitvUrl, log }) {
    /** @type {Map<string, ReturnType<typeof createFeed>>} */
    const feeds = new Map();

    function createFeed(channel) {
        const feed = {
            channel,
            /** @type {Set<import('ws').WebSocket>} */
            clients: new Set(),
            status: null,
            closed: false,
            watch: null,
            comment: null,
            keepSeat: null,
            retryTimer: null,
            idleTimer: null,
            flushTimer: null,
            retries: 0,
            queue: [],
        };

        const send = (client, message) => {
            if (client.readyState === 1) client.send(message);
        };
        const broadcast = obj => {
            const message = JSON.stringify(obj);
            for (const client of feed.clients) send(client, message);
        };
        const setStatus = (ok, detail) => {
            if (feed.status?.ok === ok && feed.status?.detail === detail) return;
            feed.status = { type: 'comments-status', channel, ok, detail };
            broadcast(feed.status);
        };

        const drop = socket => {
            if (!socket) return;
            socket.removeAllListeners();
            socket.on('error', () => {});
            socket.terminate();
        };
        const teardown = () => {
            clearInterval(feed.keepSeat);
            feed.keepSeat = null;
            drop(feed.watch);
            drop(feed.comment);
            feed.watch = feed.comment = null;
        };
        const retry = seconds => {
            teardown();
            if (feed.closed || feed.retryTimer) return;
            const wait = seconds ?? Math.min(60, 3 * 2 ** feed.retries++);
            feed.retryTimer = setTimeout(() => {
                feed.retryTimer = null;
                void connect();
            }, wait * 1000);
        };

        const flush = () => {
            feed.flushTimer = null;
            if (feed.queue.length > 0) broadcast({ type: 'chat', channel, comments: feed.queue.splice(0) });
        };

        const openComment = (uri, thread, threadkey) => {
            if (feed.closed) return;
            if (typeof uri !== 'string' || !uri.startsWith('wss://')) return retry();
            drop(feed.comment);
            const socket = new WebSocket(uri, { headers: { 'User-Agent': USER_AGENT } });
            feed.comment = socket;
            // 接続直後にまとめて届く過去のコメントは流さない。rf:0 が返ってきたら、そこから先が新しいコメント
            let live = false;
            socket.on('open', () => {
                socket.send(
                    JSON.stringify([
                        { ping: { content: 'rs:0' } },
                        { ping: { content: 'ps:0' } },
                        { thread: { version: '20061206', thread, threadkey, user_id: '', res_from: -1 } },
                        { ping: { content: 'pf:0' } },
                        { ping: { content: 'rf:0' } },
                    ]),
                );
            });
            socket.on('message', raw => {
                let message;
                try {
                    message = JSON.parse(raw.toString());
                } catch {
                    return;
                }
                if (message?.ping?.content === 'rf:0') {
                    live = true;
                    feed.retries = 0;
                    setStatus(true, null);
                    return;
                }
                const chat = message?.chat;
                if (!live || !chat || typeof chat.content !== 'string') return;
                if (chat.content === '' || chat.content.length > MAX_TEXT) return;
                const { type, size, color } = parseMail(chat.mail);
                feed.queue.push([chat.content, type, size, color]);
                if (!feed.flushTimer) feed.flushTimer = setTimeout(flush, FLUSH_MS);
            });
            socket.on('close', () => {
                if (feed.comment === socket) retry();
            });
            socket.on('error', e => {
                log('jikkyo comment error', channel, e.message);
                if (feed.comment === socket) retry();
            });
        };

        const connect = async () => {
            if (feed.closed) return;
            let info;
            try {
                const r = await fetch(`${konomitvUrl}/api/channels/${channel}/jikkyo`, { signal: AbortSignal.timeout(10000) });
                if (!r.ok) throw new Error(`KonomiTV -> ${r.status}`);
                info = await r.json();
            } catch (e) {
                log('jikkyo info error', channel, e.message);
                return retry();
            }
            if (feed.closed) return;
            if (typeof info?.watch_session_url !== 'string') {
                setStatus(false, 'このチャンネルには実況がありません');
                return retry(600);
            }

            const socket = new WebSocket(info.watch_session_url, { headers: { 'User-Agent': USER_AGENT } });
            feed.watch = socket;
            socket.on('open', () => socket.send(JSON.stringify({ type: 'startWatching', data: { reconnect: false } })));
            socket.on('message', raw => {
                let message;
                try {
                    message = JSON.parse(raw.toString());
                } catch {
                    return;
                }
                switch (message?.type) {
                    case 'seat': {
                        // 決められた間隔で keepSeat を送らないと切られる
                        clearInterval(feed.keepSeat);
                        const seconds = Math.max(10, Number(message.data?.keepIntervalSec) || 30);
                        feed.keepSeat = setInterval(() => {
                            if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'keepSeat' }));
                        }, seconds * 1000);
                        break;
                    }
                    case 'ping':
                        socket.send(JSON.stringify({ type: 'pong' }));
                        break;
                    case 'room':
                        openComment(message.data?.messageServer?.uri, message.data?.threadId ?? '', message.data?.yourPostKey ?? null);
                        break;
                    case 'reconnect':
                        retry(Math.max(1, Number(message.data?.waitTimeSec) || 3));
                        break;
                    case 'disconnect':
                        // 番組 (スレッド) の切り替わりならすぐつなぎ直す
                        retry(message.data?.reason === 'END_PROGRAM' ? 1 : undefined);
                        break;
                    case 'error':
                        log('jikkyo error', channel, message.data?.code);
                        setStatus(false, '実況に接続できませんでした');
                        retry(30);
                        break;
                }
            });
            socket.on('close', () => {
                if (feed.watch === socket) retry();
            });
            socket.on('error', e => {
                log('jikkyo watch error', channel, e.message);
                if (feed.watch === socket) retry();
            });
        };

        feed.close = () => {
            feed.closed = true;
            clearTimeout(feed.retryTimer);
            clearTimeout(feed.idleTimer);
            clearTimeout(feed.flushTimer);
            teardown();
        };
        feed.send = send;
        void connect();
        return feed;
    }

    /** client が受け取る実況のチャンネルを変える。channel が null なら受け取りをやめる */
    function subscribe(client, channel) {
        if (client.commentChannel === channel) return;
        unsubscribe(client);
        if (!channel) return;
        let feed = feeds.get(channel);
        if (!feed) {
            feed = createFeed(channel);
            feeds.set(channel, feed);
            log('jikkyo open', channel);
        }
        clearTimeout(feed.idleTimer);
        feed.idleTimer = null;
        feed.clients.add(client);
        client.commentChannel = channel;
        if (feed.status) feed.send(client, JSON.stringify(feed.status));
    }

    function unsubscribe(client) {
        const channel = client.commentChannel;
        client.commentChannel = null;
        const feed = channel ? feeds.get(channel) : null;
        if (!feed) return;
        feed.clients.delete(client);
        if (feed.clients.size > 0 || feed.idleTimer) return;
        feed.idleTimer = setTimeout(() => {
            if (feed.clients.size > 0) return;
            feed.close();
            feeds.delete(channel);
            log('jikkyo close', channel);
        }, IDLE_CLOSE_MS);
    }

    return { subscribe, unsubscribe };
}
