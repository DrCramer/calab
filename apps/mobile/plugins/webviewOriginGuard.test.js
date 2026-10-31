// The Android main-frame guard's origin check (CalabOriginGuard in
// patches/react-native-webview@13.16.1.patch) on a host JVM, against the cases navigation.test.ts
// gives the JS `isAppUrl`. Needs a JDK (`javac`): without one it fails, unless CALAB_SKIP_JVM_TESTS=1
// skips it explicitly (CI runners have a JDK).
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const process = require('node:process');
const { test } = require('node:test');

const GUARD = path.join(path.dirname(require.resolve('react-native-webview/package.json')),
  'android/src/main/java/com/reactnativecommunity/webview/CalabOriginGuard.java');
const ORIGIN = 'https://app.example.com';

const APP = [
  'https://app.example.com',
  'https://app.example.com/',
  'https://APP.example.com:443/invite/x?y=1#z',
  'https://app.example.com:0443/',
  'https://app.example.com:/t/CAL-1',
  // Characters Chromium leaves unencoded outside the authority; java.net.URI rejects them.
  'https://app.example.com/board?filter=a|b',
  'https://app.example.com/x#a^b',
  'https://app.example.com/{id}?q={x}',
  'https://app.example.com/a`b',
  'https://app.example.com/p@q?u=a@b#c@d',
];
const NOT_APP = [
  'https://app.example.com.evil.test/',
  'https://app.example.com@evil.test/',
  'https://app.example.com:443@evil.test/',
  'https://evil.test/?https://app.example.com',
  'https://evil.test/#https://app.example.com',
  'https://evilapp.example.com/',
  'https://app.example.co/',
  'https://sub.app.example.com/',
  'https://app.example.com:8443/',
  'https://app.example.com:65536/',
  'https://app.example.com:44a/',
  'https://app.example.com@evil.test/x|y',
  'https://evil.test/board?filter=a|b#https://app.example.com',
  'https://app.example.com./',
  'http://app.example.com/',
  'https://user:pw@app.example.com/',
  'https://user@app.example.com/',
  'about:blank',
  'blob:https://app.example.com/0b1c',
  'javascript:alert(1)',
  'data:text/html,x',
  'mailto:sales@example.com',
  'bank100000000111://qr.nspk.ru/x',
  'not a url',
  '',
];
const ORIGINS = {
  'https://app.example.com': 'https://app.example.com',
  'https://app.example.com:8443': 'https://app.example.com:8443',
  'https://app.example.com/': null,
  'https://app.example.com:443': null,
  'https://app.example.com:': null,
  'https://app.example.com:99999': null,
  'https://App.example.com': null,
  'http://app.example.com': null,
  'https://u@app.example.com': null,
  'https://app.example.com/x': null,
  '': null,
};

const HARNESS = `
import com.reactnativecommunity.webview.CalabOriginGuard;
public class Harness {
  public static void main(String[] args) {
    String mode = args[0];
    for (int i = 1; i < args.length; i++) {
      System.out.println(mode.equals("origin") ? String.valueOf(CalabOriginGuard.parseOrigin(args[i])) : String.valueOf(CalabOriginGuard.isAppUrl(args[i], CalabOriginGuard.parseOrigin("${ORIGIN}"))));
    }
  }
}
`;

const skip = process.env.CALAB_SKIP_JVM_TESTS === '1' && 'CALAB_SKIP_JVM_TESTS=1';

test('CalabOriginGuard matches the JS origin policy', { skip }, (t) => {
  assert.equal(spawnSync('javac', ['-version']).status, 0, 'javac is required (CALAB_SKIP_JVM_TESTS=1 skips this test)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calab-origin-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'Harness.java'), HARNESS);
  execFileSync('javac', ['-d', dir, GUARD, path.join(dir, 'Harness.java')]);
  const run = (mode, values) => execFileSync('java', ['-cp', dir, 'Harness', mode, ...values], { encoding: 'utf8' }).split('\n').slice(0, values.length);

  assert.deepEqual(run('url', APP), APP.map(() => 'true'), 'app documents load');
  assert.deepEqual(run('url', NOT_APP), NOT_APP.map(() => 'false'), 'everything else is refused');
  assert.deepEqual(run('origin', Object.keys(ORIGINS)), Object.values(ORIGINS).map(String), 'only a canonical origin configures the guard');
});
