import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import MapViewer from '../components/MapViewer';
import { GeoRef, isInsideMap, parseGeoRef } from '../lib/geopdf';
import { loadMapData, mapKey, Pin, saveMapData, TrackPoint } from '../lib/storage';

type Fix = { latitude: number; longitude: number; accuracy: number | null };

export default function Home() {
  const [fileUri, setFileUri] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [geo, setGeo] = useState<GeoRef | null>(null);
  const [geoStatus, setGeoStatus] = useState<string>('');
  const [loc, setLoc] = useState<Fix | null>(null);
  const [busy, setBusy] = useState(false);

  // per-map data (lat/lon), plus recording state and a dirty flag.
  const [pins, setPins] = useState<Pin[]>([]);
  const [trace, setTrace] = useState<TrackPoint[]>([]);
  const [recording, setRecording] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');
  const [fitReq, setFitReq] = useState(0);

  const keyRef = useRef<string>('');
  const recordingRef = useRef(false);
  const watchRef = useRef<Location.LocationSubscription | null>(null);

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

  // Load a map by URI: either picked, or handed to us by "Open with FireMap" on a PDF.
  const loadMap = useCallback(async (uri: string, name: string) => {
    setBusy(true);
    try {
      let local = uri;
      if (!uri.startsWith('file://')) {
        // A content:// grant from another app can be revoked once that app
        // goes away; copy it into our cache so the map keeps working.
        const dest = `${FileSystem.cacheDirectory}${name.replace(/[^\w.-]+/g, '_')}`;
        await FileSystem.copyAsync({ from: uri, to: dest });
        local = dest;
      }
      setFileUri(local);
      setFileName(name);
      setGeo(null);
      setRecording(false);
      recordingRef.current = false;
      setSavedMsg('');
      setGeoStatus('Reading georeference…');
      await readGeoRef(local);
      // auto-load saved pins + trace for THIS map
      const key = mapKey(name);
      keyRef.current = key;
      const data = await loadMapData(key);
      setPins(data.pins);
      setTrace(data.trace);
      setDirty(false);
      if (data.pins.length || data.trace.length) {
        setSavedMsg(`Loaded ${data.pins.length} pin(s), ${data.trace.length} track pt(s)`);
      }
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

  // "Open with FireMap": a PDF shared/opened from Files, Drive, email, a browser.
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
  }, []);

  useEffect(() => {
    startGps();
    return () => {
      watchRef.current?.remove();
      watchRef.current = null;
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

  const onTapPin = (index: number) => {
    setPins((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  };

  const clearAll = () => {
    setPins([]);
    setTrace([]);
    setDirty(true);
  };

  const save = async () => {
    if (!keyRef.current) return;
    await saveMapData(keyRef.current, { pins, trace });
    setDirty(false);
    setSavedMsg(`Saved ${pins.length} pin(s), ${trace.length} track pt(s)`);
  };

  const inside = geo && loc ? isInsideMap(geo, loc.latitude, loc.longitude) : null;

  return (
    <SafeAreaView style={styles.root}>
      {fileUri ? (
        <MapViewer
          fileUri={fileUri}
          geo={geo}
          location={loc}
          pins={pins}
          trace={trace}
          onDropPin={onDropPin}
          onTapPin={onTapPin}
          fitRequest={fitReq}
        />
      ) : (
        <View style={styles.empty}>
          <Text style={styles.title}>FireMap</Text>
          <Text style={styles.sub}>Offline georeferenced PDF viewer</Text>
          <Pressable style={styles.cta} onPress={pickMap}>
            <Text style={styles.ctaText}>Open a map (PDF)</Text>
          </Pressable>
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
            {(recording || savedMsg) && (
              <Text style={styles.statusExtra} numberOfLines={1}>
                {recording ? `● REC  ${trace.length} pts` : savedMsg}
                {dirty ? '  (unsaved)' : ''}
              </Text>
            )}
          </View>
        </View>
      )}

      {fileUri && (
        <View style={styles.controls} pointerEvents="box-none">
          <View style={styles.row}>
            <Pressable
              style={[styles.pill, recording && styles.pillActive]}
              onPress={toggleRecord}
            >
              <Text style={styles.pillText}>{recording ? 'Stop' : 'Record'}</Text>
            </Pressable>
            <Pressable style={styles.pill} onPress={dropPinAtGps}>
              <Text style={styles.pillText}>Pin here</Text>
            </Pressable>
            <Pressable style={styles.pill} onPress={() => setFitReq((n) => n + 1)}>
              <Text style={styles.pillText}>Fit</Text>
            </Pressable>
          </View>
          <View style={styles.row}>
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
          <Text style={styles.tip}>Long-press map to drop a pin • tap a pin to remove</Text>
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
  statusExtra: { color: '#fbbf24', fontSize: 12, marginTop: 2, fontWeight: '600' },
  controls: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 12, alignItems: 'center' },
  row: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  pill: {
    backgroundColor: 'rgba(30,30,30,0.92)',
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 22,
    minWidth: 84,
    alignItems: 'center',
  },
  pillActive: { backgroundColor: '#dc2626' },
  pillDim: { opacity: 0.5 },
  save: { backgroundColor: 'rgba(224,83,43,0.92)' },
  pillText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  tip: { color: '#8a8f98', fontSize: 11 },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
});
