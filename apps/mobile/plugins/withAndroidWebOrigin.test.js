const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const withAndroidWebOrigin = require('./withAndroidWebOrigin');

const mobileRoot = path.dirname(require.resolve('../package.json'));

const manifest = () => ({
  manifest: { $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' }, application: [{ $: { 'android:name': '.MainApplication' }, 'meta-data': [] }] },
});

async function applyPlugin(origin, modResults = manifest()) {
  const config = withAndroidWebOrigin({ name: 'Calab', slug: 'calab' }, { origin });
  const result = await config.mods.android.manifest({
    ...config,
    modResults,
    modRequest: { projectRoot: mobileRoot, platformProjectRoot: mobileRoot, platform: 'android', modName: 'manifest' },
  });
  return result.modResults;
}

const originEntries = (modResults) => modResults.manifest.application[0]['meta-data']
  .filter((item) => item.$['android:name'] === withAndroidWebOrigin.META_DATA);

test('the manifest carries the web origin once', async () => {
  const once = await applyPlugin('https://app.example.com');
  assert.deepEqual(originEntries(once).map((item) => item.$['android:value']), ['https://app.example.com']);
  const twice = await applyPlugin('https://app.example.com:8443', once);
  assert.deepEqual(originEntries(twice).map((item) => item.$['android:value']), ['https://app.example.com:8443']);
});

test('no origin or a non-canonical one fails the Android prebuild', async () => {
  await assert.rejects(applyPlugin(null), /required/);
  await assert.rejects(applyPlugin(undefined), /required/);
  await assert.rejects(applyPlugin('http://app.example.com'), /https/);
  await assert.rejects(applyPlugin('https://app.example.com/'), /not a canonical origin/);
  await assert.rejects(applyPlugin('https://app.example.com/path'), /bare origin/);
});
