import type { Step } from 'react-joyride';

/** One guided tour per workspace; the "?" button runs the one for the current tab. */
export type TourId = 'sky' | 'plate' | 'spectral' | 'records';

type TourStep = Step & { id: string };

/**
 * Sky follows the demo path: find an object, read the map, change the infrared
 * channel, select a region, and know where the other workspaces are. The other
 * tours stay short and only cover their own tab. Steps point at `data-tour`
 * anchors so styling changes cannot break them, and a step whose anchor is not
 * on screen is skipped (see GuidedTour). No step waits for the visitor to act.
 */
const SKY: TourStep[] = [
  {
    id: 'welcome',
    target: 'body',
    placement: 'center',
    title: 'Welcome to Iris',
    content:
      'Iris lets you explore the whole sky as NASA’s SPHEREx sees it: in infrared light, across 102 spectral channels. This short tour shows you where everything is.',
  },
  {
    id: 'search',
    target: '[data-tour="search"]',
    placement: 'right',
    title: 'Find an object',
    content:
      'Type a name or catalogue code, such as M31, NGC 224 or Betelgeuse. Iris looks it up in SIMBAD and NED, and Enter takes you there.',
  },
  {
    id: 'map',
    target: '[data-tour="map"]',
    placement: 'center',
    title: 'The infrared sky',
    content: 'Drag to move across the sky and scroll to zoom. This is the SPHEREx all-sky map.',
  },
  {
    id: 'nearby',
    target: '[data-tour="map"]',
    placement: 'center',
    title: 'Search around any point',
    content:
      'Right-click anywhere on the sky to pin that position, then choose “Search nearby catalogs” to list the objects within half a degree in the catalog layers you have turned on.',
  },
  {
    id: 'channels',
    target: '[data-tour="channels"]',
    placement: 'top',
    title: 'Change the wavelength',
    content:
      'Slide across the channels from 0.75 to 5 µm to see how the sky changes in infrared, or switch to RGB composite to blend three channels.',
  },
  {
    id: 'region',
    target: '[data-tour="region-tool"]',
    placement: 'left',
    title: 'Select a region',
    content:
      'Pick this tool and drag a box on the map. From a selected region you can open its spectral plate or plot its spectrum.',
  },
  {
    id: 'workspaces',
    target: '[data-tour="workspaces"]',
    placement: 'bottom',
    title: 'Your workspaces',
    content:
      'Sky is the map. Plate shows the detector images of a selected region. Spectral Lab compares spectra. Records keeps your saved selections.',
  },
  {
    id: 'replay',
    target: '[data-tour="tour-help"]',
    placement: 'bottom-end',
    title: 'One guide per tab',
    content:
      'Each tab has its own guide: open any tab and press this button to see how it works. You can also replay this one at any time.',
  },
];

const PLATE: TourStep[] = [
  {
    id: 'plate-intro',
    target: 'body',
    placement: 'center',
    title: 'The spectral plate',
    content:
      'Plate shows the images SPHEREx’s detector took of the region you selected in Sky, so you can inspect them pixel by pixel.',
  },
  {
    id: 'plate-record',
    target: '[data-tour="plate-record"]',
    placement: 'right',
    title: 'Plate record',
    content:
      'The region, the detector cutout and where the data comes from. Wavelengths here are approximate (WCS-WAVE), not calibrated.',
  },
  {
    id: 'plate-image',
    target: '[data-tour="plate-image"]',
    placement: 'bottom',
    title: 'Detector image',
    content:
      'Switch between Image, Variance and Flags, see the full detector or a single channel slice, change the stretch, and zoom or drag the image.',
  },
  {
    id: 'plate-epochs',
    target: '[data-tour="plate-epochs"]',
    placement: 'top',
    title: 'Observation dates',
    content: 'When SPHEREx observed this region more than once, pick a date here to compare epochs.',
  },
  {
    id: 'plate-channels',
    target: '[data-tour="plate-channels"]',
    placement: 'left',
    title: 'Spectral channels',
    content: 'Pick a channel to see the image at that wavelength. The ↑ and ↓ arrow keys step through them.',
  },
  {
    id: 'plate-readout',
    target: '[data-tour="plate-readout"]',
    placement: 'left',
    title: 'Pixel readout',
    content: 'Hover the image to read a pixel’s wavelength and flux; click to pin it.',
  },
];

const SPECTRAL: TourStep[] = [
  {
    id: 'lab-add',
    target: '[data-tour="lab-add"]',
    placement: 'right',
    title: 'Add a spectrum',
    content:
      'Pick one of the featured objects or enter RA and Dec in degrees. Each spectrum is the brightness of one point across the 102 channels.',
  },
  {
    id: 'lab-compare',
    target: '[data-tour="lab-compare"]',
    placement: 'right',
    title: 'Compare up to 8',
    content: 'Every spectrum you add appears here with its colour. Hide one to compare the rest, or remove it.',
  },
  {
    id: 'lab-axis',
    target: '[data-tour="lab-axis"]',
    placement: 'bottom',
    title: 'Linear or log',
    content: 'Switch the brightness axis to log to compare faint and bright objects on the same chart.',
  },
  {
    id: 'lab-chart',
    target: '[data-tour="lab-chart"]',
    placement: 'top',
    title: 'Read the chart',
    content: 'Hover for the value of each channel, scroll to zoom and drag to move around.',
  },
  {
    id: 'lab-sidebar',
    target: '[data-tour="lab-sidebar"]',
    placement: 'right',
    title: 'More room',
    content: 'Hide the side panel to give the chart the whole width; show it again from the same button.',
  },
];

const RECORDS: TourStep[] = [
  {
    id: 'records-intro',
    target: '[data-tour="records-intro"]',
    placement: 'bottom',
    title: 'Your saved selections',
    content: 'Every region you confirm in Sky is saved here automatically, on this browser.',
  },
  {
    id: 'records-consent',
    target: '[data-tour="records-consent"]',
    placement: 'bottom',
    title: 'Cookies first',
    content: 'Records needs a cookie to know which selections are yours. Accept it to start saving.',
  },
  {
    id: 'records-table',
    target: '[data-tour="records-table"]',
    placement: 'top',
    title: 'Each selection',
    content: 'Click a name to rename it. The table shows the region, channels and whether its data is ready.',
  },
  {
    id: 'records-actions',
    target: '[data-tour="records-actions"]',
    placement: 'left',
    title: 'Go back to it',
    content: 'Show in Sky rebuilds the selection on the map, Open takes you to its plate, and Delete removes it.',
  },
];

export const TOURS: Record<TourId, TourStep[]> = {
  sky: SKY,
  plate: PLATE,
  spectral: SPECTRAL,
  records: RECORDS,
};

/** Tour for the workspace on screen; the landing page leads into Sky. */
export function tourForRoute(routeType: TourId | 'landing'): TourId {
  return routeType === 'landing' ? 'sky' : routeType;
}
