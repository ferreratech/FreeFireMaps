// Expo Router treats every incoming URL as a route. A PDF handed to us via
// "Open with FireMap" (content:// or file://) is not a route — it is a file.
// Send the router home; app/index.tsx reads the raw URL itself via expo-linking.
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  return path === '/' ? path : '/';
}
