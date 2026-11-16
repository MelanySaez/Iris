# DR1 All-Sky Cube fallback

When IRSA TAP discovery is unavailable, a job is now served in this order:

1. **IRSA TAP** (primary). Gives individual observations with dates.
2. **Indexed S3 L2 products** ([provider fallback](spherex-provider.md)). Still individual,
   dated observations, but only for regions already in the local index.
3. **DR1 All-Sky Cube tiles on S3** (this document). Used only when steps 1 and 2 give
   nothing. Covers the whole sky, but has **no temporal information**.

The fallback starts only on provider failures:

- timeouts, transport errors or HTTP 5xx;
- an attempt that exceeds its 45 s wall-clock budget, counting every result page
  (`DeadlineExceeded`);
- a TAP answer with no result table, for example `QUERY_STATUS=ERROR` (`TapServiceError`).
  On 2026-11-15, IRSA answered HTTP 200 with `UsageFault: BAD_REQUEST: Invalid or
  unsupported ADQL query string` to spatial queries that the app had sent unchanged,
  while trivial queries hung for more than 60 s. The query is built by the server, not
  supplied by the user, so this counts as a provider failure. The trace shows IRSA's
  message.

An empty but successful TAP answer still means "no coverage". A fallback result is never
cached as definitive discovery.

### Reusing a fallback

When TAP fails for a region and a fallback serves it, that result is kept in memory for
10 minutes (`FALLBACK_REUSE_SECONDS`). Another job for the same region — for example,
loading FLAGS after IMAGE — reuses it with a `provider_reuse` event instead of retrying TAP
and the fallbacks. Cube cutouts that were already built are read from the derived cache
without network access. Measured live: the FLAGS job finished in 0.2 s. `force_refresh`
skips the reuse.

## What the user sees

- The job finishes as `ready`. The `discovery` field has `coverage_state: "cube_fallback"`,
  `temporal_available: false` and a `fallback_notice`. `animation_reason` holds the same
  notice.
- `events` contains a `provider_fallback` event from `S3 DR1 All-Sky Cube`. When `variance`
  was requested, it also contains a `cube_no_variance` event.
- The plate shows a notice: IRSA TAP is unavailable; the cube combines every DR1
  observation from the tile's `DATE-BEG` to `DATE-END` into one image; there is **no
  temporal information**, so epochs, timeline comparison and animation are unavailable;
  there is no VARIANCE layer; and wavelengths are nominal and not calibrated.
- The timeline shows one chip, `DR1 All-Sky Cube (S3) · combined, no epochs`, and
  playback is disabled. The VARIANCE tab shows `n/a`.
- The notice and the stage warnings have a close button. A dismissed fallback notice
  leaves a chip that reopens it.

## Progress the user sees

Job status is shown inside the plate stage, in every state:

- While the job runs, the loading box shows the overall progress bar and percentage and
  the current step from `job.activity`:

  | `activity.kind` | Shown as |
  | --- | --- |
  | `discovery_attempt` | `IRSA TAP · attempt 1 of 2`, `12 s of 45 s max`, filling bar |
  | `retry_wait` | `Retrying IRSA TAP · attempt 2 of 2`, countdown to the next attempt |
  | `fallback` | `S3 DR1 All-Sky Cube · checking`, elapsed time, indeterminate bar |
  | `cube_read` | `Sky tiles for channel 44`, `3 of 8 sky tiles`, filling bar |

  The server sends `elapsed_seconds`. The page advances it between polls, so the bar
  keeps moving without depending on the browser clock.
- When the job is ready or has failed, a status chip in the top-right corner of the stage
  shows `Ready` or `Failed · <error kind>`.

## How a cutout is built

The tile key comes from the position, so no search is needed:
`dr1/hips5_cube/hips_20261026/Norder5/Dir{(n//10000)*10000}/Npix{n}_cube.fits`, where `n`
is the NESTED HEALPix order-5 index. Each tile holds `IMAGE` (MJy/sr), `NHITS` and
`FLAGS` as uncompressed 512×512×102 arrays, plus `SPECTRAL_CHANNELS` and `WCS-WAVE` tables.

For each requested channel:

1. The output grid is a north-up TAN grid centred on the region, at the native cube scale
   (12.88″/px, measured from the tile WCS). 180′ gives 839×839 pixels.
2. Each output pixel is assigned to its HEALPix tile. A region can span several tiles.
3. For each tile, the code reads its HDU headers once (cached as
   `data/cache/cube/layout-s3-5-{n}.json`). It then makes **one HTTP range per HDU**
   (IMAGE, FLAGS, NHITS), covering only that channel's plane and only the rows the region
   needs.
4. Pixels are sampled with nearest-neighbour. Wavelength and bandwidth come from the
   channel row of `SPECTRAL_CHANNELS`. Variance is all NaN.

`BLANKCH` channels, such as D3:17 and D4:01, are all-NaN in the cube. Their cutouts are
marked `blank_channel: true`.

Code: `app/services/cube_fallback.py`. It reuses the header walker in
`app/services/cube_spectrum.py`, with a separate S3 layout cache.

## Check it

From `apps/server`:

```bash
uv run --no-sync pytest tests/test_cube_fallback.py -q
RUN_SPHEREX_CUBE_LIVE=1 uv run --no-sync pytest tests/test_cube_fallback_live.py -q -s
```

The live test simulates TAP as down (HTTP 502) and the L2 index as empty, then runs a
real job against S3. Ordinary runs skip it.

## Observed results — 2026-11-15

| Check | Result |
| --- | --- |
| Cutout pixels vs. the existing IRSA cube spectrum reader, 3 off-centre pixels, channel 88 | Identical values |
| Cube channel centres vs. the app's channel windows (channels 20, 50, 88) | All inside the window |
| Live job, 4′, channels 20 and 88 | Ready; 19×19 px, 1 tile, 0.32 MB of rows, 2.1 s |
| Live job, 180′, channels 20 and 88 | Ready; 839×839 px, 8 tiles, 31.2 MB of rows, 19.5 s |

These are dated measurements on one network, not guarantees. A tile is ~321 MB; reading
whole tiles for the 180′ case would have meant ~2.6 GB.

## Limits

- **No temporal information.** The cube cannot show motion between observations, which is
  the core of moving-object detection. Only IRSA or indexed L2 products can.
- **No VARIANCE** and no flag bit definitions. Pixel probes return `variance: null`.
- **Exploratory values.** Wavelengths are nominal channel centres; IRSA describes cube
  spectra as quick-look, not forced photometry. Zodiacal light is not subtracted.
- **Resolution.** 12.88″/px versus ~6.2″/px in L2 images.
- **Tile reads run in parallel**, up to `CUBE_TILE_WORKERS = 4` tiles per channel. Channels
  are still read one after another.
- Synthetic cube products are not stored in the selection database, so a fallback never
  becomes recorded SPHEREx coverage.
