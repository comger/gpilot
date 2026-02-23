/**
 * G-Pilot 图标生成器 - 纯 Node.js 实现，无任何外部依赖
 * 使用 zlib + Buffer 直接构造合法 PNG 文件
 * 输出：public/icons/icon16.png, icon48.png, icon128.png
 */
import { deflateSync } from 'zlib';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────
// PNG 编码器（只用 Node.js 内置 zlib）
// ─────────────────────────────────────────────────────────────
function crc32(buf) {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c;
    }
    let crc = 0xffffffff;
    for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const typeBytes = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.allocUnsafe(4);
    lenBuf.writeUInt32BE(data.length);
    const crcIn = Buffer.concat([typeBytes, data]);
    const crcBuf = Buffer.allocUnsafe(4);
    crcBuf.writeUInt32BE(crc32(crcIn));
    return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

function buildPNG(width, height, rgba) {
    // IHDR
    const ihdr = Buffer.allocUnsafe(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // color type = RGBA
    ihdr[10] = ihdr[11] = ihdr[12] = 0;

    // 图像原始数据（每行前加过滤器字节 0x00）
    const stride = width * 4;
    const rawBuf = Buffer.allocUnsafe(height * (1 + stride));
    for (let y = 0; y < height; y++) {
        rawBuf[y * (1 + stride)] = 0; // filter = None
        rgba.copy(rawBuf, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
    }

    const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    return Buffer.concat([
        PNG_SIG,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', deflateSync(rawBuf)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

// ─────────────────────────────────────────────────────────────
// 像素画笔（在 RGBA Buffer 上绘图）
// ─────────────────────────────────────────────────────────────
function makePainter(w, h) {
    const buf = Buffer.alloc(w * h * 4, 0); // transparent

    function sp(x, y, r, g, b, a = 255) {
        if (x < 0 || x >= w || y < 0 || y >= h) return;
        const i = (y * w + x) * 4;
        // alpha blending
        const srcA = a / 255;
        const dstA = buf[i + 3] / 255;
        const outA = srcA + dstA * (1 - srcA);
        if (outA < 0.001) return;
        buf[i] = Math.round((r * srcA + buf[i] * dstA * (1 - srcA)) / outA);
        buf[i + 1] = Math.round((g * srcA + buf[i + 1] * dstA * (1 - srcA)) / outA);
        buf[i + 2] = Math.round((b * srcA + buf[i + 2] * dstA * (1 - srcA)) / outA);
        buf[i + 3] = Math.round(outA * 255);
    }

    return {
        buf,
        // 抗锯齿圆形
        circle(cx, cy, radius, r, g, b, a = 255) {
            const rr = radius;
            for (let y = Math.floor(cy - rr - 1); y <= Math.ceil(cy + rr + 1); y++) {
                for (let x = Math.floor(cx - rr - 1); x <= Math.ceil(cx + rr + 1); x++) {
                    const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
                    const alpha = Math.max(0, Math.min(1, rr - dist + 0.5));
                    if (alpha > 0) sp(x, y, r, g, b, Math.round(a * alpha));
                }
            }
        },
        // 填充矩形
        rect(x, y, rw, rh, r, g, b, a = 255) {
            for (let dy = 0; dy < rh; dy++)
                for (let dx = 0; dx < rw; dx++)
                    sp(x + dx, y + dy, r, g, b, a);
        },
        // 圆角矩形
        roundRect(x, y, rw, rh, cr, r, g, b, a = 255) {
            for (let dy = 0; dy < rh; dy++) {
                for (let dx = 0; dx < rw; dx++) {
                    const px = x + dx, py = y + dy;
                    // corner distance
                    let inside = true;
                    let alpha = 1;
                    const corners = [
                        [x + cr, y + cr], [x + rw - cr, y + cr],
                        [x + cr, y + rh - cr], [x + rw - cr, y + rh - cr],
                    ];
                    if (dx < cr && dy < cr) {
                        const d = Math.sqrt((dx - cr) ** 2 + (dy - cr) ** 2);
                        alpha = Math.max(0, Math.min(1, cr - d + 0.5));
                    } else if (dx >= rw - cr && dy < cr) {
                        const d = Math.sqrt((dx - (rw - cr)) ** 2 + (dy - cr) ** 2);
                        alpha = Math.max(0, Math.min(1, cr - d + 0.5));
                    } else if (dx < cr && dy >= rh - cr) {
                        const d = Math.sqrt((dx - cr) ** 2 + (dy - (rh - cr)) ** 2);
                        alpha = Math.max(0, Math.min(1, cr - d + 0.5));
                    } else if (dx >= rw - cr && dy >= rh - cr) {
                        const d = Math.sqrt((dx - (rw - cr)) ** 2 + (dy - (rh - cr)) ** 2);
                        alpha = Math.max(0, Math.min(1, cr - d + 0.5));
                    }
                    if (alpha > 0) sp(px, py, r, g, b, Math.round(a * alpha));
                }
            }
        },
        pixel: sp,
    };
}

// ─────────────────────────────────────────────────────────────
// 图标设计：G-Pilot 品牌风格
//   深蓝渐变圆角正方形背景 + 直升机剪影
// ─────────────────────────────────────────────────────────────
function drawIcon(size) {
    const w = size, h = size;
    const p = makePainter(w, h);
    const pad = size * 0.04;
    const cr = size * 0.22;

    // ── 背景：深蓝渐变 ──
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            // 渐变：左上 #1a1a2e → 右下 #0f3460
            const t = (x + y) / (w + h);
            const r = Math.round(26 + (15 - 26) * t);
            const g = Math.round(26 + (52 - 26) * t);
            const b = Math.round(46 + (96 - 46) * t);
            const dx = x - w / 2, dy = y - h / 2;
            const rad = Math.min(w, h) / 2 - 1;
            const dist = Math.sqrt(dx * dx + dy * dy);
            // 用圆角矩形剪裁
            p.pixel(x, y, r, g, b, 0); // 先清空
        }
    }
    const bg1 = [26, 26, 46], bg2 = [15, 52, 96];
    p.roundRect(pad, pad, w - pad * 2, h - pad * 2, cr,
        bg1[0], bg1[1], bg1[2], 255);

    // 渐变色叠加（分行绘制）
    for (let y = Math.floor(pad); y < h - pad; y++) {
        const t = (y - pad) / (h - pad * 2);
        const r = Math.round(bg1[0] + (bg2[0] - bg1[0]) * t);
        const g = Math.round(bg1[1] + (bg2[1] - bg1[1]) * t);
        const b = Math.round(bg1[2] + (bg2[2] - bg1[2]) * t);
        for (let x = Math.floor(pad); x < w - pad; x++) {
            const i = (y * w + x) * 4;
            if (p.buf[i + 3] > 100) {
                p.buf[i] = r; p.buf[i + 1] = g; p.buf[i + 2] = b;
            }
        }
    }

    // ── 根据尺寸选择图形 ──
    if (size <= 16) {
        // 16px：只画旋翼 + 机身
        const cx = w / 2, cy = h / 2;
        // 旋翼（水平线）
        p.rect(cx - 5, cy - 3, 10, 2, 99, 179, 237);
        // 机身
        p.roundRect(cx - 2, cy - 1, 4, 4, 1, 184, 212, 255);
        // 旋翼轴
        p.circle(cx, cy - 2, 1, 255, 255, 255);
    } else if (size <= 48) {
        // 48px
        const cx = w / 2, cy = h / 2;
        const sc = size / 48;
        // 旋翼（水平）
        p.roundRect(cx - 18 * sc, cy - 14 * sc, 36 * sc, 4 * sc, 2 * sc, 99, 179, 237);
        // 旋翼（竖）
        p.roundRect(cx - 2 * sc, cy - 14 * sc, 4 * sc, 14 * sc, 1 * sc, 99, 179, 237, 180);
        // 机身
        p.roundRect(cx - 8 * sc, cy - 7 * sc, 14 * sc, 11 * sc, 3 * sc, 184, 212, 255);
        // 尾翼
        p.roundRect(cx + 6 * sc, cy - 3 * sc, 10 * sc, 3 * sc, 1 * sc, 184, 212, 255);
        p.roundRect(cx + 14 * sc, cy - 7 * sc, 3 * sc, 4 * sc, 1 * sc, 99, 179, 237, 200);
        // 起落架
        p.rect(cx - 5 * sc, cy + 4 * sc, 2 * sc, 4 * sc, 99, 179, 237, 160);
        p.rect(cx + 1 * sc, cy + 4 * sc, 2 * sc, 4 * sc, 99, 179, 237, 160);
        p.rect(cx - 7 * sc, cy + 8 * sc, 12 * sc, 2 * sc, 99, 179, 237, 160);
        // 旋翼轴
        p.circle(cx, cy - 12 * sc, 2.5 * sc, 255, 255, 255);
        // 驾驶舱窗
        p.roundRect(cx - 5 * sc, cy - 6 * sc, 7 * sc, 5 * sc, 2 * sc, 99, 220, 255, 120);
    } else {
        // 128px
        const cx = w / 2, cy = h * 0.44;
        const sc = size / 128;
        // ── 旋翼 ──
        p.roundRect(cx - 46 * sc, cy - 32 * sc, 92 * sc, 8 * sc, 4 * sc, 99, 179, 237);
        // 旋翼中心竖杆
        p.roundRect(cx - 4 * sc, cy - 36 * sc, 8 * sc, 36 * sc, 3 * sc, 99, 179, 237, 180);
        // 旋翼轴帽
        p.circle(cx, cy - 30 * sc, 7 * sc, 255, 255, 255);
        p.circle(cx, cy - 30 * sc, 4 * sc, 99, 179, 237);

        // ── 机身 ──
        p.roundRect(cx - 20 * sc, cy - 20 * sc, 36 * sc, 28 * sc, 8 * sc, 184, 212, 255);

        // ── 驾驶舱（半透明蓝色窗户）──
        p.roundRect(cx - 16 * sc, cy - 18 * sc, 18 * sc, 14 * sc, 6 * sc, 99, 220, 255, 140);
        // 窗户高光
        p.roundRect(cx - 14 * sc, cy - 16 * sc, 6 * sc, 4 * sc, 2 * sc, 255, 255, 255, 80);

        // ── 尾梁 ──
        for (let i = 0; i < 30; i++) {
            const t = i / 30;
            const lw = Math.round((8 - 4 * t) * sc);
            const lh = Math.round((6 - 2 * t) * sc);
            p.rect(cx + 16 * sc + i * sc, cy - 4 * sc + i * 0.4 * sc, lw, lh, 160, 200, 240);
        }

        // ── 尾旋翼 ──
        p.roundRect(cx + 42 * sc, cy + 2 * sc, 3 * sc, 16 * sc, 2 * sc, 99, 179, 237);
        p.roundRect(cx + 38 * sc, cy + 8 * sc, 11 * sc, 3 * sc, 1 * sc, 99, 179, 237, 180);

        // ── 起落架 ──
        p.rect(cx - 12 * sc, cy + 8 * sc, 3 * sc, 10 * sc, 99, 179, 237, 180);
        p.rect(cx + 6 * sc, cy + 8 * sc, 3 * sc, 10 * sc, 99, 179, 237, 180);
        p.roundRect(cx - 16 * sc, cy + 18 * sc, 30 * sc, 4 * sc, 2 * sc, 99, 179, 237, 180);

        // ── 品牌 "G" 文字（下方）──
        const gy = cy + 28 * sc, gx = cx - 8 * sc;
        const gs = Math.round(14 * sc);
        // 用像素点模拟 "G" 字（简化版）
        const glyph = [
            [0, 1, 1, 1, 0],
            [1, 0, 0, 0, 0],
            [1, 0, 1, 1, 0],
            [1, 0, 0, 1, 0],
            [0, 1, 1, 0, 0],
        ];
        const glyphScale = Math.max(1, Math.round(4 * sc));
        glyph.forEach((row, ri) => {
            row.forEach((col, ci) => {
                if (col) p.rect(
                    gx + ci * glyphScale, gy + ri * glyphScale,
                    glyphScale, glyphScale, 99, 179, 237
                );
            });
        });
    }

    return buildPNG(w, h, p.buf);
}

// ─────────────────────────────────────────────────────────────
// 生成所有尺寸
// ─────────────────────────────────────────────────────────────
const iconsDir = resolve(__dirname, '../public/icons');
mkdirSync(iconsDir, { recursive: true });

for (const size of [16, 48, 128]) {
    const png = drawIcon(size);
    const out = resolve(iconsDir, `icon${size}.png`);
    writeFileSync(out, png);
    console.log(`✅ icon${size}.png → ${out} (${png.length} bytes)`);
}

console.log('🎉 所有图标已生成！');
