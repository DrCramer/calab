const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const withAndroidIntentReset = require('./withAndroidIntentReset');

const mobileRoot = path.dirname(require.resolve('../package.json'));

const { addIntentReset, MARK } = withAndroidIntentReset;

/** Expo's installed native template, not a hand-written copy of it. */
function templateMainActivity() {
  const template = path.join(path.dirname(require.resolve('expo/package.json')), 'template.tgz');
  return execFileSync('tar', ['-xOzf', template, 'package/android/app/src/main/java/com/helloworld/MainActivity.kt'], { encoding: 'utf8' });
}

async function applyPlugin(contents) {
  const config = withAndroidIntentReset({ name: 'Calab', slug: 'calab' });
  const result = await config.mods.android.mainActivity({
    ...config,
    modResults: { path: 'MainActivity.kt', language: 'kt', contents },
    modRequest: { projectRoot: mobileRoot, platformProjectRoot: mobileRoot, platform: 'android', modName: 'mainActivity' },
  });
  return result.modResults.contents;
}

test('the generated MainActivity resets a replayed launch intent before React starts', async () => {
  const out = await applyPlugin(templateMainActivity());
  assert.match(out, /^import android\.content\.Intent$/m);
  const onCreate = out.slice(out.indexOf('override fun onCreate('));
  const reset = onCreate.indexOf('savedInstanceState != null || (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0');
  assert.ok(reset > 0, 'reset condition in onCreate');
  assert.ok(reset < onCreate.indexOf('super.onCreate('), 'reset runs before super.onCreate');
  assert.match(onCreate, /intent = Intent\(this, MainActivity::class\.java\)\.setAction\(Intent\.ACTION_MAIN\)\.addCategory\(Intent\.CATEGORY_LAUNCHER\)/);
  assert.match(out, /override fun onNewIntent\(intent: Intent\) \{\n {4}setIntent\(intent\)\n {4}super\.onNewIntent\(intent\)\n {2}\}\n\}\n$/);
  assert.equal(out.split(MARK).length - 1, 2, 'one reset, one onNewIntent');
});

test('a repeated prebuild changes nothing', async () => {
  const once = await applyPlugin(templateMainActivity());
  assert.equal(await applyPlugin(once), once);
});

test('an onNewIntent another plugin added gets setIntent instead of a second override', () => {
  const other = templateMainActivity().replace(/\}\s*$/, '  override fun onNewIntent(next: Intent?) {\n    super.onNewIntent(next)\n  }\n}\n');
  const out = addIntentReset(`import android.content.Intent\n${other}`);
  assert.equal(out.match(/fun onNewIntent\(/g).length, 1);
  assert.match(out, /override fun onNewIntent\(next: Intent\?\) \{\n {4}setIntent\(next\) \/\/ Calab: launch-intent reset\n {4}super\.onNewIntent\(next\)/);
});

test('a template without the onCreate anchor fails the prebuild', () => {
  assert.throws(() => addIntentReset('package x\nclass MainActivity : ReactActivity() {}\n'), /onCreate/);
});
