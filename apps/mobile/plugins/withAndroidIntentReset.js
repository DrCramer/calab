// A link that launched the app opens once (ADR-0142, DEV-5032). Android keeps the launch intent
// as the task's base intent and hands it to MainActivity again whenever it recreates the activity:
// after the process died in the background (state restore, savedInstanceState != null) and when it
// is relaunched from Recents (FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY). React Native's
// `Linking.getInitialURL()` reads `getIntent()`, so the shell would open that link again. In those
// two cases the intent is replaced with a plain launcher intent before React starts; a real launch
// (a tapped link, the launcher icon on a fresh task) keeps its intent. A link that arrives while the
// activity lives (singleTask, `onNewIntent`) becomes the current intent, as Android recommends, so
// `getIntent()` never shows an older one; React Native still delivers it as a `url` event.
const { withMainActivity } = require('expo/config-plugins');

const MARK = 'Calab: launch-intent reset';

const ON_CREATE = /(override fun onCreate\(savedInstanceState: Bundle\?\) \{\n)/;
const RESET = `    // ${MARK} (plugins/withAndroidIntentReset.js): a recreated activity must not replay its launch link.
    if (savedInstanceState != null || (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) {
      intent = Intent(this, MainActivity::class.java).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
    }
`;
const EXISTING_ON_NEW_INTENT = /(override fun onNewIntent\((\w+): Intent\??\) \{\n)/;
const ON_NEW_INTENT = `
  // ${MARK}: the current intent is the newest link, never an older one.
  override fun onNewIntent(intent: Intent) {
    setIntent(intent)
    super.onNewIntent(intent)
  }
`;

/** MainActivity.kt with the reset, idempotent. Throws if the template no longer has the anchors. */
function addIntentReset(contents) {
  if (contents.includes(MARK)) return contents;
  if (!ON_CREATE.test(contents)) throw new Error('withAndroidIntentReset: MainActivity.onCreate(savedInstanceState: Bundle?) not found');
  let out = contents.replace(ON_CREATE, `$1${RESET}`);
  if (!/^import android\.content\.Intent$/m.test(out)) out = out.replace(/^(package [^\n]+\n)/, '$1\nimport android.content.Intent\n');
  // Another plugin's onNewIntent gets the setIntent line; otherwise the override is added.
  if (EXISTING_ON_NEW_INTENT.test(out)) return out.replace(EXISTING_ON_NEW_INTENT, `$1    setIntent($2) // ${MARK}\n`);
  if (/fun onNewIntent\(/.test(out)) throw new Error('withAndroidIntentReset: unrecognised MainActivity.onNewIntent');
  const end = out.lastIndexOf('}');
  return `${out.slice(0, end).replace(/\s*$/, '\n')}${ON_NEW_INTENT}}\n`;
}

module.exports = (config) => withMainActivity(config, (mod) => {
  if (mod.modResults.language !== 'kt') throw new Error('withAndroidIntentReset: expected a Kotlin MainActivity');
  mod.modResults.contents = addIntentReset(mod.modResults.contents);
  return mod;
});

module.exports.addIntentReset = addIntentReset;
module.exports.MARK = MARK;
