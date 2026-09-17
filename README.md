# FreeFireMaps

Offline georeferenced-PDF map viewer for Android, built for reading wildfire
incident maps in the field. Open a GeoPDF (CAL FIRE / NIFC / USFS ops and IR
maps, USGS topos), pan and zoom it, and see your GPS position on the page —
with no signal, no account, and no third-party PDF engine.

<p align="center"><img src="assets/icon.png" width="128" alt="FreeFireMaps icon"></p>

## Features

- **GeoPDF georeference** — reads ISO 32000 `/Measure` + `/GPTS` (and the older
  TerraGo `/LGIDict`), solves the page↔ground transform, and places you on the map.
- **Sharp at any zoom** — the page is rasterised with Android's built-in
  `PdfRenderer`; after every gesture the visible area is re-rendered at true
  screen density, so vector text stays crisp instead of being stretched.
- **Pins with notes and a trace** — long-press to drop a pin, tap it to add a
  note ("DP 3") or remove it, record a GPS trace, save per map. Everything is
  stored as lat/lon so it survives reloads.
- **USNG / UTM readout + heading** — your position in the grid crews radio,
  compass heading as an arrow on the dot, and a scale bar that stays correct at
  any zoom.
- **Follow-me** — keep the map centred on you; any pan turns it off.
- **Measure** — tap points for distance (ft/mi and m/km) and bearing.
- **Recent maps** — reopen the last dozen maps from the home screen.
- **Open with…** — share any PDF to FreeFireMaps from Files, Drive, email or a
  browser download.
- **Fully offline**, self-contained APK (Hermes bundle embedded, arm64).

## Build

Local, no EAS and no Expo account. Needs JDK 17 and an Android SDK
(`~/.android-env` exports both here; see `scripts/build-apk.sh`).

```sh
npm install
npm run build:apk            # -> dist-apk/freefiremaps-<version>-arm64.apk
ABIS=all npm run build:apk   # universal (x86_64 for an emulator + arm64)
```

`build:apk` runs a set of **behavioural gates** before and after gradle:
georeference round-trip against a real CAL FIRE GeoPDF, persistence round-trip,
overlay bitmap bounds, pan/zoom geometry (including concurrent pan + pinch),
renderer wiring and tile math, native-module linkage, embedded-bundle and dex
checks. The release build is signed with the debug keystore — fine for
sideloading, not for the Play Store.

## Layout

| path | what |
|---|---|
| `app/` | expo-router screens (`index.tsx` is the whole UI) |
| `components/MapViewer.tsx` | render + gesture + overlay projection (one top-left-origin transform) |
| `modules/pdf-page/` | local Expo module: `PdfRenderer` page + region rendering (Kotlin) |
| `lib/geopdf.ts`, `lib/utm.ts`, `lib/affine.ts` | georeference parsing and projection |
| `lib/storage.ts` | per-map pins/trace persistence |
| `scripts/` | build script and gates |
| `test-maps/` | a real CAL FIRE ops GeoPDF used by the gates |

## Testing on an emulator

An x86_64 API 34 emulator with KVM runs the universal build. Launch with a map
via the PDF intent, inject GPS with `adb emu geo fix`, and drive two-finger
pinches with `sendevent` on the virtio multitouch device (send `ABS_MT_PRESSURE`
per slot or Android classifies the contact as hovering). The GPS dot's screen
position before/after a pinch centred on it is the pass/fail signal.

## License

MIT — see `LICENSE`. The Timber incident ops map in `test-maps/` is a public
CAL FIRE document included for the build gates.
