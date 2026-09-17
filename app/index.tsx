import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import MapViewer from '../components/MapViewer';
import { GeoRef, isInsideMap, parseGeoRef } from '../lib/geopdf';
import { bearing, fmtDistance, pathLength, toUsng } from '../lib/grid';
import {
  addRecent, importMapFile, listRecent, loadMapData, mapKey, Pin, RecentMap, removeRecent, saveMapData, TrackPoint,
} from '../lib/storage';

type Fix = { latitude: number; longitude: number; accuracy: number | null };
type LatLon = { lat: number; lon: number };

export default function Home() {
  const [fileUri, setFileUri] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [geo, setGeo] = useState<GeoRef | null>(null);
  const [geoStatus, setGeoStatus] = useState<string>('');
  const [loc, setLoc] = useState<Fix | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<RecentMap[]>([]);

  // per-map data (lat/lon), plus recording state and a dirty flag.
  const [pins, setPins] = useState<Pin[]>([]);
  const [trace, setTrace] = useState<TrackPoint[]>([]);
  const [recording, setRecording] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');
  const [fitReq, setFitReq] = useState(0);

  // tools
  const [follow, setFollow] = useState(false);
  const [measureMode, setMeasureMode] = useState(false);
  const [measurePts, setMeasurePts] = useState<LatLon[]>([]);
  const [pinSheet, setPinSheet] = useState<number | null>(null); // index of the pin being edited
  const [pinDraft, setPinDraft] = useState('');

  const keyRef = useRef<string>('');
  const recordingRef = useRef(false);
  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const headingRef = useRef<Location.LocationSubscription | null>(null);

  useEffect(() => { listRecent().then(setRecent).catch(() => {}); }, []);

  const readGeoRef = useCallback(async (uri: string) => {
    try {
      const decoder: ((s: string) => string) | undefined = (globalThis as any).atob;
      const b64ToLatin1 = (b64: string) =>
        decoder ? decoder(b64) : Buffer.from(b64, 'base64').toString('latin1');
      let bin = '';
      let g: GeoRef | null = null;
      for (const len of [524288, 2097152, 8388608]) {
        const chunk = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
          position: 0,
          length: len,
        });
        bin = b64ToLatin1(chunk);
        if (bin.indexOf('/Measure') >= 0) {
          g = parseGeoRef(bin);
          break;
        }
      }
      if (!g) g = parseGeoRef(bin);
      if (g) {
        setGeo(g);
        setGeoStatus(`Georeferenced ✓  (corner error ${g.cornerResidualPx.toExponential(1)} px)`);
      } else {
        setGeo(null);
        setGeoStatus('No georeference found — map shown without GPS placement');
      }
    } catch (e: any) {
      setGeo(null);
      setGeoStatus('Could not read georeference: ' + (e?.message ?? e));
    }
  }, []);

  // Load a map by URI: picked, handed to us by "Open with", or from the recent list.
  const loadMap = useCallback(async (uri: string, name: string) => {
    setBusy(true);
    try {
      // Our own copy under documents: survives cache purges and revoked content:// grants.
      const local = await importMapFile(uri, name);
      const key = mapKey(name);
      setFileUri(local);
      setFileName(name);
      setGeo(null);
      setRecording(false);
      recordingRef.current = false;
      setSavedMsg('');
      setFollow(false);
      setMeasureMode(false);
      setMeasurePts([]);
      setPinSheet(null);
      setGeoStatus('Reading georeference…');
      await readGeoRef(local);
      keyRef.current = key;
      const data = await loadMapData(key);
      setPins(data.pins);
      setTrace(data.trace);
      setDirty(false);
      if (data.pins.length || data.trace.length) {
        setSavedMsg(`Loaded ${data.pins.length} pin(s), ${data.trace.length} track pt(s)`);
      }
      setRecent(await addRecent({ name, key, path: local }));
    } catch (e: any) {
      setGeoStatus('Could not open: ' + (e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [readGeoRef]);

  const pickMap = useCallback(async () => {
    const res = await DocumentPicker.getDocumentAsync({
      type: 'application/pdf',
      copyToCacheDirectory: true,
    });
    if (res.canceled || !res.assets?.length) return;
    const asset = res.assets[0];
    await loadMap(asset.uri, asset.name ?? 'map.pdf');
  }, [loadMap]);

  // "Open with FreeFireMaps": a PDF shared/opened from Files, Drive, email, a browser.
  useEffect(() => {
    const nameOf = (u: string) => {
      const tail = decodeURIComponent(u.split('/').pop() || 'map.pdf').split(':').pop() || 'map.pdf';
      return tail.toLowerCase().endsWith('.pdf') ? tail : `${tail}.pdf`;
    };
    const handle = (u: string | null) => {
      if (!u || !/^(content|file):/.test(u)) return;
      loadMap(u, nameOf(u));
    };
    Linking.getInitialURL().then(handle).catch(() => {});
    const sub = Linking.addEventListener('url', (e) => handle(e.url));
    return () => sub.remove();
  }, [loadMap]);

  const startGps = useCallback(async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      setGeoStatus('Location permission denied');
      return;
    }
    if (watchRef.current) return;
    // BestForNavigation = GPS/GNSS, highest accuracy; tight distance interval so
    // the dot and any recorded trace track finely.
    watchRef.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        distanceInterval: 3,
        timeInterval: 1000,
      },
      (p) => {
        const fix: Fix = {
          latitude: p.coords.latitude,
          longitude: p.coords.longitude,
          accuracy: p.coords.accuracy ?? null,
        };
        setLoc(fix);
        // record into the trace only while recording, sampled by distanceInterval
        if (recordingRef.current) {
          setTrace((prev) => [...prev, { lat: fix.latitude, lon: fix.longitude, t: Date.now() }]);
          setDirty(true);
        }
      },
    );
    // Compass. trueHeading is -1 until the device has a declination fix; fall
    // back to magnetic so the arrow still shows something useful.
    try {
      headingRef.current = await Location.watchHeadingAsync((h) => {
        const v = h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
        setHeading(v >= 0 ? v : null);
      });
    } catch {
      setHeading(null);
    }
  }, []);

  useEffect(() => {
    startGps();
    return () => {
      watchRef.current?.remove();
      watchRef.current = null;
      headingRef.current?.remove();
      headingRef.current = null;
    };
  }, [startGps]);

  const toggleRecord = () => {
    const next = !recording;
    setRecording(next);
    recordingRef.current = next;
  };

  const dropPinAtGps = () => {
    if (!loc) return;
    setPins((prev) => [...prev, { lat: loc.latitude, lon: loc.longitude }]);
    setDirty(true);
  };

  const onDropPin = (lat: number, lon: number) => {
    setPins((prev) => [...prev, { lat, lon }]);
    setDirty(true);
  };

  // Tap a pin -> edit its note (or remove it) in a small sheet.
  const onTapPin = (index: number) => {
    setPinSheet(index);
    setPinDraft(pins[index]?.label ?? '');
  };
  const savePinNote = () => {
    if (pinSheet === null) return;
    const label = pinDraft.trim();
    setPins((prev) => prev.map((p, i) => (i === pinSheet ? { lat: p.lat, lon: p.lon, ...(label ? { label } : {}) } : p)));
    setDirty(true);
    setPinSheet(null);
    Keyboard.dismiss();
  };
  const removePin = () => {
    if (pinSheet === null) return;
    setPins((prev) => prev.filter((_, i) => i !== pinSheet));
    setDirty(true);
    setPinSheet(null);
    Keyboard.dismiss();
  };

  const clearAll = () => {
    setPins([]);
    setTrace([]);
    setMeasurePts([]);
    setDirty(true);
  };

  const save = async () => {
    if (!keyRef.current) return;
    await saveMapData(keyRef.current, { pins, trace });
    setDirty(false);
    setSavedMsg(`Saved ${pins.length} pin(s), ${trace.length} track pt(s)`);
  };

  const toggleMeasure = () => {
    if (measureMode) { setMeasureMode(false); setMeasurePts([]); }
    else { setMeasureMode(true); setMeasurePts([]); }
  };
  const onMeasureTap = (lat: number, lon: number) => setMeasurePts((prev) => [...prev, { lat, lon }]);
  const measureSummary = useMemo(() => {
    if (measurePts.length < 2) return '';
    const total = pathLength(measurePts);
    const a = measurePts[measurePts.length - 2], b = measurePts[measurePts.length - 1];
    return `${fmtDistance(total)} · brg ${Math.round(bearing(a.lat, a.lon, b.lat, b.lon))}°T`;
  }, [measurePts]);

  const inside = geo && loc ? isInsideMap(geo, loc.latitude, loc.longitude) : null;
  const usng = loc ? toUsng(loc.latitude, loc.longitude) : '';

  const openRecent = (r: RecentMap) => loadMap(r.path, r.name);
  const forgetRecent = (r: RecentMap) => removeRecent(r.key).then(setRecent).catch(() => {});

  return (
    <SafeAreaView style={styles.root}>
      {fileUri ? (
        <MapViewer
          fileUri={fileUri}
          geo={geo}
          location={loc}
          heading={heading}
          pins={pins}
          trace={trace}
          onDropPin={onDropPin}
          onTapPin={onTapPin}
          fitRequest={fitReq}
          follow={follow}
          onUserGesture={() => setFollow(false)}
          measureMode={measureMode}
          measurePts={measurePts}
          onMeasureTap={onMeasureTap}
          measureLabel={measureSummary ? measureSummary.split(' · ')[0] : undefined}
        />
      ) : (
        <View style={styles.empty}>
          <Text style={styles.title}>FreeFireMaps</Text>
          <Text style={styles.sub}>Offline georeferenced PDF viewer</Text>
          <Pressable style={styles.cta} onPress={pickMap}>
            <Text style={styles.ctaText}>Open a map (PDF)</Text>
          </Pressable>
          {recent.length > 0 && (
            <View style={styles.recentBox}>
              <Text style={styles.recentHead}>Recent maps</Text>
              <FlatList
                data={recent}
                keyExtractor={(r) => r.key}
                style={{ maxHeight: 360, alignSelf: 'stretch' }}
                renderItem={({ item }) => (
                  <Pressable style={styles.recentRow} onPress={() => openRecent(item)} onLongPress={() => forgetRecent(item)}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.recentName} numberOfLines={1}>{item.name}</Text>
                      <Text style={styles.recentWhen}>{new Date(item.lastOpened).toLocaleString()}</Text>
                    </View>
                    <Text style={styles.recentChev}>›</Text>
                  </Pressable>
                )}
              />
              <Text style={styles.tip}>Long-press a map to remove it from this list</Text>
            </View>
          )}
        </View>
      )}

      {fileUri && (
        <View style={styles.topBar} pointerEvents="box-none">
          <View style={styles.statusPill}>
            <Text style={styles.statusName} numberOfLines={1}>
              {fileName}
            </Text>
            <Text style={styles.statusGeo} numberOfLines={1}>
              {geoStatus}
            </Text>
            <Text style={styles.statusGps} numberOfLines={1}>
              {loc
                ? `GPS ${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}` +
                  (loc.accuracy ? ` ±${Math.round(loc.accuracy)}m` : '') +
                  (inside === null ? '' : inside ? '  • on map' : '  • off map')
                : 'Waiting for GPS…'}
            </Text>
            {loc && (
              <Text style={styles.statusGrid} numberOfLines={1}>
                {`USNG ${usng}`}{heading !== null ? `   HDG ${Math.round(heading).toString().padStart(3, '0')}°T` : ''}
              </Text>
            )}
            {measureMode && (
              <Text style={styles.statusMeasure} numberOfLines={1}>
                {measurePts.length < 2 ? `MEASURE: tap points on the map (${measurePts.length})` : `MEASURE ${measureSummary} (${measurePts.length} pts)`}
              </Text>
            )}
            {(recording || savedMsg) && (
              <Text style={styles.statusExtra} numberOfLines={1}>
                {recording ? `● REC  ${trace.length} pts` : savedMsg}
                {dirty ? '  (unsaved)' : ''}
              </Text>
            )}
          </View>
        </View>
      )}

      {fileUri && pinSheet !== null && (
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>Pin {pinSheet + 1}</Text>
          <TextInput
            style={styles.input}
            value={pinDraft}
            onChangeText={setPinDraft}
            placeholder="Note (e.g. DP 3, spot fire, water)"
            placeholderTextColor="#777"
            autoFocus
            maxLength={40}
            onSubmitEditing={savePinNote}
          />
          <View style={styles.row}>
            <Pressable style={[styles.pill, styles.save]} onPress={savePinNote}><Text style={styles.pillText}>Save note</Text></Pressable>
            <Pressable style={[styles.pill, styles.pillDanger]} onPress={removePin}><Text style={styles.pillText}>Remove pin</Text></Pressable>
            <Pressable style={styles.pill} onPress={() => { setPinSheet(null); Keyboard.dismiss(); }}><Text style={styles.pillText}>Cancel</Text></Pressable>
          </View>
        </View>
      )}

      {fileUri && pinSheet === null && (
        <View style={styles.controls} pointerEvents="box-none">
          <View style={styles.row}>
            <Pressable style={[styles.pill, recording && styles.pillActive]} onPress={toggleRecord}>
              <Text style={styles.pillText}>{recording ? 'Stop' : 'Record'}</Text>
            </Pressable>
            <Pressable style={styles.pill} onPress={dropPinAtGps}>
              <Text style={styles.pillText}>Pin here</Text>
            </Pressable>
            <Pressable style={[styles.pill, follow && styles.pillOn]} onPress={() => setFollow((f) => !f)}>
              <Text style={styles.pillText}>{follow ? 'Following' : 'Follow'}</Text>
            </Pressable>
            <Pressable style={styles.pill} onPress={() => setFitReq((n) => n + 1)}>
              <Text style={styles.pillText}>Fit</Text>
            </Pressable>
          </View>
          <View style={styles.row}>
            <Pressable style={[styles.pill, measureMode && styles.pillOn]} onPress={toggleMeasure}>
              <Text style={styles.pillText}>{measureMode ? 'Done' : 'Measure'}</Text>
            </Pressable>
            <Pressable style={[styles.pill, styles.save, !dirty && styles.pillDim]} onPress={save}>
              <Text style={styles.pillText}>Save</Text>
            </Pressable>
            <Pressable style={styles.pill} onPress={clearAll}>
              <Text style={styles.pillText}>Clear</Text>
            </Pressable>
            <Pressable style={styles.pill} onPress={pickMap}>
              <Text style={styles.pillText}>Open</Text>
            </Pressable>
          </View>
          <Text style={styles.tip}>
            {measureMode ? 'Tap points to measure • Done to finish' : 'Long-press map to drop a pin • tap a pin for its note'}
          </Text>
        </View>
      )}

      {busy && (
        <View style={styles.overlay} pointerEvents="none">
          <ActivityIndicator color="#fff" />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0B0B0B' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { color: '#fff', fontSize: 34, fontWeight: '800', letterSpacing: 0.5 },
  sub: { color: '#9aa', fontSize: 15, marginTop: 6, marginBottom: 28 },
  cta: { backgroundColor: '#e0532b', paddingHorizontal: 28, paddingVertical: 14, borderRadius: 12 },
  ctaText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  recentBox: { alignSelf: 'stretch', marginTop: 32, alignItems: 'center' },
  recentHead: { color: '#9aa', fontSize: 12, fontWeight: '700', letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' },
  recentRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 6 },
  recentName: { color: '#fff', fontSize: 14, fontWeight: '600' },
  recentWhen: { color: '#8a8f98', fontSize: 11, marginTop: 2 },
  recentChev: { color: '#8a8f98', fontSize: 22, marginLeft: 10 },
  topBar: { position: 'absolute', top: 0, left: 0, right: 0, padding: 10 },
  statusPill: {
    backgroundColor: 'rgba(0,0,0,0.72)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  statusName: { color: '#fff', fontWeight: '700', fontSize: 13 },
  statusGeo: { color: '#7fd18b', fontSize: 12, marginTop: 2 },
  statusGps: { color: '#cbd5e1', fontSize: 12, marginTop: 2 },
  statusGrid: { color: '#fde68a', fontSize: 12, marginTop: 2, fontVariant: ['tabular-nums'], fontWeight: '600' },
  statusMeasure: { color: '#a5f3fc', fontSize: 12, marginTop: 2, fontWeight: '600' },
  statusExtra: { color: '#fbbf24', fontSize: 12, marginTop: 2, fontWeight: '600' },
  controls: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 12, alignItems: 'center' },
  row: { flexDirection: 'row', gap: 8, marginBottom: 8, flexWrap: 'wrap', justifyContent: 'center' },
  pill: {
    backgroundColor: 'rgba(30,30,30,0.92)',
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: 22,
    minWidth: 78,
    alignItems: 'center',
  },
  pillActive: { backgroundColor: '#dc2626' },
  pillOn: { backgroundColor: '#1d4ed8' },
  pillDanger: { backgroundColor: '#991b1b' },
  pillDim: { opacity: 0.5 },
  save: { backgroundColor: 'rgba(224,83,43,0.92)' },
  pillText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  tip: { color: '#8a8f98', fontSize: 11 },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(15,17,21,0.97)', padding: 14, borderTopLeftRadius: 14, borderTopRightRadius: 14, alignItems: 'center' },
  sheetTitle: { color: '#fff', fontWeight: '700', fontSize: 14, marginBottom: 8 },
  input: { alignSelf: 'stretch', backgroundColor: '#1f2430', color: '#fff', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, marginBottom: 10 },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
});
