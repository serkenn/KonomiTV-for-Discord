/// <reference lib="webworker" />
// データ放送 (d ボタン) の元データを取得して解読する Web Worker。
// KonomiTV の「PSI/SI アーカイブデータ」を TS パケットに戻し、web-bml のデコーダーに流す。
// 展開処理は KonomiTV 公式クライアント (元は EDCB Legacy WebUI) の実装を移植したもの。
import { decodeTS } from 'web-bml/ts';

interface Context {
    pids: number[];
    dict: (Uint8Array | null)[];
    position: number;
    trailerSize: number;
    timeListCount: number;
    codeListPosition: number;
    codeCount: number;
    initTime: number;
    currTime: number;
}

const context: Context = {
    pids: [],
    dict: [],
    position: 0,
    trailerSize: 0,
    timeListCount: -1,
    codeListPosition: 0,
    codeCount: 0,
    initTime: -1,
    currTime: -1,
};
const packetCounters: Record<number, number> = {};

/** ヘッダのない TS パケット列に、PID と連続性カウンタ入りのヘッダを書き込む */
function setTSPacketHeader(packets: Uint8Array, pid: number): void {
    let counter = packetCounters[pid] ?? 0;
    for (let i = 0; i < packets.length; i += 188) {
        packets[i] = 0x47;
        packets[i + 1] = (i > 0 ? 0 : 0x40) | (pid >> 8);
        packets[i + 2] = pid;
        packets[i + 3] = 0x10 | counter;
        counter = (counter + 1) & 0xf;
    }
    packetCounters[pid] = counter;
}

/**
 * 受信済みのアーカイブデータを読めるところまで読み、TS パケットをコールバックに渡す。
 * 読み残した分を返す (形式が壊れていたら null)。
 */
function readChunk(
    buffer: ArrayBuffer,
    callback: (second: number, packets: Uint8Array, pid: number) => void,
): ArrayBuffer | null {
    const data = new DataView(buffer);
    const ctx = context;

    while (data.byteLength - ctx.position >= ctx.trailerSize + 32) {
        let position = ctx.position + ctx.trailerSize;
        const timeListLen = data.getUint16(position + 10, true);
        const dictionaryLen = data.getUint16(position + 12, true);
        const dictionaryWindowLen = data.getUint16(position + 14, true);
        const dictionaryDataSize = data.getUint32(position + 16, true);
        const dictionaryBufferSize = data.getUint32(position + 20, true);
        const codeListLen = data.getUint32(position + 24, true);

        if (
            data.getUint32(position) !== 0x50737363 ||
            data.getUint32(position + 4) !== 0x0d0a9a0a ||
            dictionaryWindowLen < dictionaryLen ||
            dictionaryBufferSize < dictionaryDataSize ||
            dictionaryWindowLen > 65536 - 4096
        ) {
            return null;
        }

        const chunkSize =
            32 + timeListLen * 4 + dictionaryLen * 2 + Math.ceil(dictionaryDataSize / 2) * 2 + codeListLen * 2;
        if (data.byteLength - position < chunkSize) break;

        let timeListPosition = position + 32;
        position += 32 + timeListLen * 4;

        if (ctx.timeListCount < 0) {
            const pids: number[] = [];
            const dict: (Uint8Array | null)[] = [];
            let sectionListPosition = 0;

            for (let i = 0; i < dictionaryLen; i++, position += 2) {
                const codeOrSize = data.getUint16(position, true) - 4096;
                if (codeOrSize >= 0) {
                    if (codeOrSize >= ctx.pids.length || ctx.pids[codeOrSize] < 0) return null;
                    pids[i] = ctx.pids[codeOrSize];
                    dict[i] = ctx.dict[codeOrSize];
                    ctx.pids[codeOrSize] = -1;
                } else {
                    pids[i] = codeOrSize;
                    dict[i] = null;
                    sectionListPosition += 2;
                }
            }
            sectionListPosition += position;

            for (let i = 0; i < dictionaryLen; i++) {
                if (pids[i] >= 0) continue;
                const psi = new Uint8Array(data.buffer, sectionListPosition, pids[i] + 4097);
                const packets = new Uint8Array(Math.ceil((psi.length + 1) / 184) * 188);
                for (let j = 0, k = 0; k < psi.length; j++, k++) {
                    if (!(j % 188)) {
                        j += 4;
                        if (!k) packets[j++] = 0;
                    }
                    packets[j] = psi[k];
                }
                dict[i] = packets;
                sectionListPosition += psi.length;
                pids[i] = data.getUint16(position, true) & 0x1fff;
                position += 2;
            }

            for (let i = dictionaryLen, j = 0; i < dictionaryWindowLen; j++) {
                if (j >= ctx.pids.length) return null;
                if (ctx.pids[j] < 0) continue;
                pids[i] = ctx.pids[j];
                dict[i++] = ctx.dict[j];
            }
            ctx.pids = pids;
            ctx.dict = dict;
            ctx.timeListCount = 0;
            position = sectionListPosition + (dictionaryDataSize % 2);
        } else {
            position += dictionaryLen * 2 + Math.ceil(dictionaryDataSize / 2) * 2;
        }

        position += ctx.codeListPosition;
        timeListPosition += ctx.timeListCount * 4;
        for (; ctx.timeListCount < timeListLen; ctx.timeListCount++, timeListPosition += 4) {
            let initTime = ctx.initTime;
            let currTime = ctx.currTime;
            const absTime = data.getUint32(timeListPosition, true);
            if (absTime === 0xffffffff) {
                currTime = -1;
            } else if (absTime >= 0x80000000) {
                currTime = absTime & 0x3fffffff;
                if (initTime < 0) initTime = currTime;
            } else {
                const n = data.getUint16(timeListPosition + 2, true) + 1;
                if (currTime >= 0) {
                    currTime += data.getUint16(timeListPosition, true);
                    const second = ((currTime + 0x40000000 - initTime) & 0x3fffffff) / 11250;
                    for (; ctx.codeCount < n; ctx.codeCount++, position += 2, ctx.codeListPosition += 2) {
                        const code = data.getUint16(position, true) - 4096;
                        const packets = ctx.dict[code];
                        if (packets) callback(second, packets, ctx.pids[code]);
                    }
                    ctx.codeCount = 0;
                } else {
                    position += n * 2;
                    ctx.codeListPosition += n * 2;
                }
            }
            ctx.initTime = initTime;
            ctx.currTime = currTime;
        }

        ctx.position = position;
        ctx.trailerSize = 2 + ((2 + chunkSize) % 4);
        ctx.timeListCount = -1;
        ctx.codeListPosition = 0;
        ctx.currTime = -1;
    }
    const rest = data.buffer.slice(ctx.position) as ArrayBuffer;
    ctx.position = 0;
    return rest;
}

async function run(url: string, serviceId: number): Promise<void> {
    const reader = decodeTS({
        sendCallback: message => self.postMessage(message),
        serviceId,
        // 字幕 (PES) は扱わない
        parsePES: false,
    });

    const response = await fetch(url);
    const body = response.body?.getReader();
    if (!response.ok || !body) throw new Error(`data stream -> ${response.status}`);

    let pending = new Uint8Array(0);
    let lastPcr = -1;
    for (;;) {
        const { done, value } = await body.read();
        if (done) break;

        const joined = new Uint8Array(pending.length + value.length);
        joined.set(pending);
        joined.set(value, pending.length);

        const rest = readChunk(joined.buffer, (second, packets, pid) => {
            const pcr = Math.floor(second * 90000);
            if (pcr !== lastPcr) {
                self.postMessage({ type: 'pcr', pcrBase: pcr, pcrExtension: 0 });
                lastPcr = pcr;
            }
            setTSPacketHeader(packets, pid);
            reader.push(packets);
        });
        if (rest === null) throw new Error('broken data stream');
        pending = new Uint8Array(rest);
    }
}

// 1 つの Worker は 1 回の視聴ぶんだけ使い、止めるときは Worker ごと終了させる
self.onmessage = (event: MessageEvent<{ url: string; serviceId: number }>) => {
    run(event.data.url, event.data.serviceId)
        .then(() => self.postMessage({ type: 'x-ended' }))
        .catch((err: unknown) => self.postMessage({ type: 'x-ended', error: String(err) }));
};
