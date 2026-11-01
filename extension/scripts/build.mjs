import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// builds a store-ready .zip with forward-slash paths and manifest.json at root
function createZipFromDir(sourceDir, outZipPath) {
  const files = [];
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else files.push({ full, rel });
    }
  }
  walk(sourceDir);

  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const f of files) {
    const raw = fs.readFileSync(f.full);
    const compressed = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(f.rel, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    localHeaders.push(local, compressed);
    centralHeaders.push(central);
    offset += local.length + compressed.length;
  }

  const centralSize = centralHeaders.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(
    outZipPath,
    Buffer.concat([...localHeaders, ...centralHeaders, eocd])
  );
}

function createIconPng(size) {
  const width = size;
  const height = size;
  const rawData = Buffer.alloc(height * (1 + width * 4));

  const cx = width / 2;
  const cy = height / 2;
  const radius = width * 0.44;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 4);
    rawData[rowOffset] = 0;
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > radius) {
        rawData[pxOffset] = 0;
        rawData[pxOffset + 1] = 0;
        rawData[pxOffset + 2] = 0;
        rawData[pxOffset + 3] = 0;
        continue;
      }

      const normX = (x - cx) / radius;
      const normY = (y - cy) / radius;
      const inPlayTriangle =
        normX >= -0.25 &&
        normX <= 0.42 &&
        Math.abs(normY) <= (0.42 - normX) * 0.65;

      if (inPlayTriangle) {
        rawData[pxOffset] = 255;
        rawData[pxOffset + 1] = 255;
        rawData[pxOffset + 2] = 255;
        rawData[pxOffset + 3] = 255;
      } else {
        const t = (x + y) / (width + height);
        rawData[pxOffset] = Math.round(220 - t * 35);
        rawData[pxOffset + 1] = Math.round(38 - t * 10);
        rawData[pxOffset + 2] = Math.round(38 - t * 10);
        rawData[pxOffset + 3] = 255;
      }
    }
  }

  function makeChunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcInput = Buffer.concat([typeBuf, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idatData = zlib.deflateSync(rawData);

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idatData),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function compileTailwindStyles() {
  const cssPath = path.join(ROOT, 'src/content/ui/dock.css');
  const rawCss = fs.readFileSync(cssPath, 'utf8');
  const tailwindConfigPath = path.join(ROOT, 'tailwind.config.js');

  const result = await postcss([
    tailwindcss({ config: tailwindConfigPath }),
    autoprefixer(),
  ]).process(rawCss, { from: cssPath });

  const escapedCss = result.css
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');

  const outputTs = `// Auto-generated by scripts/build.mjs\nexport const DOCK_STYLES = \`${escapedCss}\`;\n`;
  fs.writeFileSync(path.join(ROOT, 'src/content/ui/compiledStyles.ts'), outputTs, 'utf8');
  console.log('[build] Compiled CSS bundle.');
}

function ensureAssets() {
  const assetsDir = path.join(ROOT, 'src/assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  for (const size of [16, 48, 128]) {
    const iconPath = path.join(assetsDir, `icon${size}.png`);
    fs.writeFileSync(iconPath, createIconPng(size));
  }
}

async function buildTarget(target) {
  const outDir = path.join(ROOT, 'dist', target);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/background/service-worker.ts')],
    outfile: path.join(outDir, 'background.js'),
    bundle: true,
    format: 'esm',
    target: ['es2022'],
    sourcemap: false,
    minify: false,
  });

  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/content/index.ts')],
    outfile: path.join(outDir, 'content.js'),
    bundle: true,
    format: 'iife',
    target: ['es2022'],
    sourcemap: false,
    minify: false,
  });

  const manifestSrc =
    target === 'firefox'
      ? path.join(ROOT, 'src/manifests/manifest.firefox.json')
      : path.join(ROOT, 'src/manifests/manifest.chrome.json');
  fs.copyFileSync(manifestSrc, path.join(outDir, 'manifest.json'));

  for (const size of [16, 48, 128]) {
    fs.copyFileSync(
      path.join(ROOT, `src/assets/icon${size}.png`),
      path.join(outDir, `assets/icon${size}.png`)
    );
  }

  const zipPath = path.join(ROOT, 'dist', `syncparty-${target}.zip`);
  createZipFromDir(outDir, zipPath);
  console.log(`[build] Output ready: dist/${target} (and dist/syncparty-${target}.zip)`);
}

async function main() {
  const arg = process.argv[2] || 'all';
  ensureAssets();
  await compileTailwindStyles();

  fs.copyFileSync(
    path.join(ROOT, 'src/manifests/manifest.chrome.json'),
    path.join(ROOT, 'src/manifest.json')
  );

  if (arg === 'chrome') {
    await buildTarget('chrome');
  } else if (arg === 'firefox') {
    await buildTarget('firefox');
  } else {
    await buildTarget('chrome');
    await buildTarget('firefox');
  }
}

main().catch((err) => {
  console.error('[build] Failed:', err);
  process.exit(1);
});
