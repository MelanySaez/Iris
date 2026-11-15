/**
 * Featured objects in the Spectral Lab: five of the best-known objects in the
 * sky, so first-time visitors recognise them. Positions are SIMBAD's (ICRS).
 * Each was checked to have nearly all 102 channels in the All-Sky Cube: very
 * bright sources (e.g. Betelgeuse, the Orion Nebula core) saturate the detector
 * and come back with no valid channels, so they are left out.
 * Independent of the backend catalog, which Sky search and the assistant use.
 */
export interface LabFeaturedObject {
  id: string;
  /** Popular name, shown in bold and used as the spectrum label. */
  name: string;
  /** Catalogue name, shown underneath for those who know it. */
  catalogue: string;
  ra_deg: number;
  dec_deg: number;
  type: string;
}

export const LAB_FEATURED: LabFeaturedObject[] = [
  { id: 'm31', name: 'Andromeda Galaxy', catalogue: 'M31', ra_deg: 10.684708, dec_deg: 41.26875, type: 'Galaxy' },
  { id: 'm16', name: 'Eagle Nebula', catalogue: 'M16', ra_deg: 274.688, dec_deg: -13.792, type: 'Nebula' },
  { id: 'm45', name: 'Pleiades', catalogue: 'M45', ra_deg: 56.6008, dec_deg: 24.1139, type: 'Star cluster' },
  { id: 'm1', name: 'Crab Nebula', catalogue: 'M1', ra_deg: 83.6324, dec_deg: 22.0174, type: 'Supernova remnant' },
  { id: 'm51', name: 'Whirlpool Galaxy', catalogue: 'M51', ra_deg: 202.469575, dec_deg: 47.195258, type: 'Galaxy' },
];
