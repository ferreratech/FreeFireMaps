// Offline persistence for pins (waypoints) and a trace (recorded GPS line),
// as JSON in the app's document directory, KEYED BY MAP. Everything is stored
// as REAL-WORLD lat/lon so it re-projects correctly through the georeference on
// any map load — never page pixels, which break if the map or transform changes.
//
// Model (kept deliberately minimal per the field-tool spec):
//   - drop pins, record a trace  -> held in memory by the UI
//   - ONE Save writes {pins, trace} for the current map to disk
//   - reopening that same map auto-loads its saved {pins, trace}
// No list screen, no naming, no per-item editing.

import * as FileSystem from 'expo-file-system';

export interface Pin {
  lat: number;
  lon: number;
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
      pins: Array.isArray(parsed.pins) ? parsed.pins : [],
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
