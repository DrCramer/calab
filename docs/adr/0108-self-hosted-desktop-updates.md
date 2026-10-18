# ADR-0108: Self-hosted desktop updates from GitHub Releases (2026-10-18)

## Context

The self-hosted Calab server is at `https://calab.cramerstation.ru`. Desktop updates should come
from the owner's GitHub project, without sending clients to the official Calab release feed. The
desktop updater already supports GitHub Releases and generic HTTPS feeds, but pins trusted update
sources into the app at build time; `settings.json` cannot redirect automatic installation.

## Decision

- Build the Windows client from the public fork `DrCramer/calab`; bake the fork into
  `MAIN_VITE_UPDATE_GITHUB` and its public `latest/download` URL into the generic-feed fallback.
- Keep the first-run app origin at `https://calab.cramerstation.ru`. Existing saved server origins
  and sessions remain untouched when the app updates in place.
- Build on a native `windows-latest` runner. A `win-vX.Y.Z` tag creates a draft GitHub Release
  named `vX.Y.Z` with the installer, blockmap, and `latest.yml`. Publish that draft only after the
  Windows smoke check; drafts are invisible to the updater.
- Keep the release repository public. Do not put a GitHub token in the client; private release
  access would require credentials on every user's computer.
- Use strictly increasing SemVer versions. Rollbacks are new releases with a higher version.
- Preserve the existing Calab app ID, licence, NOTICE, and third-party notices so the installer
  upgrades the current app and retains its profile.

## Consequences

- Existing installations need one manual install of the fork build; subsequent updates use the
  fork's published GitHub Releases.
- GitHub Actions builds Windows only. API/container releases remain a separate operation.
- Builds without a Windows code-signing certificate are unsigned and can show SmartScreen warnings.
- The generic fallback is also hosted under the fork's public release assets; no additional update
  web server or DNS record is needed.
