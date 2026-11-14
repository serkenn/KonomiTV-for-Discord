export type CommentType = 'right' | 'top' | 'bottom';
export type CommentSize = 'big' | 'medium' | 'small';

export interface CommentItem {
    text: string;
    /** right: 右から左へ流れる / top: 上に止まる / bottom: 下に止まる */
    type: CommentType;
    size: CommentSize;
    color: string;
}

/** 流れるコメントが画面を横切る時間 */
const SCROLL_MS = 5000;
/** 上下に止まるコメントを出しておく時間 */
const FIXED_MS = 4000;
/** 一度に出しておくコメントの上限 (多すぎると重くなる) */
const MAX_ON_SCREEN = 150;
/** 同じ行で前後のコメントのあいだに空ける幅 (px) */
const GAP = 24;
const SIZE_SCALE: Record<CommentSize, number> = { big: 1.4, medium: 1, small: 0.7 };
const DEFAULT_COLOR = '#FFEAEA';

/** 受け取った値を、表示できるコメントにそろえる。知らない値は既定値にする */
export function makeComment(text: unknown, type: unknown, size: unknown, color: unknown): CommentItem | null {
    if (typeof text !== 'string' || text.trim() === '') return null;
    return {
        text,
        type: type === 'top' || type === 'bottom' ? type : 'right',
        size: size === 'big' || size === 'small' ? size : 'medium',
        color: typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_COLOR,
    };
}

interface Active {
    el: HTMLDivElement;
    anim: Animation;
    type: CommentType;
    top: number;
    width: number;
    height: number;
    /** 流し始めたときの画面の幅 */
    stageWidth: number;
}

const overlaps = (aTop: number, aHeight: number, bTop: number, bHeight: number) =>
    aTop < bTop + bHeight && bTop < aTop + aHeight;

/** 映像の上にコメントを流す (ニコニコ風)。空いている行がなければ、重ねずに捨てる */
export class CommentLayer {
    private active: Active[] = [];
    private paused = false;

    constructor(private readonly layer: HTMLElement) {}

    add(comment: CommentItem): void {
        const stageWidth = this.layer.clientWidth;
        const stageHeight = this.layer.clientHeight;
        if (stageWidth === 0 || stageHeight === 0 || this.active.length >= MAX_ON_SCREEN) return;

        // 映像の高さに合わせた文字の大きさ (ニコニコと同じく、ふつうの大きさのコメントが 15 行ほど入る)
        const base = Math.min(42, Math.max(14, stageHeight / 15));
        const el = document.createElement('div');
        el.className = 'cm';
        el.textContent = comment.text;
        el.style.fontSize = `${Math.round(base * SIZE_SCALE[comment.size])}px`;
        el.style.color = comment.color;
        el.style.visibility = 'hidden';
        this.layer.append(el);
        const width = el.offsetWidth;
        const height = el.offsetHeight;

        const top =
            comment.type === 'right'
                ? this.findScrollTop(width, height, stageWidth, stageHeight)
                : this.findFixedTop(comment.type, height, stageHeight);
        if (top === null) {
            el.remove();
            return;
        }

        el.style.top = `${top}px`;
        el.style.visibility = '';
        let anim: Animation;
        if (comment.type === 'right') {
            anim = el.animate([{ transform: `translateX(${stageWidth}px)` }, { transform: `translateX(${-width}px)` }], {
                duration: SCROLL_MS,
                easing: 'linear',
            });
        } else {
            el.style.left = `${Math.max(0, (stageWidth - width) / 2)}px`;
            anim = el.animate([{ opacity: 1 }, { opacity: 1 }], { duration: FIXED_MS });
        }
        const item: Active = { el, anim, type: comment.type, top, width, height, stageWidth };
        this.active.push(item);
        if (this.paused) anim.pause();
        anim.onfinish = () => this.remove(item);
    }

    /** 映像が止まっているあいだはコメントも止める */
    setPaused(paused: boolean): void {
        this.paused = paused;
        for (const a of this.active) {
            if (paused) a.anim.pause();
            else a.anim.play();
        }
    }

    clear(): void {
        for (const a of this.active.splice(0)) {
            a.anim.onfinish = null;
            a.anim.cancel();
            a.el.remove();
        }
    }

    private remove(item: Active): void {
        const i = this.active.indexOf(item);
        if (i >= 0) this.active.splice(i, 1);
        item.el.remove();
    }

    /** 流れるコメントを置く高さ。上から順に、前のコメントに追いつかない行を探す */
    private findScrollTop(width: number, height: number, stageWidth: number, stageHeight: number): number | null {
        const speed = (stageWidth + width) / SCROLL_MS;
        let top = 0;
        while (top + height <= stageHeight) {
            const blocker = this.active.find(
                a => a.type === 'right' && overlaps(a.top, a.height, top, height) && this.collides(a, speed, stageWidth),
            );
            if (!blocker) return top;
            top = blocker.top + blocker.height;
        }
        return null;
    }

    /** a と同じ行に、速さ speed (px/ms) のコメントを今から流すとぶつかるか */
    private collides(a: Active, speed: number, stageWidth: number): boolean {
        const elapsed = Number(a.anim.currentTime ?? 0);
        const aSpeed = (a.stageWidth + a.width) / SCROLL_MS;
        // a の右端がまだ画面に入りきっていない
        const tail = a.stageWidth - aSpeed * elapsed + a.width;
        if (tail + GAP > stageWidth) return true;
        // a が左へ抜けきる前に、新しいコメントが追いつく
        return stageWidth - speed * (SCROLL_MS - elapsed) < GAP;
    }

    /** 上 (下) に止まるコメントを置く高さ。上 (下) から順に空いている所を探す */
    private findFixedTop(type: 'top' | 'bottom', height: number, stageHeight: number): number | null {
        const fixed = this.active.filter(a => a.type === type);
        if (type === 'top') {
            let top = 0;
            while (top + height <= stageHeight) {
                const blocker = fixed.find(a => overlaps(a.top, a.height, top, height));
                if (!blocker) return top;
                top = blocker.top + blocker.height;
            }
        } else {
            let top = stageHeight - height;
            while (top >= 0) {
                const blocker = fixed.find(a => overlaps(a.top, a.height, top, height));
                if (!blocker) return top;
                top = blocker.top - height;
            }
        }
        return null;
    }
}
