// Offline persistence for pins (waypoints) and a trace (recorded GPS line),
// as JSON in the app's document directory, KEYED BY MAP. Everything is stored
// as REAL-WORLD lat/lon so it re-projects correctly through the georeference on
// any map load — never page pixels, which break if the map or transform changes.
//
// Model (kept deliberately minimal per the field-tool spec):
//   - drop pins, record a trace  -> held in memory by the UI
//   - ONE Save writes {pins, trace} for the current map to disk
//   - reopening that same map auto-loads its saved {pins, trace}
// Pins may carry a short label; a recent-maps list remembers the last few
// opened PDFs (copied into the app's documents so they outlive the OS cache).

import * as FileSystem from 'expo-file-system';

export interface Pin {
  lat: number;
  lon: number;
  /** Short note shown beside the pin ("DP 3", "spot fire"). */
  label?: string;
}

export interface TrackPoint {
  lat: number;
  lon: number;
  t: number; // epoch ms
}

export interface MapData {
  pins: Pin[];
  trace: TrackPoint[];
  savedAt: number;
}

const DIR = (FileSystem.documentDirectory ?? '') + 'firemap/';

const EMPTY: MapData = { pins: [], trace: [], savedAt: 0 };

/** A filesystem-safe key for a map, derived from its file name (+ a short hash
 *  of the name so different maps with the same basename don't collide). */
export function mapKey(fileUriOrName: string): string {
  const name = decodeURIComponent(fileUriOrName.split('/').pop() || 'map.pdf');
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) >>> 0;
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  return `${safe}.${h.toString(36)}`;
}

function fileFor(key: string): string {
  return `${DIR}${key}.json`;
}

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
}

/** Load the saved pins + trace for a map. Returns empty data if none saved. */
export async function loadMapData(key: string): Promise<MapData> {
  try {
    const info = await FileSystem.getInfoAsync(fileFor(key));
    if (!info.exists) return { ...EMPTY };
    const raw = await FileSystem.readAsStringAsync(fileFor(key));
    const parsed = JSON.parse(raw);
    return {
      pins: Array.isArray(parsed.pins)
        ? parsed.pins.map((p: any) => ({ lat: p.lat, lon: p.lon, ...(p.label ? { label: String(p.label) } : {}) }))
        : [],
      trace: Array.isArray(parsed.trace) ? parsed.trace : [],
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Save the current pins + trace for a map (single Save action). */
export async function saveMapData(
  key: string,
  data: { pins: Pin[]; trace: TrackPoint[] },
): Promise<void> {
  await ensureDir();
  const payload: MapData = { pins: data.pins, trace: data.trace, savedAt: Date.now() };
  await FileSystem.writeAsStringAsync(fileFor(key), JSON.stringify(payload));
}

/** Storage path for a key (exposed for tests / debugging). */
export function fileForKey(key: string): string {
  return fileFor(key);
}

// --- recent maps -------------------------------------------------------------

export interface RecentMap {
  name: string;
  key: string;
  /** file:// path of our own copy under the documents directory */
  path: string;
  lastOpened: number;
}

const RECENT_FILE = `${DIR}recent.json`;
const MAPS_DIR = `${DIR}maps/`;
const RECENT_MAX = 12;

/** Copy a picked/shared PDF into the app's documents so it can be reopened
 *  later (the picker's cache copy and content:// grants are transient). */
export async function importMapFile(uri: string, name: string): Promise<string> {
  await ensureDir();
  const info = await FileSystem.getInfoAsync(MAPS_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(MAPS_DIR, { intermediates: true });
  const dest = `${MAPS_DIR}${mapKey(name)}.pdf`;
  if (uri !== dest) {
    await FileSystem.deleteAsync(dest, { idempotent: true });
    await FileSystem.copyAsync({ from: uri, to: dest });
  }
  return dest;
}

export async function listRecent(): Promise<RecentMap[]> {
  try {
    const info = await FileSystem.getInfoAsync(RECENT_FILE);
    if (!info.exists) return [];
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(RECENT_FILE));
    if (!Array.isArray(parsed)) return [];
    // Drop entries whose file has gone (user cleared storage, etc.).
    const out: RecentMap[] = [];
    for (const r of parsed) {
      if (!r || typeof r.path !== 'string') continue;
      const fi = await FileSystem.getInfoAsync(r.path);
      if (fi.exists) out.push({ name: String(r.name), key: String(r.key), path: r.path, lastOpened: Number(r.lastOpened) || 0 });
    }
    return out.sort((a, b) => b.lastOpened - a.lastOpened);
  } catch {
    return [];
  }
}

export async function addRecent(entry: { name: string; key: string; path: string }): Promise<RecentMap[]> {
  await ensureDir();
  const cur = (await listRecent()).filter((r) => r.key !== entry.key);
  const next = [{ ...entry, lastOpened: Date.now() }, ...cur].slice(0, RECENT_MAX);
  await FileSystem.writeAsStringAsync(RECENT_FILE, JSON.stringify(next));
  return next;
}

export async function removeRecent(key: string): Promise<RecentMap[]> {
  const cur = (await listRecent()).filter((r) => r.key !== key);
  await ensureDir();
  await FileSystem.writeAsStringAsync(RECENT_FILE, JSON.stringify(cur));
  return cur;
}
