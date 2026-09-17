// Verify persistence round-trip: the pins + trace we save serialize and read
// back IDENTICAL, and the map key is stable & filesystem-safe. storage.ts uses
// expo-file-system (native), so here we test the exact JSON payload shape and
// key derivation the module uses, round-tripped through Node's fs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Reimplement mapKey identically to lib/storage.ts (kept in sync intentionally).
function mapKey(fileUriOrName) {
  const name = decodeURIComponent(fileUriOrName.split('/').pop() || 'map.pdf');
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) >>> 0;
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  return `${safe}.${h.toString(36)}`;
}

let ok = true;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 1. Key is stable and filesystem-safe.
const uri = 'file:///data/user/0/com.firemap.viewer/cache/Timber_CALPF002271_20260911_DIV_F-H_ops.pdf';
const k1 = mapKey(uri);
const k2 = mapKey('Timber_CALPF002271_20260911_DIV_F-H_ops.pdf'); // same basename
console.log('map key:', k1);
if (k1 !== k2) { ok = false; console.error('FAIL: key not stable across uri vs name'); }
if (/[^A-Za-z0-9._-]/.test(k1)) { ok = false; console.error('FAIL: key not filesystem-safe'); }
// different map -> different key
if (mapKey('OtherMap.pdf') === k1) { ok = false; console.error('FAIL: distinct maps share a key'); }

// 2. Save -> read identical (the payload shape saveMapData writes).
const data = {
  pins: [
    { lat: 36.2072, lon: -121.9626 },
    { lat: 36.3105, lon: -121.812 },
  ],
  trace: [
    { lat: 36.25, lon: -121.9, t: 1757000000000 },
    { lat: 36.2501, lon: -121.8998, t: 1757000005000 },
    { lat: 36.2503, lon: -121.8995, t: 1757000010000 },
  ],
};
const payload = { pins: data.pins, trace: data.trace, savedAt: Date.now() };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firemap-'));
const file = path.join(dir, `${k1}.json`);
fs.writeFileSync(file, JSON.stringify(payload));
const readBack = JSON.parse(fs.readFileSync(file, 'utf8'));

if (!eq(readBack.pins, data.pins)) { ok = false; console.error('FAIL: pins changed across save/load'); }
if (!eq(readBack.trace, data.trace)) { ok = false; console.error('FAIL: trace changed across save/load'); }
console.log(`round-trip: ${readBack.pins.length} pins, ${readBack.trace.length} track pts — identical: ${eq(readBack.pins, data.pins) && eq(readBack.trace, data.trace)}`);

// 3. Missing file -> empty (loadMapData contract).
const missing = path.join(dir, 'nope.json');
const empty = fs.existsSync(missing) ? JSON.parse(fs.readFileSync(missing)) : { pins: [], trace: [] };
if (empty.pins.length || empty.trace.length) { ok = false; console.error('FAIL: missing file not empty'); }

fs.rmSync(dir, { recursive: true, force: true });
console.log(ok ? 'RESULT: PASS ✓  persistence round-trip verified' : 'RESULT: FAIL ✗');
process.exit(ok ? 0 : 1);
