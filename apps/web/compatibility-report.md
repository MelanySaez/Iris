# SPHEREx HiPS and Aladin Lite compatibility report

## Verdict: GO CON RECORTE

The PoC meets its core acceptance through the channel-specific PNG image-HiPS adapter: Chrome loaded authentic channel 0 and 62 tiles, showed a measurable sky change, supported ICRS navigation and rectangular region selection, and did not download a FITS cube. **Native Aladin cube slicing FAILS for this dataset** and is disabled: raw index 0 mapped to `_50.png` (404), while raw index 62 mapped to `_8.png` (200), rather than the required SPHEREx files. The adapter is the supported path; this is not evidence that native Aladin cube slicing is compatible.

## Browser evidence (Chrome / CDP)

| Claim | Status | Observed evidence |
| --- | --- | --- |
| Channel 0 authentic PNG display | PASS | UI telemetry recorded official IRSA `Npix0.png`: HTTP 200, `image/png`, 89,673 bytes. |
| Selector switch from channel 0 to 62 uses a distinct adapter root | PASS | Selecting 62 loaded `/channel/62/properties` and 12 `/channel/62/...png` requests; all 12 tile requests returned HTTP 200. |
| Channel 62 authentic PNG display and changed sky | PASS | UI telemetry recorded the authentic IRSA `_62.png` tile: `image/png`, 28,085 bytes. The sampled sky crop changed with RMSE 6.16% between channels 0 and 62. |
| Pan, zoom, and ICRS center | PASS | A real pan changed the center from `0.00000°, 0.00000°` to `18.01091°, 4.02178°`. A real wheel zoom changed FOV from `180.0° × 126.5°` to `35.06° × 24.64°`. |
| Rectangular region selection | PASS | A real drag returned four ICRS sky-coordinate vertices. |
| Full FITS cube avoided | PASS | No full FITS cube was downloaded. The virtual `Moc.fits` requests returned 404. The earlier native test fetched only an 8,640-byte MOC footprint, not a cube. |
| Native Aladin cube slicing for SPHEREx raw indices | FAIL | Raw 0 requested `_50.png` (HTTP 404); raw 62 requested `_8.png` (HTTP 200), not `Npix0.png` and `Npix0_62.png`. The PoC removes native cube activation and uses the adapter. |
| Aladin Lite logger request | WARNING | Aladin Lite 3.8.1 attempted `alasky.unistra.fr/cgi/AladinLiteLogger/log.py`; the request failed and produced one third-party unhandled `TypeError: Failed to fetch`. It did not block tile loading, navigation, or region selection. |

## Source and adapter evidence

| Claim | Status | Evidence |
| --- | --- | --- |
| Official source is a 102-plane PNG HiPS cube | PASS | Live IRSA `properties` reported `dataproduct_type=cube`, order 0–5, tile width 512, PNG format, cube depth 102, and first frame 1. The direct HTTP probe returned 200, `text/plain`, 3,504 bytes, and `Access-Control-Allow-Origin: *`. |
| Live wavelengths and valid channels | PASS | The live `data_cube_crval3_arr` parsed to 100 valid channels, excluding blank indices 50 and 51; raw 0 is 0.753 µm and raw 62 is 3.293 µm. |
| Official order-0 tile paths | PASS | Direct probes observed `Npix0.png` (HTTP 200, `image/png`, 89,673 bytes, 512×512) and `Npix0_62.png` (HTTP 200, `image/png`, 84,624 bytes, 512×512). |
| Adapter routes the real selector to authentic tiles | PASS | The Service Worker uses channel-specific same-origin virtual roots and maps raw 0 to the unsuffixed file and raw 62 to `_62.png`; Chrome observed channel-specific properties and tile requests. |
| CORS evidence | PASS with distinction | Direct official IRSA probes exposed `Access-Control-Allow-Origin: *`. The Service Worker telemetry UI cannot expose the upstream CORS response header and correctly displays `not observed`; it does not claim to measure that header in-browser. |
| Firefly cube support | Context only | Firefly documentation demonstrates cube indexing, but it is not used as evidence for Aladin compatibility. |

## Verification

- `npm run test -- --run` — PASS; 3 files, 12 tests.
- `npm run typecheck` — PASS.
- `npm run build` — PASS; Vite emitted its large-chunk advisory (about 2.63 MB JavaScript / 914.89 kB gzip).
- `npm install` — previously completed for the pinned `aladin-lite@3.8.1`; npm reported 3 advisories (1 moderate, 2 critical), not remediated here.
- Git and commit evidence — unavailable; this environment exposes no valid worktree. No Git operations were run.

## Scope and remaining hardening

Temporal search, blink comparison, and individual spectral-image processing remain out of scope. Fixed-stretch PNG display is not science-grade photometry. Native cube slicing is not supported; the verified PNG adapter is the compatibility path for this PoC. Optional follow-up: investigate the non-blocking Aladin logger failure, reduce or split the Aladin bundle, and assess the npm advisories.
