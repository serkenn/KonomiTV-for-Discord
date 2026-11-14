/**
 * 録画の配信元。
 * file: 保存済みの mp4 / webm。ブラウザがそのままシークできる。
 * transcode: サーバーがその場で mp4 / webm に変換して流す。シークは開始位置を変えて取り直す。
 */
export type RecSource = { kind: 'file'; url: string } | { kind: 'transcode'; url: (startSecond: number) => string };

/** 録画を <video> で再生する。配信元の違いを隠して「位置」と「シーク」をそろえる */
export class RecordedPlayer {
    private source: RecSource | null = null;
    /** transcode のとき、いま流しているストリームが番組の何秒目から始まっているか */
    private base = 0;
    /** file のとき、読み込みが終わったら移動する位置 */
    private pendingStart: number | null = null;
    private fallbackDuration = 0;

    constructor(private readonly video: HTMLVideoElement) {
        // 読み込みごとにリスナーを足すと、前の読み込みのぶんが次の動画で発火してしまうので 1 つだけ置く
        video.addEventListener('loadedmetadata', () => {
            const start = this.pendingStart;
            this.pendingStart = null;
            if (start !== null && this.source?.kind === 'file') this.video.currentTime = start;
        });
    }

    get active(): boolean {
        return this.source !== null;
    }

    /** 番組の先頭からの再生位置 (秒) */
    get position(): number {
        if (this.pendingStart !== null) return this.pendingStart;
        return this.base + this.video.currentTime;
    }

    /** 番組の長さ (秒) */
    get duration(): number {
        const own = this.video.duration;
        if (this.source?.kind === 'file' && Number.isFinite(own) && own > 0) return own;
        return this.fallbackDuration;
    }

    /** @param fallbackDuration 動画から長さが分からないとき (変換配信など) に使う番組の長さ */
    load(source: RecSource, fallbackDuration: number, position: number): void {
        this.source = source;
        this.fallbackDuration = fallbackDuration;
        this.open(position);
    }

    /** 変換配信で使う番組の長さを、あとから分かった正確な値に差し替える */
    setDuration(seconds: number): void {
        if (seconds > 0) this.fallbackDuration = seconds;
    }

    seek(position: number): void {
        const source = this.source;
        if (!source) return;
        const total = this.duration;
        const target = Math.max(0, total > 1 ? Math.min(position, total - 1) : position);
        if (source.kind === 'file') {
            // 読み込み前なら、読み込み後に移動する位置を差し替える
            if (this.video.readyState === HTMLMediaElement.HAVE_NOTHING) this.pendingStart = target;
            else this.video.currentTime = target;
            return;
        }
        const wasPlaying = !this.video.paused;
        this.open(target);
        if (wasPlaying) this.video.play().catch(() => {});
    }

    stop(): void {
        if (!this.source) return;
        this.source = null;
        this.base = 0;
        this.pendingStart = null;
        this.video.pause();
        this.video.removeAttribute('src');
        this.video.load();
    }

    private open(position: number): void {
        const source = this.source;
        if (!source) return;
        if (source.kind === 'file') {
            this.base = 0;
            this.pendingStart = position > 0 ? position : null;
            this.video.src = source.url;
        } else {
            this.base = Math.floor(position);
            this.pendingStart = null;
            this.video.src = source.url(this.base);
        }
        this.video.load();
    }
}
