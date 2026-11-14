import { CanvasRenderer, type CanvasRendererOption } from 'aribb24.js';

const FONT_FAMILY = 'KTVD Maru';

/**
 * 字幕と文字スーパー (aribb24.js)。
 * 字幕は表示/非表示を切り替えられる。文字スーパー (地震速報などの割り込みの文字) は常に出す。
 */
export class Captions {
    private readonly caption: CanvasRenderer;
    private readonly superimpose: CanvasRenderer;
    private visible = false;
    private attached = false;
    private fontRequested = false;

    constructor(
        private readonly video: HTMLVideoElement,
        private readonly layer: HTMLElement,
        private readonly fontUrl: string,
    ) {
        const option: CanvasRendererOption = {
            normalFont: `"${FONT_FAMILY}", "Hiragino Maru Gothic ProN", "BIZ UDGothic", sans-serif`,
            // 外字 (DRCS) は、対応する Unicode の文字に置き換えて描く
            drcsReplacement: true,
            keepAspectRatio: true,
            useStroke: true,
            // mpegts.js から受け取ったデータを自分で渡すので、ブラウザ内蔵の HLS 向けの自動検出は使わない
            enableAutoInBandMetadataTextTrackDetection: false,
        };
        this.caption = new CanvasRenderer({ ...option, data_identifier: 0x80 });
        this.superimpose = new CanvasRenderer({ ...option, data_identifier: 0x81 });
    }

    /** 新しいライブ映像を読み込むたびに呼ぶ。映像の時刻の基準が変わるので、前の映像の字幕を捨ててつなぎ直す */
    reset(): void {
        // attachMedia は、つなぎ直す前に古い字幕を消してくれる
        this.caption.attachMedia(this.video, this.layer);
        this.superimpose.attachMedia(this.video, this.layer);
        this.attached = true;
        this.loadFont();
        this.superimpose.show();
        this.applyVisibility();
    }

    /** 録画を見るあいだなど、字幕を使わないときは外しておく */
    detach(): void {
        if (!this.attached) return;
        this.caption.detachMedia();
        this.superimpose.detachMedia();
        this.attached = false;
    }

    /** @param pts 映像の時刻 (秒) */
    push(pts: number, data: Uint8Array): void {
        if (!this.attached) return;
        this.caption.pushID3v2Data(pts, data);
        this.superimpose.pushID3v2Data(pts, data);
    }

    setVisible(visible: boolean): void {
        this.visible = visible;
        this.applyVisibility();
    }

    private applyVisibility(): void {
        if (this.visible) this.caption.show();
        else this.caption.hide();
    }

    /** データ放送と同じ丸ゴシックを読み込み、読み込めたら描き直す */
    private loadFont(): void {
        if (this.fontRequested) return;
        this.fontRequested = true;
        const face = new FontFace(FONT_FAMILY, `url("${this.fontUrl}")`);
        document.fonts.add(face);
        face.load()
            .then(() => {
                this.caption.refresh();
                this.superimpose.refresh();
            })
            .catch(() => {
                // 読み込めなくても、ほかのフォントで描ける
            });
    }
}
