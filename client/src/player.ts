import mpegts from 'mpegts.js';

export type PlayerState = 'loading' | 'playing' | 'reconnecting' | 'unsupported';

/**
 * KonomiTV のライブ MPEG-TS を mpegts.js で再生する。
 * ストリームが切れたり止まったりしたら自動でつなぎ直す。
 */
export class LivePlayer {
    private player: mpegts.Player | null = null;
    private url: string | null = null;
    private retryCount = 0;
    private retryTimer: number | undefined;
    private lastTime = 0;
    private lastProgressAt = 0;

    /** 自動再生がブロックされ、ミュートして再生を始めたときに呼ばれる */
    onAutoplayMuted: () => void = () => {};
    /** 新しいストリームを読み込み始めたとき (映像の時刻の基準が変わる) */
    onStreamStart: () => void = () => {};
    /** 字幕・文字スーパーのデータ (ID3) が届いたとき。pts は映像の時刻 (秒) */
    onTimedID3: (pts: number, data: Uint8Array) => void = () => {};

    constructor(
        private readonly video: HTMLVideoElement,
        private readonly onState: (state: PlayerState) => void,
    ) {
        mpegts.LoggingControl.enableVerbose = false;
        mpegts.LoggingControl.enableDebug = false;
        mpegts.LoggingControl.enableInfo = false;

        video.addEventListener('playing', () => {
            this.retryCount = 0;
            this.onState('playing');
        });
        video.addEventListener('waiting', () => {
            if (this.url) this.onState('loading');
        });

        // 映像が 15 秒進まなければ固まったとみなしてつなぎ直す
        window.setInterval(() => {
            if (!this.player || this.video.paused) return;
            const now = performance.now();
            if (this.video.currentTime !== this.lastTime) {
                this.lastTime = this.video.currentTime;
                this.lastProgressAt = now;
            } else if (now - this.lastProgressAt > 15000) {
                this.scheduleRetry(0);
            }
        }, 3000);
    }

    /** 受け取ってまだ映していない分の長さ (秒)。実況コメントをこの分だけ遅らせて映像に合わせる */
    get latency(): number {
        const buffered = this.video.buffered;
        if (buffered.length === 0) return 0;
        return Math.max(0, buffered.end(buffered.length - 1) - this.video.currentTime);
    }

    static get supported(): boolean {
        return mpegts.getFeatureList().mseLivePlayback;
    }

    load(url: string): void {
        this.url = url;
        this.retryCount = 0;
        this.start();
    }

    stop(): void {
        this.url = null;
        this.destroy();
    }

    private start(): void {
        this.destroy();
        if (!this.url) return;
        if (!LivePlayer.supported) {
            this.onState('unsupported');
            return;
        }
        this.onState(this.retryCount > 0 ? 'reconnecting' : 'loading');
        this.lastProgressAt = performance.now();
        this.lastTime = 0;

        const player = mpegts.createPlayer(
            { type: 'mpegts', isLive: true, url: this.url },
            {
                enableWorker: true,
                enableStashBuffer: true,
                stashInitialSize: 1024 * 1024,
                // 遅延が溜まったら少しだけ早送りして追いつく
                liveSync: true,
                liveSyncMaxLatency: 6,
                liveSyncTargetLatency: 3,
                liveSyncPlaybackRate: 1.1,
            },
        );
        this.player = player;
        player.attachMediaElement(this.video);
        this.onStreamStart();
        player.on(mpegts.Events.TIMED_ID3_METADATA_ARRIVED, (meta: { pts?: number; data?: Uint8Array }) => {
            if (this.player === player && meta.pts !== undefined && meta.data) this.onTimedID3(meta.pts / 1000, meta.data);
        });
        player.on(mpegts.Events.ERROR, () => {
            if (this.player === player) this.scheduleRetry();
        });
        // ライブなのに読み込みが終わった = サーバー側でストリームが閉じられた
        player.on(mpegts.Events.LOADING_COMPLETE, () => {
            if (this.player === player) this.scheduleRetry();
        });
        player.load();
        this.play();
    }

    private play(): void {
        const result = this.video.play();
        if (!result) return;
        result.catch((err: unknown) => {
            if (err instanceof DOMException && err.name === 'NotAllowedError' && !this.video.muted) {
                this.video.muted = true;
                this.onAutoplayMuted();
                this.video.play().catch(() => {});
            }
        });
    }

    private scheduleRetry(delay?: number): void {
        if (!this.url || this.retryTimer !== undefined) return;
        this.destroy();
        this.onState('reconnecting');
        const wait = delay ?? Math.min(1000 * 2 ** this.retryCount, 15000);
        this.retryCount++;
        this.retryTimer = window.setTimeout(() => {
            this.retryTimer = undefined;
            this.start();
        }, wait);
    }

    private destroy(): void {
        if (this.retryTimer !== undefined) {
            window.clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
        }
        const player = this.player;
        this.player = null;
        if (!player) return;
        try {
            player.pause();
            player.unload();
            player.detachMediaElement();
            player.destroy();
        } catch {
            // 破棄中の例外は無視してよい
        }
    }
}
