# Self-host 4.25.2 upgrade (revision 1)

Update the DrCramer/calab fork and deployed API/web from 4.23.0 to published
upstream 4.25.2 (d748cbe71c7a8b07378dbb3bc46ac526818447e3).

Preserve preset wire IDs, quality order, permission and plan enforcement,
first-run server URL and fork update feed, site upload limits, secrets,
volumes, attribution and licences. Adopt upstream recording and media logic
with its existing feature gate, authentication and permissions. Append upstream
migration 156 as 158 without changing any applied migration.

Use the isolated release checkout and a versioned runtime. Run generation,
protocol/media checks, full fork CI and Windows install/start smoke. Rehearse
migration on a restored database and compare with a fresh schema. Take final
database, file and configuration backups, replace API/web only, and check
public API, assets, gateway and LiveKit control. Publish verified Windows
installer and feed on DrCramer/calab. The previous image and matching database
backup support rollback before new writes. Live recordings and physical Windows
media are outside the automated smoke. No bot announcement, per owner preference.
