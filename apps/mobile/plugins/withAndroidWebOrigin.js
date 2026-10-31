// The app origin for the native main-frame guard of the patched react-native-webview (ADR-0067,
// patches/react-native-webview@13.16.1.patch, CalabOriginGuard). It reaches native code only here:
// a manifest <meta-data> the patched RNCWebViewClient reads once. The value is `webOrigin` of
// app.config.ts (the one App.tsx loads), passed as `{ origin }`. No origin fails the Android
// prebuild: without it the guard would refuse every navigation. Other platforms are unaffected.
const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');
const { parseWebOrigin } = require('../src/config');

const META_DATA = 'dev.calab.mobile.WEB_ORIGIN';

module.exports = (config, { origin } = {}) => withAndroidManifest(config, (mod) => {
  if (!origin) throw new Error('withAndroidWebOrigin: EXPO_PUBLIC_CALAB_URL is required for the Android build');
  // Already canonical in app.config.ts; checked again so a wrong prop cannot reach the manifest.
  if (parseWebOrigin(origin) !== origin) throw new Error(`withAndroidWebOrigin: ${JSON.stringify(origin)} is not a canonical origin`);
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
  AndroidConfig.Manifest.addMetaDataItemToMainApplication(application, META_DATA, origin);
  return mod;
});

module.exports.META_DATA = META_DATA;
