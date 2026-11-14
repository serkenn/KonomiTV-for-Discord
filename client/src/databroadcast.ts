import { BMLBrowser } from 'web-bml';

/** ARIB のリモコンキー番号 (web-bml の AribKeyCode と同じ値) */
export const Key = {
    Up: 1,
    Down: 2,
    Left: 3,
    Right: 4,
    Digit0: 5,
    Enter: 18,
    Back: 19,
    Data: 20,
    Blue: 21,
    Red: 22,
    Green: 23,
    Yellow: 24,
} as const;

export type DataStatus = 'off' | 'loading' | 'ready' | 'unavailable' | 'error';

type BrowserMessage = Parameters<BMLBrowser['emitMessage']>[0];
type WorkerMessage = BrowserMessage | { type: 'x-ended'; error?: string };

/**
 * データ放送 (d ボタン)。web-bml の BML ブラウザを映像の上に重ね、
 * データ放送が画面を出しているあいだは映像をその中の小窓に移す。
 */
export class DataBroadcast {
    private browser: BMLBrowser | null = null;
    private worker: Worker | null = null;
    private container: HTMLDivElement | null = null;
    private width = 960;
    private height = 540;
    private videoInside = false;
    private readonly resizeObserver: ResizeObserver;

    onStatus: (status: DataStatus) => void = () => {};
    onError: (text: string) => void = () => {};
    /** データ放送の画面を出したとき (true) と消したとき (false) */
    onVisibleChange: (visible: boolean) => void = () => {};

    constructor(
        private readonly stage: HTMLElement,
        private readonly video: HTMLVideoElement,
        private readonly fontBase: string,
    ) {
        this.resizeObserver = new ResizeObserver(() => this.rescale());
        this.resizeObserver.observe(stage);
    }

    get running(): boolean {
        return this.browser !== null;
    }

    start(dataUrl: string, serviceId: number): void {
        this.stop();
        this.onStatus('loading');

        const container = document.createElement('div');
        container.className = 'bml';
        container.hidden = true;
        this.stage.prepend(container);
        this.container = container;

        const browser = new BMLBrowser({
            // 映像の要素は、データ放送が表示されたときに自分で中へ移す
            mediaElement: document.createElement('p'),
            containerElement: container,
            storagePrefix: 'ktvd-bml_',
            nvramPrefix: 'nvram_',
            broadcasterDatabasePrefix: '',
            videoPlaneModeEnabled: true,
            fonts: {
                roundGothic: { source: `url("${this.fontBase}KosugiMaru-Regular.woff2"), local("sans-serif")` },
                squareGothic: { source: `url("${this.fontBase}Kosugi-Regular.woff2"), local("sans-serif")` },
            },
            showErrorMessage: (title, message, code) => this.onError(`${title} ${message}${code ? ` (${code})` : ''}`),
        });
        this.browser = browser;

        browser.addEventListener('load', event => {
            if (this.browser !== browser) return;
            this.width = event.detail.resolution.width;
            this.height = event.detail.resolution.height;
            container.style.width = `${this.width}px`;
            container.style.height = `${this.height}px`;
            container.hidden = false;
            this.rescale();
            this.moveVideoIn();
            this.onVisibleChange(true);
            this.onStatus('ready');
        });
        browser.addEventListener('invisible', event => {
            if (this.browser !== browser) return;
            if (event.detail) {
                this.moveVideoOut();
                container.hidden = true;
                this.onVisibleChange(false);
            } else {
                container.hidden = false;
                this.moveVideoIn();
                this.onVisibleChange(true);
            }
        });

        const worker = new Worker(new URL('./psi-worker.ts', import.meta.url), { type: 'module' });
        this.worker = worker;
        worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
            if (this.browser !== browser) return;
            const message = event.data;
            if (message.type === 'x-ended') {
                if (message.error) this.onStatus('error');
                return;
            }
            if (message.type === 'pmt') {
                // データ放送を持たないチャンネルでは、いくら待っても何も出ない
                const available = message.components.some(c => c.bxmlInfo !== undefined);
                if (!available) this.onStatus('unavailable');
            }
            try {
                browser.emitMessage(message);
            } catch (err) {
                console.error('[databroadcast]', err);
            }
        };
        worker.onerror = () => {
            if (this.browser === browser) this.onStatus('error');
        };
        worker.postMessage({ url: dataUrl, serviceId });
    }

    stop(): void {
        this.worker?.terminate();
        this.worker = null;
        const browser = this.browser;
        this.browser = null;
        if (browser) {
            // 映像を外へ戻してから破棄しないと、映像の要素ごと消えてしまう
            this.moveVideoOut();
            try {
                browser.destroy();
            } catch (err) {
                console.error('[databroadcast]', err);
            }
        }
        this.container?.remove();
        this.container = null;
        this.onVisibleChange(false);
        this.onStatus('off');
    }

    /** リモコンのキーを 1 回押す */
    press(key: number): void {
        const content = this.browser?.content;
        if (!content) return;
        try {
            content.processKeyDown(key);
            content.processKeyUp(key);
        } catch (err) {
            console.error('[databroadcast]', err);
        }
    }

    private rescale(): void {
        if (!this.container) return;
        // 720x480 のデータ放送も 16:9 に引き伸ばして表示する
        const wide = (this.height * 16) / 9;
        const scale = Math.min(this.stage.clientWidth / wide, this.stage.clientHeight / this.height);
        this.container.style.transform = `translate(-50%, -50%) scale(${scale * (wide / this.width)}, ${scale})`;
    }

    private moveVideoIn(): void {
        const slot = this.browser?.getVideoElement();
        if (!slot) return;
        if (slot.firstElementChild instanceof HTMLParagraphElement) slot.firstElementChild.remove();
        const wasPlaying = !this.video.paused;
        slot.append(this.video);
        // データ放送の中は Shadow DOM なので、ページのスタイルが届かない
        Object.assign(this.video.style, { width: '100%', height: '100%', display: 'block', objectFit: 'fill' });
        this.videoInside = true;
        if (wasPlaying && this.video.paused) this.video.play().catch(() => {});
    }

    private moveVideoOut(): void {
        if (!this.videoInside) return;
        const wasPlaying = !this.video.paused;
        this.stage.prepend(this.video);
        Object.assign(this.video.style, { width: '', height: '', display: '', objectFit: '' });
        this.videoInside = false;
        if (wasPlaying && this.video.paused) this.video.play().catch(() => {});
    }
}
