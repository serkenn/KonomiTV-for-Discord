// 音声の切り替え (主音声 / 副音声 / 主+副)。
// KonomiTV の TS は主音声と副音声を別々の音声として持っている (副音声がない番組では無音、
// デュアルモノは左を主音声・右を副音声に分けてある)。mpegts.js は PMT で先に書かれた音声だけを再生する。
import { spawn, spawnSync } from 'node:child_process';
import { Transform } from 'node:stream';

const PACKET = 188;
const AUDIO_STREAM_TYPES = new Set([0x03, 0x04, 0x0f, 0x11, 0x81, 0x87]);

/** パケット i のペイロードの開始位置。ペイロードがなければ -1 */
function payloadStart(buf, i) {
    const control = (buf[i + 3] >> 4) & 3;
    if (control === 0 || control === 2) return -1;
    let p = i + 4;
    if (control === 3) p += 1 + buf[p];
    return p < i + PACKET ? p : -1;
}

/** セクションの先頭 (pointer_field を読み飛ばした位置)。新しいセクションが始まらないパケットなら -1 */
function sectionStart(buf, i) {
    if (!(buf[i + 1] & 0x40)) return -1;
    const p = payloadStart(buf, i);
    if (p < 0) return -1;
    const s = p + 1 + buf[p];
    return s < i + PACKET ? s : -1;
}

/** i から始まる同期バイトの位置。次のパケットの先頭も同期バイトであることを確かめる */
function findSync(buf, from) {
    for (let k = buf.indexOf(0x47, from); k >= 0; k = buf.indexOf(0x47, k + 1)) {
        if (k + PACKET >= buf.length || buf[k + PACKET] === 0x47) return k;
    }
    return -1;
}

/**
 * 主音声と副音声の PID を入れ替える Transform (副音声で見るとき)。
 * PAT と PMT を読んで PID を確かめるまでは何も変えずに流す。mpegts.js も PMT を読むまでは何も再生しないので、
 * 入れ替えは映像の頭からそろう。
 */
export function swapAudioPids() {
    let pmtPid = -1;
    let primary = -1;
    let secondary = -1;
    let carry = null;

    const readPAT = (buf, i) => {
        const s = sectionStart(buf, i);
        if (s < 0 || s + 8 > i + PACKET || buf[s] !== 0x00) return;
        const end = Math.min(s + 3 + (((buf[s + 1] & 0x0f) << 8) | buf[s + 2]) - 4, i + PACKET);
        for (let j = s + 8; j + 4 <= end; j += 4) {
            if (((buf[j] << 8) | buf[j + 1]) !== 0) {
                pmtPid = ((buf[j + 2] & 0x1f) << 8) | buf[j + 3];
                return;
            }
        }
    };

    const readPMT = (buf, i) => {
        const s = sectionStart(buf, i);
        if (s < 0 || s + 12 > i + PACKET || buf[s] !== 0x02) return;
        const end = s + 3 + (((buf[s + 1] & 0x0f) << 8) | buf[s + 2]) - 4;
        // 1 パケットに収まらない PMT は読まない (そのときは入れ替えない)
        if (end > i + PACKET) return;
        const audio = [];
        let j = s + 12 + (((buf[s + 10] & 0x0f) << 8) | buf[s + 11]);
        while (j + 5 <= end) {
            if (AUDIO_STREAM_TYPES.has(buf[j])) audio.push(((buf[j + 1] & 0x1f) << 8) | buf[j + 2]);
            j += 5 + (((buf[j + 3] & 0x0f) << 8) | buf[j + 4]);
        }
        [primary, secondary] = audio.length >= 2 ? audio : [-1, -1];
    };

    return new Transform({
        transform(chunk, _encoding, done) {
            const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
            carry = null;
            let i = 0;
            while (i + PACKET <= buf.length) {
                if (buf[i] !== 0x47) {
                    // 区切りがずれていたら次のパケットの先頭まで進む (そのあいだのバイトはそのまま流す)
                    const next = findSync(buf, i + 1);
                    if (next < 0) {
                        i = buf.length;
                        break;
                    }
                    i = next;
                    continue;
                }
                const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
                if (pid === 0) readPAT(buf, i);
                else if (pid === pmtPid) readPMT(buf, i);
                else if (primary >= 0 && (pid === primary || pid === secondary)) {
                    const to = pid === primary ? secondary : primary;
                    buf[i + 1] = (buf[i + 1] & 0xe0) | (to >> 8);
                    buf[i + 2] = to & 0xff;
                }
                i += PACKET;
            }
            if (i < buf.length) carry = Buffer.from(buf.subarray(i));
            done(null, buf.subarray(0, i));
        },
        flush(done) {
            done(null, carry ?? undefined);
        },
    });
}

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

/** 主+副 に使う ffmpeg があるか */
export const canMixAudio = (() => {
    try {
        return spawnSync(FFMPEG, ['-hide_banner', '-version'], { stdio: 'ignore', timeout: 10000 }).status === 0;
    } catch {
        return false;
    }
})();

/**
 * 主音声を左、副音声を右に振り分けた 1 本の音声にする ffmpeg を起動する (主+副)。
 * 作り直すのは音声だけで、映像と字幕 (ID3) はそのまま通す。stdin に TS を流し、stdout から受け取る。
 */
export function spawnAudioMixer() {
    return spawn(
        FFMPEG,
        [
            '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-fflags', '+nobuffer', '-analyzeduration', '1000000', '-probesize', '5000000',
            '-f', 'mpegts', '-i', 'pipe:0',
            '-filter_complex',
            '[0:a:0]pan=mono|c0=0.5*c0+0.5*c1[m];[0:a:1]pan=mono|c0=0.5*c0+0.5*c1[s];[m][s]join=inputs=2:channel_layout=stereo[a]',
            '-map', '0:v:0', '-map', '[a]', '-map', '0:d?',
            '-c:v', 'copy', '-c:d', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
            '-f', 'mpegts', '-muxdelay', '0', '-muxpreload', '0', 'pipe:1',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
    );
}
