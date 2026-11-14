import { DiscordSDK } from '@discord/embedded-app-sdk';
import { DataBroadcast, Key, type DataStatus } from './databroadcast';
import { LivePlayer, type PlayerState } from './player';
import { RecordedPlayer, type RecSource } from './recorded';
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
    service_id: number;
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
interface RecFile {
    id: number;
    type: string;
    name: string;
    size: number;
    /** 保存済みの mp4 / webm で、変換なしにそのまま再生できる */
    direct: boolean;
    ext: 'mp4' | 'webm' | null;
}
interface RecordItem {
    id: number;
    name: string;
    description: string;
    start: number;
    end: number;
    channel: string;
    recording: boolean;
    thumbnail: number | null;
    files: RecFile[];
}
/** その場で変換するときに選べる画質の名前。添字がそのまま画質の番号になる */
type RecModes = Partial<Record<'ts' | 'encoded', Partial<Record<'mp4' | 'webm', string[]>>>>;
/** みんなで見ている録画。配信形式は各自で選ぶので含めない */
interface RecState {
    recordedId: number;
    pos: number;
    playing: boolean;
}
/** applyRemoteRec の結果。superseded は、待っているあいだにもっと新しい切り替えがあったこと */
type ApplyResult = 'applied' | 'failed' | 'superseded';
interface RoomState {
    type: 'state';
    channel: string | null;
    rec: RecState | null;
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
const toggleRemoteBtn = $<HTMLButtonElement>('toggle-remote');
const remoteBox = $('remote');
const remoteStatus = $('remote-status');
const remoteDigits = $('remote-digits');
const playBtn = $<HTMLButtonElement>('play');
const seekInput = $<HTMLInputElement>('seek');
const timeLabel = $('time');
const sourceSelect = $<HTMLSelectElement>('source');
const sideTitle = $('side-title');
const tabsBox = $('tabs');
const tabLive = $<HTMLButtonElement>('tab-live');
const tabRec = $<HTMLButtonElement>('tab-rec');
const recordedBox = $('recorded-box');
const recordedList = $('recorded');
const recSearch = $<HTMLInputElement>('rec-search');

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
let remoteOn = store.get('remote') === '1';
/** いま再生しているもの: 放送中か録画か */
let mode: 'live' | 'rec' = 'live';
/** サイドバーで開いているタブ */
let tab: 'live' | 'rec' = 'live';
let records: RecordItem[] = [];
let recModes: RecModes = {};
let recordsLoaded = false;
let recordsTotal = 0;
/** 録画一覧の読み込みの通し番号。遅れて返ってきた古い結果を捨てるのに使う */
let recordsLoadSeq = 0;
/** 再生中の録画。value は「ファイルID:配信元」 */
let currentRec: { record: RecordItem; value: string } | null = null;
let seeking = false;
/** 選局・録画の切り替えの通し番号。遅れて終わった古い同期の指示を捨てるのに使う */
let syncSeq = 0;

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

const dataUrl = (id: string) =>
    `${location.origin}${BASE}/api/psi/${id}/${quality}?t=${encodeURIComponent(session)}`;

// ---------- データ放送 (d ボタン) ----------

const DATA_STATUS_TEXT: Record<DataStatus, string> = {
    off: '',
    loading: 'データ放送を読み込んでいます…',
    ready: 'd ボタンでデータ放送を表示できます',
    unavailable: 'このチャンネルにはデータ放送がありません',
    error: 'データ放送を取得できませんでした',
};

const data = new DataBroadcast(stage, video, new URL('./fonts/', document.baseURI).href);
data.onStatus = status => {
    remoteStatus.textContent = DATA_STATUS_TEXT[status];
    remoteBox.classList.toggle('is-disabled', status !== 'ready');
};
data.onError = text => toast(text);

/** いまのチャンネルと画質でデータ放送を始め直す (リモコンを閉じているときは止める) */
function restartData(): void {
    const ch = channels.find(c => c.id === current);
    if (remoteOn && ch && mode === 'live') data.start(dataUrl(ch.id), ch.service_id);
    else data.stop();
}

function renderRemote(): void {
    remoteBox.hidden = !remoteOn || tab !== 'live' || mode !== 'live';
    toggleRemoteBtn.setAttribute('aria-pressed', String(remoteOn));
    toggleRemoteBtn.classList.toggle('is-on', remoteOn);
}

// ---------- 録画 ----------

const recPlayer = new RecordedPlayer(video);

const two = (n: number) => String(n).padStart(2, '0');
function clock(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}
function dateLabel(ms: number): string {
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()}(${'日月火水木金土'[d.getDay()]}) ${d.getHours()}:${two(d.getMinutes())}`;
}

/** 再生を始める。自動再生が止められたらミュートで始めて、音声オンのボタンを出す */
function playVideo(): void {
    video.play().catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'NotAllowedError' && !video.muted) {
            video.muted = true;
            unmuteBtn.hidden = false;
            renderVolume();
            video.play().catch(() => {});
        }
    });
}

/** その録画で選べる配信元。保存済みの mp4 / webm を先に、その場での変換を後に並べる */
function recSources(record: RecordItem): { value: string; label: string }[] {
    const out: { value: string; label: string }[] = [];
    const direct = record.files.filter(f => f.direct).sort((a, b) => Number(a.ext !== 'mp4') - Number(b.ext !== 'mp4'));
    for (const f of direct) {
        // 同じ形式の保存済みファイルが複数あるときだけ、エンコード設定の名前を添えて見分ける
        const same = direct.filter(d => d.ext === f.ext).length > 1;
        out.push({ value: `${f.id}:file`, label: `${f.ext}・保存済み${same ? `（${f.name}）` : ''}` });
    }
    const base = record.files.find(f => f.type === 'ts') ?? record.files[0];
    if (base) {
        const names = recModes[base.type === 'ts' ? 'ts' : 'encoded'] ?? {};
        for (const format of ['mp4', 'webm'] as const) {
            (names[format] ?? []).forEach((name, index) => {
                out.push({ value: `${base.id}:${format}-${index}`, label: `${format} ${name}・変換` });
            });
        }
    }
    return out;
}

function recSource(value: string): RecSource {
    const [fileId, source] = value.split(':');
    const token = encodeURIComponent(session);
    if (source === 'file') return { kind: 'file', url: `${BASE}/api/recorded/file/${fileId}?t=${token}` };
    const [format, quality] = source.split('-');
    return {
        kind: 'transcode',
        url: start => `${BASE}/api/recorded/stream/${fileId}/${format}/${quality}?ss=${start}&t=${token}`,
    };
}

/** 録画一覧を読み込む。append なら続きを読み足す */
async function loadRecorded(append = false): Promise<void> {
    const seq = ++recordsLoadSeq;
    const offset = append ? records.length : 0;
    const query = new URLSearchParams({ offset: String(offset), keyword: recSearch.value.trim() });
    const result = await api<{ records: RecordItem[]; total: number; modes: RecModes }>(`/api/recorded?${query}`);
    if (seq !== recordsLoadSeq) return;
    const kept = append ? records : [];
    const known = new Set(kept.map(r => r.id));
    records = [...kept, ...result.records.filter(r => !known.has(r.id))];
    recordsTotal = result.total;
    recModes = result.modes ?? {};
    recordsLoaded = true;
    renderRecorded();
}

/** 一覧にない録画 (検索で絞り込み中や、まだ読み込んでいない続きにあるもの) を 1 件だけ取る */
async function fetchRecord(id: number): Promise<RecordItem | null> {
    try {
        const result = await api<{ record: RecordItem; modes: RecModes }>(`/api/recorded/item/${id}`);
        recModes = result.modes ?? recModes;
        return result.record;
    } catch {
        return null;
    }
}

function renderRecorded(): void {
    if (records.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'channels__empty';
        empty.textContent = recordsLoaded ? '録画がありません' : '読み込んでいます…';
        recordedList.replaceChildren(empty);
        return;
    }
    const items = records.map(record => {
        const li = document.createElement('li');
        li.className = 'channel' + (currentRec?.record.id === record.id ? ' is-active' : '');
        li.tabIndex = 0;
        li.setAttribute('role', 'button');

        if (record.thumbnail !== null) {
            const thumb = document.createElement('img');
            thumb.className = 'channel__thumb';
            thumb.src = `${BASE}/api/recorded/thumbnail/${record.thumbnail}?t=${encodeURIComponent(session)}`;
            thumb.alt = '';
            thumb.loading = 'lazy';
            li.append(thumb);
        }

        const body = document.createElement('div');
        body.className = 'channel__body';
        const title = document.createElement('div');
        title.className = 'channel__title channel__title--strong';
        title.textContent = record.name;
        const meta = document.createElement('div');
        meta.className = 'channel__time';
        const minutes = Math.round((record.end - record.start) / 60000);
        meta.textContent = [dateLabel(record.start), `${minutes}分`, record.channel].filter(Boolean).join('・');
        const badges = document.createElement('div');
        badges.className = 'badges';
        const labels = new Set<string>();
        if (record.recording) labels.add('録画中');
        for (const f of record.files) labels.add(f.direct && f.ext ? f.ext : f.type === 'ts' ? 'TS' : f.name);
        for (const label of labels) {
            const badge = document.createElement('span');
            badge.className = 'badge' + (label === '録画中' ? ' badge--live' : '');
            badge.textContent = label;
            badges.append(badge);
        }
        body.append(title, meta, badges);
        li.append(body);

        const choose = () => {
            const first = recSources(record)[0];
            if (!first) toast('この録画には再生できるファイルがありません');
            else playRecorded(record, first.value, 0, true, true);
        };
        li.addEventListener('click', choose);
        li.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                choose();
            }
        });
        return li;
    });

    if (records.length < recordsTotal) {
        const li = document.createElement('li');
        const more = document.createElement('button');
        more.className = 'more';
        more.textContent = `さらに表示（残り ${recordsTotal - records.length} 件）`;
        more.addEventListener('click', () => {
            more.disabled = true;
            loadRecorded(true).catch(() => {
                more.disabled = false;
                toast('録画一覧を取得できませんでした');
            });
        });
        li.append(more);
        items.push(li);
    }
    recordedList.replaceChildren(...items);
}

/** 放送中と録画で、操作バーに出すものを切り替える */
function renderMode(): void {
    const rec = mode === 'rec';
    playBtn.hidden = seekInput.hidden = timeLabel.hidden = sourceSelect.hidden = !rec;
    qualitySelect.hidden = toggleRemoteBtn.hidden = rec;
    renderRemote();
    if (!rec || !currentRec) return;
    const selected = currentRec.value;
    sourceSelect.replaceChildren(
        ...recSources(currentRec.record).map(s => {
            const o = document.createElement('option');
            o.value = s.value;
            o.textContent = s.label;
            o.selected = s.value === selected;
            return o;
        }),
    );
}

function renderProgress(): void {
    if (mode !== 'rec') return;
    const total = recPlayer.duration;
    playBtn.textContent = video.paused ? '▶' : '⏸';
    seekInput.max = String(Math.max(1, Math.floor(total)));
    if (!seeking) seekInput.value = String(Math.floor(recPlayer.position));
    timeLabel.textContent = `${clock(seeking ? Number(seekInput.value) : recPlayer.position)} / ${clock(total)}`;
}

/** 自分の再生状態 (どの録画の何秒目か、再生中か) をみんなに伝える */
function announceRec(playing = !video.paused): void {
    if (!currentRec || !syncInput.checked || ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'rec', recordedId: currentRec.record.id, pos: recPlayer.position, playing }));
}

function playRecorded(record: RecordItem, value: string, position: number, playing: boolean, announce: boolean): void {
    syncSeq++;
    mode = 'rec';
    player.stop();
    data.stop();
    current = null;
    currentRec = { record, value };
    setStatus(`${record.name} を読み込んでいます…`);
    recPlayer.load(recSource(value), (record.end - record.start) / 1000, position);
    if (playing) playVideo();
    if (!value.endsWith(':file')) {
        // その場で変換する配信は動画から長さが分からないので、サーバーに聞く
        api<{ duration: number }>(`/api/recorded/duration/${value.split(':')[0]}`)
            .then(d => {
                if (currentRec?.value !== value) return;
                recPlayer.setDuration(d.duration);
                renderProgress();
            })
            .catch(() => {});
    }
    renderMode();
    renderChannels();
    renderRecorded();
    renderNow();
    renderProgress();
    if (announce) announceRec(playing);
    if (window.matchMedia('(max-width: 760px)').matches) sidebar.classList.remove('is-open');
}

/** 録画をやめて放送中の表示に戻す (映像の読み込みは呼び出し側で行う) */
function leaveRecorded(): void {
    recPlayer.stop();
    currentRec = null;
    mode = 'live';
    renderMode();
    renderRecorded();
}

/**
 * みんなが見ている録画に合わせる。そろえるのは録画・位置・再生/一時停止で、配信形式 (mp4 / webm など) は各自のまま。
 */
async function applyRemoteRec(rec: RecState, by: string | null): Promise<ApplyResult> {
    const seq = ++syncSeq;
    if (mode === 'rec' && currentRec?.record.id === rec.recordedId) {
        // その場で変換する配信はシークすると取り直しになるので、ずれを大きめに許す
        const tolerance = currentRec.value.endsWith(':file') ? 3 : 8;
        if (Math.abs(recPlayer.position - rec.pos) > tolerance) recPlayer.seek(rec.pos);
        if (rec.playing && video.paused) playVideo();
        else if (!rec.playing && !video.paused) video.pause();
        return 'applied';
    }
    const record = records.find(r => r.id === rec.recordedId) ?? (await fetchRecord(rec.recordedId));
    // 待っているあいだに別のチャンネルや録画に切り替わっていたら、この指示は古い
    if (seq !== syncSeq) return 'superseded';
    const first = record ? recSources(record)[0] : undefined;
    if (!record || !first) return 'failed';
    playRecorded(record, first.value, rec.pos, rec.playing, false);
    if (by) toast(`${by} さんが「${record.name}」を再生しました`);
    return 'applied';
}

function showTab(next: 'live' | 'rec'): void {
    tab = next;
    tabLive.classList.toggle('is-active', next === 'live');
    tabRec.classList.toggle('is-active', next === 'rec');
    tabLive.setAttribute('aria-selected', String(next === 'live'));
    tabRec.setAttribute('aria-selected', String(next === 'rec'));
    channelList.hidden = next !== 'live';
    recordedBox.hidden = next !== 'rec';
    renderRemote();
    if (next === 'rec') {
        renderRecorded();
        loadRecorded().catch(() => toast('録画一覧を取得できませんでした'));
    }
}

function setupRecorded(): void {
    sideTitle.hidden = true;
    tabsBox.hidden = false;
    tabLive.addEventListener('click', () => showTab('live'));
    tabRec.addEventListener('click', () => showTab('rec'));
    const reload = () => loadRecorded().catch(() => toast('録画一覧を取得できませんでした'));
    recSearch.addEventListener('keydown', e => {
        if (e.key === 'Enter') reload();
    });
    // 検索欄を空にしたら全件に戻す
    recSearch.addEventListener('input', () => {
        if (recSearch.value === '') reload();
    });

    playBtn.addEventListener('click', () => {
        if (video.paused) playVideo();
        else video.pause();
        announceRec();
    });
    seekInput.addEventListener('input', () => {
        seeking = true;
        renderProgress();
    });
    seekInput.addEventListener('change', () => {
        seeking = false;
        recPlayer.seek(Number(seekInput.value));
        renderProgress();
        announceRec();
    });
    sourceSelect.addEventListener('change', () => {
        if (currentRec) playRecorded(currentRec.record, sourceSelect.value, recPlayer.position, !video.paused, true);
    });

    for (const type of ['timeupdate', 'play', 'pause', 'durationchange'] as const) {
        video.addEventListener(type, renderProgress);
    }
    video.addEventListener('waiting', () => {
        if (mode === 'rec') setStatus('読み込んでいます…');
    });
    // 一時停止のまま読み込んだときは playing が来ないので、再生できる状態になった時点で表示を消す
    video.addEventListener('canplay', () => {
        if (mode === 'rec') setStatus(null);
    });
    video.addEventListener('error', () => {
        if (mode === 'rec' && recPlayer.active) setStatus('この録画を再生できませんでした。配信形式を変えてみてください', false);
    });
    window.addEventListener('keydown', e => {
        if (mode !== 'rec' || e.key !== ' ' || (e.target as HTMLElement).closest('input, select, button, [role="button"]')) return;
        e.preventDefault();
        playBtn.click();
    });
}

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
    if (mode === 'rec' && currentRec) {
        const record = currentRec.record;
        nowLogo.hidden = true;
        nowChannel.textContent = `録画・${record.channel}`;
        nowTitle.textContent = `${record.name}（${dateLabel(record.start)}）`;
        return;
    }
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
    syncSeq++;
    const changed = id !== current || mode !== 'live';
    if (mode !== 'live') leaveRecorded();
    current = id;
    store.set('channel', id);
    if (changed) {
        player.load(streamUrl(id));
        restartData();
    }
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
    if (room?.rec) {
        // みんなが録画を見ていればそれに合わせる。合わせられなければ、みんなの状態は変えずに自分だけ放送を見る
        void applyRemoteRec(room.rec, null).then(result => {
            if (result === 'failed') chooseLiveChannel(false);
        });
        return;
    }
    chooseLiveChannel(true);
}

/** 最初に見る放送中のチャンネルを決める。announce なら、まだ誰も選んでいないときに自分の選局をみんなの基準にする */
function chooseLiveChannel(announce: boolean): void {
    if (room?.channel && channels.some(c => c.id === room!.channel)) {
        selectChannel(room.channel, false);
        return;
    }
    const stored = store.get('channel');
    const first = channels.find(c => c.id === stored) ?? channels[0];
    selectChannel(first.id, announce);
}

function onRoomState(next: RoomState): void {
    const previous = room;
    room = next;
    renderMembers();
    if (!initialChosen) {
        chooseInitialChannel();
        return;
    }
    if (!syncInput.checked) return;
    if (next.rec) {
        void applyRemoteRec(next.rec, previous ? next.by : null);
        return;
    }
    if (!next.channel || (next.channel === current && mode === 'live')) return;
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
        if (mode === 'live' && current) player.load(streamUrl(current));
        restartData();
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
        if (!syncInput.checked || !room) return;
        if (room.rec) void applyRemoteRec(room.rec, null);
        else if (room.channel && (room.channel !== current || mode !== 'live')) selectChannel(room.channel, false);
    });

    toggleListBtn.addEventListener('click', () => {
        if (window.matchMedia('(max-width: 760px)').matches) sidebar.classList.toggle('is-open');
        else document.body.classList.toggle('list-hidden');
    });

    // データ放送のリモコン
    remoteDigits.replaceChildren(
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(n => {
            const b = document.createElement('button');
            b.className = 'rk';
            b.textContent = String(n);
            // 10 は「0」としても使われる。11・12 はそのままのキー
            b.dataset.key = String(Key.Digit0 + n);
            return b;
        }),
    );
    remoteBox.addEventListener('click', e => {
        const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-key]');
        if (button) data.press(Number(button.dataset.key));
    });
    toggleRemoteBtn.addEventListener('click', () => {
        remoteOn = !remoteOn;
        store.set('remote', remoteOn ? '1' : '0');
        renderRemote();
        restartData();
        if (remoteOn) {
            document.body.classList.remove('list-hidden');
            if (window.matchMedia('(max-width: 760px)').matches) sidebar.classList.add('is-open');
        }
    });
    renderRemote();

    const KEYBOARD: Record<string, number> = {
        ArrowUp: Key.Up,
        ArrowDown: Key.Down,
        ArrowLeft: Key.Left,
        ArrowRight: Key.Right,
        Enter: Key.Enter,
        Backspace: Key.Back,
        d: Key.Data,
        b: Key.Blue,
        r: Key.Red,
        g: Key.Green,
        y: Key.Yellow,
    };
    window.addEventListener('keydown', e => {
        if (!data.running || e.ctrlKey || e.metaKey || e.altKey) return;
        const target = e.target as HTMLElement;
        if (target.closest('input, select, textarea, button, [role="button"]')) return;
        const name = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        const key = /^[0-9]$/.test(name) ? Key.Digit0 + Number(name) : KEYBOARD[name];
        if (key === undefined) return;
        e.preventDefault();
        data.press(key);
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
    // 再生が始まった時点から数え直す (読み込み中に時間切れになると隠れないままになる)
    video.addEventListener('playing', wake);
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
        recorded: boolean;
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
    if (config.recorded) setupRecorded();
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
