# Developing FreeFireMaps

The technical details behind the [README](../README.md).

## How the georeferencing works

- Reads ISO 32000 `/Measure` + `/GPTS` (and the older TerraGo `/LGIDict`),
  then solves the page-to-ground transform. Your GPS position is projected through the inverse of that
  transform to a point on the page.
- The page is rasterised with Android's built-in `PdfRenderer`. After every
  gesture the visible area is re-rendered at true screen density, so vector text
  stays crisp instead of being stretched.
- Pins and traces are stored as lat/lon, so they survive reloads and re-renders.
- The APK is self-contained: the Hermes JS bundle is embedded, arm64 only.

## Build

Local, no EAS and no Expo account. Needs JDK 17, an Android SDK and Node 20
(`~/.android-env` exports the toolchain here; see `scripts/build-apk.sh`).

```sh
npm install
npm run build:apk            # -> dist-apk/freefiremaps-<version>-arm64.apk
ABIS=all npm run build:apk   # universal (x86_64 for an emulator + arm64)
```

`build:apk` runs a set of **behavioural gates** before and after gradle:
georeference round-trip against a real CAL FIRE GeoPDF, persistence round-trip,
overlay bitmap bounds, pan/zoom geometry (including concurrent pan + pinch),
renderer wiring and tile math, native-module linkage, embedded-bundle and dex
checks. The release build is signed with the debug keystore, which is fine for
sideloading but not for the Play Store.

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
position before and after a pinch centred on it is the pass/fail signal. The
README screenshots were taken this way.
