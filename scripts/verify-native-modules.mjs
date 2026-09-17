// BUILD-TIME GATE: assert every native module the JS bundle imports is actually
// linked into the release build. Catches "Cannot find native module 'X'"
// startup crashes without needing a device.
//
// Run AFTER `expo prebuild` (needs the generated android/ autolinking output).
// Exits non-zero if any imported native module is missing from the linked set.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (msg) => { console.error('✗ ' + msg); process.exitCode = 1; };

// 1. Collect package specifiers imported by our own source (app/, components/, lib/).
const srcDirs = ['app', 'components', 'lib'].map((d) => path.join(root, d));
const files = [];
for (const d of srcDirs) {
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d, { recursive: true })) {
    const p = path.join(d, String(f));
    if (/\.(ts|tsx|js|jsx)$/.test(p) && fs.statSync(p).isFile()) files.push(p);
  }
}
const imports = new Set();
const importRe = /(?:from\s*|require\(\s*)['"]([^'".][^'"]*)['"]/g;
for (const f of files) {
  // Strip // and /* */ comments so prose like `from "X"` cannot look like an import.
  const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  let m;
  while ((m = importRe.exec(src))) {
    let spec = m[1];
    if (spec.startsWith('node:') || spec.startsWith('.')) continue;
    // package root: scope/name or name (strip subpaths)
    const parts = spec.split('/');
    spec = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    imports.add(spec);
  }
}

// 2. Keep only packages that ship a native ANDROID module (need linking).
//    - react-native itself is the core framework, never autolinked.
//    - an Expo module needs Android linking only if its expo-module.config.json
//      declares the "android" platform (e.g. expo-router is apple/web only).
//    - other packages count if they have an android/ dir with a build.gradle.
const CORE = new Set(['react-native', 'react', 'react-dom']);
// JS-only packages that are safe to import without a native module.
const JS_ONLY = new Set(['expo-status-bar', 'expo-router', 'expo-linking', 'typescript']);
const needsAndroid = (pkg) => {
  if (CORE.has(pkg) || JS_ONLY.has(pkg)) return false;
  const base = path.join(root, 'node_modules', pkg);
  // An imported package that isn't installed at all is a hard failure — the JS
  // bundle would throw "Cannot find module" (or its native module) at runtime.
  if (!fs.existsSync(path.join(base, 'package.json'))) {
    fail(`${pkg} is imported but NOT installed in node_modules`);
    return true; // surface it in the list as missing
  }
  const cfgPath = path.join(base, 'expo-module.config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const platforms = cfg.platforms || [];
      // "android" listed, or an android modules block present
      return platforms.includes('android') || !!cfg.android;
    } catch {
      /* fall through to dir check */
    }
  }
  return fs.existsSync(path.join(base, 'android', 'build.gradle'));
};
const nativeImports = [...imports].filter(needsAndroid);

// 3a. Classic RN-autolinked packages (react-native-*): from the SAME command
// the Expo gradle plugin calls to generate PackageList.java. This is the
// pre-gradle source of truth (the generated PackageList.java / autolinking.json
// only exist AFTER a gradle run, so we cannot rely on them at gate time).
let rnLinked = new Set();
try {
  const out = execSync('npx --no-install expo-modules-autolinking react-native-config --json --platform android', {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  const cfg = JSON.parse(out);
  for (const [name, info] of Object.entries(cfg.dependencies || {})) {
    if (info?.platforms?.android != null) rnLinked.add(name);
  }
} catch (e) {
  fail('could not run expo-modules-autolinking react-native-config: ' + e.message);
}

// 3b. Expo-autolinked modules: from `expo-modules-autolinking resolve`.
let expoLinked = new Set();
try {
  const out = execSync('npx --no-install expo-modules-autolinking resolve -p android --json', {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  const d = JSON.parse(out);
  for (const mod of d.modules || []) expoLinked.add(mod.packageName);
} catch (e) {
  fail('could not run expo-modules-autolinking resolve: ' + e.message);
}

// 4. Assert each imported native package is linked somewhere.
console.log('Imported native modules and their linkage:');
let allOk = true;
for (const pkg of nativeImports.sort()) {
  // An Expo-autolinked package resolves via expo-modules-autolinking; everything
  // else is a classic RN-autolinked package.
  const isExpo = expoLinked.has(pkg) || fs.existsSync(path.join(root, 'node_modules', pkg, 'expo-module.config.json'));
  let linked = false;
  let via = '';
  if (isExpo) {
    linked = expoLinked.has(pkg);
    via = 'expo-autolinking';
  } else {
    linked = rnLinked.has(pkg);
    via = 'RN autolinking';
  }
  // expo-router is JS-only (no native module of its own) — its native needs are
  // expo-asset/expo-font, checked below; skip its own linkage requirement.
  console.log(`  ${linked ? '✓' : '✗'} ${pkg}  [${via}]`);
  if (!linked) { allOk = false; fail(`${pkg} is imported but NOT in the linked module list`); }
}

// 5. Startup-critical Expo modules that expo/expo-router pull in at boot even if
// not directly imported. These are exactly what crashed before (ExpoAsset).
const bootCritical = ['expo-asset', 'expo-font'];
// Local Expo modules under ./modules are not in node_modules, so the import scan
// above cannot see them. The PDF renderer is one — require it explicitly.
bootCritical.push('pdf-page');
console.log('Boot-critical Expo modules (required by expo-router/asset registry):');
for (const pkg of bootCritical) {
  const present = expoLinked.has(pkg);
  console.log(`  ${present ? '✓' : '✗'} ${pkg}`);
  if (!present) { allOk = false; fail(`${pkg} is required at startup but NOT linked`); }
}

if (allOk && !process.exitCode) {
  console.log('\n✓ GATE PASSED — every imported + boot-critical native module is linked.');
} else {
  console.error('\n✗ GATE FAILED — a native module the app needs is missing from the build.');
  process.exit(1);
}
