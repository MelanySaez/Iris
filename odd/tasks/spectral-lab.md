Objective: Spectral Lab quick-look spectra (102 channels) sampled from the SPHEREx DR1 All-Sky Cube `fits-cube` HiPS tiles, with multi-object comparison.
Branch: `feat/spectral-lab` · Delivery: ask-on-risk · Runners: `uv run pytest -q` (apps/server), `pnpm test --run` + `pnpm typecheck` (apps/web, via `npx -y pnpm@12.11.2`).

## Specs

- S1 — Backend endpoint returns the 102-channel spectrum for one sky coordinate (RA/Dec, ICRS deg) read from the order-5 `Npix{n}_cube.fits` tile (`IMAGE` in MJy/sr, plus `NHITS` and `FLAGS` per channel), using HTTP byte-range reads instead of downloading the ~320 MB tile. Each point carries channel, detector, wavelength_um, bandwidth_um, value (null when NaN), nhits, flags. Payload is labelled quick-look / not calibrated photometry (`docs/MVP.md:110`: "dejando explícito que no es un espectro fotométrico científico de fuente"). Invalid coordinates are rejected with 422; upstream failure returns 502, never fabricated values.
- S2 — Results and tile headers are cached on disk under `apps/server/data/cache/` so repeated requests do not hit IRSA again.
- S3 — Frontend "Spectral Lab" workspace (route `#/spectral`) plots wavelength (µm) vs surface brightness (MJy/sr) for one or more spectra, lets the user add spectra from the curated catalog or typed RA/Dec, toggle and remove them, and compare them overlaid ("Comparación de espectros", Spectral Lab mockup image). Quick-look disclaimer visible.
- S4 — Out of scope for this feature (later): band selector, RGB multiband composite, SPHEREx Spectrophotometry Tool integration (option B).

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S1, S2 | inline | pending | |
| T2 | S3 | inline | pending | |

## Log

- L1 (2026-11-14) User request: "ambas" (explain LVF + build the missing spectral profile chart), then confirmed option C: "¿Arranco con C — perfil de un punto del cielo + comparación de varios objetos?" → "si". Context image: Spectral Lab = "Selector de bandas. Visualización espectral. Comparación de espectros. Composición RGB multibanda."
- L2 Evidence: cube properties `custom_tile_format = fits-cube`, tile path `Norder5/Dir{d}/Npix{n}/Npix{n}_cube.fits`, 320,909,760 bytes, `Accept-Ranges: bytes`. HDUs: IMAGE (float32 512×512×102, MJy/sr, data_off 8640), NHITS (int32), FLAGS (int32), SPECTRAL_CHANNELS (bintable), WCS-WAVE (bintable). Celestial WCS is HPX; spectral axis WAVE-TAB must be stripped before `astropy.wcs.WCS`. Multipart range of 102×4 bytes returned 206 in ~1.1 s. M81 (148.888, 69.065) → tile 1901, pixel (349, 472), ~83–104 MJy/sr.
- L3 Baseline: backend 11 failed / 15 passed (all failures need the absent local FITS `data/level2_*.fits`); web 66/66 passed.
