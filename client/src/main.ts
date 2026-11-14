import { DiscordSDK } from '@discord/embedded-app-sdk';
import { LivePlayer, type PlayerState } from './player';
import './style.css';

interface Program {
    title: string;
    description: string;
    start_time: string;
    end_time: string;
}
interface Channel {
    id: string;
    type: string;
    name: string;
    number: string;
    is_radio: boolean;
    viewers: number;
    present: Program | null;
    following: Program | null;
}
interface Member {
    id: string;
    name: string;
    avatar: string | null;
}
interface RoomState {
    type: 'state';
    channel: string | null;
    by: string | null;
    members: Member[];
}
interface AuthorizeScopes {
    scope: Parameters<DiscordSDK['commands']['authorize']>[0]['scope'];
}

// Discord の中では、自分のサーバーへの通信はすべて /.proxy/ を通す
const BASE = location.hostname.endsWith('.discordsays.com') ? '/.proxy' : '';
const IN_DISCORD = new URLSearchParams(location.search).has('frame_id');

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $('stage');
const video = $<HTMLVideoElement>('video');
const statusBox = $('status');
const statusText = $('status-text');
const spinner = $('spinner');
const unmuteBtn = $<HTMLButtonElement>('unmute');
const nowLogo = $<HTMLImageElement>('now-logo');
const nowChannel = $('now-channel');
const nowTitle = $('now-title');
const membersBox = $('members');
const muteBtn = $<HTMLButtonElement>('mute');
const volumeInput = $<HTMLInputElement>('volume');
const syncInput = $<HTMLInputElement>('sync');
const qualitySelect = $<HTMLSelectElement>('quality');
const toggleListBtn = $<HTMLButtonElement>('toggle-list');
const sidebar = $('sidebar');
const channelList = $('channels');

const store = {
    get(key: string): string | null {
        try {
            return localStorage.getItem(`ktvd:${key}`);
        } catch {
            return null;
        }
    },
    set(key: string, value: string): void {
        try {
            localStorage.setItem(`ktvd:${key}`, value);
        } catch {
            // 保存できなくても動作には影響しない
        }
    },
};

let session = '';
let channels: Channel[] = [];
let current: string | null = null;
let quality = store.get('quality') ?? '720p';
let room: RoomState | null = null;
let ws: WebSocket | null = null;
let initialChosen = false;

function setStatus(text: string | null, busy = true): void {
    statusBox.hidden = text === null;
    statusText.textContent = text ?? '';
    spinner.hidden = !busy;
}

const player = new LivePlayer(video, (state: PlayerState) => {
    const name = channels.find(c => c.id === current)?.name ?? '';
    if (state === 'playing') setStatus(null);
    else if (state === 'loading') setStatus(`${name} を読み込んでいます…`);
    else if (state === 'reconnecting') setStatus('接続が切れました。つなぎ直しています…');
    else setStatus('この端末では再生できません（Media Source Extensions に非対応）', false);
});
player.onAutoplayMuted = () => {
    unmuteBtn.hidden = false;
    renderVolume();
};

// ---------- API ----------

async function api<T>(path: string): Promise<T> {
    const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${session}` } });
    if (!r.ok) throw new Error(`${path} -> ${r.status}`);
    return r.json() as Promise<T>;
}

const logoUrl = (id: string) => `${BASE}/api/channels/${id}/logo?t=${encodeURIComponent(session)}`;
// mpegts.js は Worker の中から取得するので、絶対 URL で渡す
const streamUrl = (id: string) =>
    `${location.origin}${BASE}/api/stream/${id}/${quality}?t=${encodeURIComponent(session)}`;

// ---------- 表示 ----------

const hhmm = (iso: string) => {
    const d = new Date(iso);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function progressOf(p: Program | null): number {
    if (!p) return 0;
    const start = Date.parse(p.start_time);
    const end = Date.parse(p.end_time);
    if (!(end > start)) return 0;
    return Math.min(1, Math.max(0, (Date.now() - start) / (end - start)));
}

function renderChannels(): void {
    channelList.replaceChildren(
        ...channels.map(ch => {
            const li = document.createElement('li');
            li.className = 'channel' + (ch.id === current ? ' is-active' : '');
            li.tabIndex = 0;
            li.setAttribute('role', 'button');

            const logo = document.createElement('img');
            logo.className = 'channel__logo';
            logo.src = logoUrl(ch.id);
            logo.alt = '';
            logo.loading = 'lazy';

            const body = document.createElement('div');
            body.className = 'channel__body';
            const name = document.createElement('div');
            name.className = 'channel__name';
            name.textContent = ch.name;
            if (ch.viewers > 0) {
                const viewers = document.createElement('span');
                viewers.className = 'channel__viewers';
                viewers.textContent = `${ch.viewers}人`;
                name.append(viewers);
            }
            const title = document.createElement('div');
            title.className = 'channel__title';
            title.textContent = ch.present?.title ?? '放送休止';
            body.append(name, title);
            if (ch.present) {
                const time = document.createElement('div');
                time.className = 'channel__time';
                time.textContent = `${hhmm(ch.present.start_time)} – ${hhmm(ch.present.end_time)}`;
                const bar = document.createElement('div');
                bar.className = 'channel__bar';
                const fill = document.createElement('div');
                fill.style.width = `${progressOf(ch.present) * 100}%`;
                bar.append(fill);
                body.append(time, bar);
            }

            li.append(logo, body);
            const choose = () => selectChannel(ch.id, true);
            li.addEventListener('click', choose);
            li.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    choose();
                }
            });
            return li;
        }),
    );
}

function renderNow(): void {
    const ch = channels.find(c => c.id === current);
    if (!ch) {
        nowLogo.hidden = true;
        nowChannel.textContent = '';
        nowTitle.textContent = '';
        return;
    }
    nowLogo.hidden = false;
    if (!nowLogo.src.endsWith(logoUrl(ch.id))) nowLogo.src = logoUrl(ch.id);
    nowChannel.textContent = ch.name;
    nowTitle.textContent = ch.present
        ? `${ch.present.title}（${hhmm(ch.present.start_time)} – ${hhmm(ch.present.end_time)}）`
        : '';
}

function renderMembers(): void {
    const members = room?.members ?? [];
    membersBox.replaceChildren(
        ...members.slice(0, 8).map(m => {
            if (m.avatar) {
                const img = document.createElement('img');
                img.className = 'member';
                img.src = `https://cdn.discordapp.com/avatars/${m.id}/${m.avatar}.png?size=64`;
                img.alt = m.name;
                img.title = m.name;
                return img;
            }
            const span = document.createElement('span');
            span.className = 'member member--initial';
            span.textContent = m.name.slice(0, 1);
            span.title = m.name;
            return span;
        }),
    );
}

function renderVolume(): void {
    muteBtn.textContent = video.muted || video.volume === 0 ? '🔇' : '🔊';
    volumeInput.value = video.muted ? '0' : String(video.volume);
}

let toastTimer: number | undefined;
function toast(text: string): void {
    let el = document.querySelector<HTMLDivElement>('.toast');
    if (!el) {
        el = document.createElement('div');
        el.className = 'toast';
        stage.append(el);
    }
    el.textContent = text;
    el.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => el.classList.remove('is-visible'), 3500);
}

// ---------- チャンネル切り替えと同期 ----------

function selectChannel(id: string, announce: boolean): void {
    if (!channels.some(c => c.id === id)) return;
    const changed = id !== current;
    current = id;
    store.set('channel', id);
    if (changed) player.load(streamUrl(id));
    renderChannels();
    renderNow();
    if (announce && syncInput.checked && ws?.readyState === WebSocket.OPEN && room?.channel !== id) {
        ws.send(JSON.stringify({ type: 'select', channel: id }));
    }
    if (window.matchMedia('(max-width: 760px)').matches) sidebar.classList.remove('is-open');
}

function chooseInitialChannel(): void {
    if (initialChosen || channels.length === 0) return;
    initialChosen = true;
    if (room?.channel && channels.some(c => c.id === room!.channel)) {
        selectChannel(room.channel, false);
        return;
    }
    const stored = store.get('channel');
    const first = channels.find(c => c.id === stored) ?? channels[0];
    // まだ誰も選んでいなければ、自分の選局をみんなの基準にする
    selectChannel(first.id, true);
}

function onRoomState(next: RoomState): void {
    const previous = room;
    room = next;
    renderMembers();
    if (!initialChosen) {
        chooseInitialChannel();
        return;
    }
    if (!syncInput.checked || !next.channel || next.channel === current) return;
    const name = channels.find(c => c.id === next.channel)?.name ?? next.channel;
    selectChannel(next.channel, false);
    if (previous && next.by) toast(`${next.by} さんが ${name} に切り替えました`);
}

function connectRoom(instance: string): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(
        `${proto}://${location.host}${BASE}/api/ws?instance=${encodeURIComponent(instance)}&t=${encodeURIComponent(session)}`,
    );
    ws = socket;
    socket.addEventListener('message', e => {
        try {
            const msg = JSON.parse(String(e.data)) as RoomState;
            if (msg.type === 'state') onRoomState(msg);
        } catch {
            // 壊れたメッセージは無視する
        }
    });
    socket.addEventListener('close', () => {
        if (ws === socket) ws = null;
        window.setTimeout(() => connectRoom(instance), 3000);
    });
}

// ---------- 操作 ----------

function setupControls(qualities: string[]): void {
    if (!qualities.includes(quality)) quality = '720p';
    qualitySelect.replaceChildren(
        ...qualities.map(q => {
            const o = document.createElement('option');
            o.value = q;
            o.textContent = q;
            o.selected = q === quality;
            return o;
        }),
    );
    qualitySelect.addEventListener('change', () => {
        quality = qualitySelect.value;
        store.set('quality', quality);
        if (current) player.load(streamUrl(current));
    });

    const savedVolume = Number(store.get('volume') ?? '1');
    video.volume = Number.isFinite(savedVolume) ? Math.min(1, Math.max(0, savedVolume)) : 1;
    renderVolume();
    volumeInput.addEventListener('input', () => {
        video.volume = Number(volumeInput.value);
        video.muted = video.volume === 0;
        unmuteBtn.hidden = true;
        store.set('volume', String(video.volume));
        renderVolume();
    });
    muteBtn.addEventListener('click', () => {
        video.muted = !video.muted;
        if (!video.muted && video.volume === 0) video.volume = 0.5;
        unmuteBtn.hidden = true;
        renderVolume();
    });
    unmuteBtn.addEventListener('click', () => {
        video.muted = false;
        unmuteBtn.hidden = true;
        video.play().catch(() => {});
        renderVolume();
    });

    syncInput.checked = store.get('sync') !== '0';
    syncInput.addEventListener('change', () => {
        store.set('sync', syncInput.checked ? '1' : '0');
        if (syncInput.checked && room?.channel && room.channel !== current) selectChannel(room.channel, false);
    });

    toggleListBtn.addEventListener('click', () => {
        if (window.matchMedia('(max-width: 760px)').matches) sidebar.classList.toggle('is-open');
        else document.body.classList.toggle('list-hidden');
    });

    // 操作がないときはバーを隠して映像だけにする
    let idleTimer: number | undefined;
    const wake = () => {
        stage.classList.remove('is-idle');
        window.clearTimeout(idleTimer);
        idleTimer = window.setTimeout(() => {
            if (!video.paused && statusBox.hidden) stage.classList.add('is-idle');
        }, 3500);
    };
    for (const type of ['pointermove', 'pointerdown', 'keydown'] as const) stage.addEventListener(type, wake);
    wake();
}

async function refreshChannels(): Promise<string[]> {
    const data = await api<{ channels: Channel[]; qualities: string[] }>('/api/channels');
    channels = data.channels;
    renderChannels();
    renderNow();
    return data.qualities;
}

// ---------- 起動 ----------

async function boot(): Promise<void> {
    const config = (await (await fetch(`${BASE}/api/config`)).json()) as {
        clientId: string;
        scopes: string[];
        dev: boolean;
    };

    let code: string | undefined;
    let sdk: DiscordSDK | null = null;
    let instance = 'local';

    if (IN_DISCORD) {
        sdk = new DiscordSDK(config.clientId);
        await sdk.ready();
        setStatus('Discord で認証しています…');
        const result = await sdk.commands.authorize({
            client_id: config.clientId,
            response_type: 'code',
            state: '',
            prompt: 'none',
            scope: config.scopes as AuthorizeScopes['scope'],
        });
        code = result.code;
        instance = sdk.instanceId;
    } else if (!config.dev) {
        setStatus('Discord のアクティビティとして開いてください', false);
        return;
    }

    const tokenResponse = await fetch(`${BASE}/api/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
    });
    if (!tokenResponse.ok) {
        const err = (await tokenResponse.json().catch(() => ({}))) as { message?: string };
        setStatus(err.message ?? `認証に失敗しました (${tokenResponse.status})`, false);
        return;
    }
    const auth = (await tokenResponse.json()) as { access_token: string | null; session: string };
    session = auth.session;
    if (sdk && auth.access_token) await sdk.commands.authenticate({ access_token: auth.access_token });

    setStatus('チャンネルを取得しています…');
    const qualities = await refreshChannels();
    setupControls(qualities);
    if (channels.length === 0) {
        setStatus('視聴できるチャンネルがありません', false);
        return;
    }
    setStatus('チャンネルを選んでいます…');

    connectRoom(instance);
    // 同期サーバーにつながらなくても 2 秒後には見始める
    window.setTimeout(chooseInitialChannel, 2000);
    window.setInterval(() => void refreshChannels().catch(() => {}), 30000);
}

boot().catch((err: unknown) => {
    console.error(err);
    setStatus(`起動に失敗しました: ${err instanceof Error ? err.message : String(err)}`, false);
});
