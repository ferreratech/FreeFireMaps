import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  return {
    ...config,
    name: 'FreeFireMaps',
    slug: 'freefiremaps',
    version: '0.1.0',
    orientation: 'default',
    userInterfaceStyle: 'automatic',
    scheme: 'firemap',
    // Icons are rendered from assets/icon-source.js (SVG -> PNG via sharp).
    icon: './assets/icon.png',
    splash: {
      backgroundColor: '#0F1115',
    },
    assetBundlePatterns: ['**/*'],
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'com.firemap.viewer',
      infoPlist: {
        NSLocationWhenInUseUsageDescription:
          'Show your GPS position on the loaded fire map.',
      },
    },
    android: {
      package: 'com.firemap.viewer',
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#0F1115',
      },
      permissions: [
        'ACCESS_FINE_LOCATION',
        'ACCESS_COARSE_LOCATION',
        'READ_EXTERNAL_STORAGE',
      ],
      // "Open with FireMap" for any PDF (Files, Drive, email, browser downloads).
      intentFilters: [
        {
          action: 'VIEW',
          category: ['DEFAULT', 'BROWSABLE'],
          data: [{ scheme: 'content', mimeType: 'application/pdf' }, { scheme: 'file', mimeType: 'application/pdf' }],
        },
      ],
    },
    plugins: [
      'expo-router',
      'expo-asset',
      'expo-font',
      [
        'expo-location',
        {
          locationWhenInUsePermission:
            'Show your GPS position on the loaded fire map.',
        },
      ],
      'expo-document-picker',
    ],
    experiments: {
      typedRoutes: false,
    },
  };
};
