import type { Step } from 'react-joyride';

/**
 * The guided tour follows the demo path: find an object, read the map, change
 * the infrared channel, select a region, and know where the other workspaces
 * are. Steps point at `data-tour` anchors so styling changes cannot break them.
 * It is informative: no step waits for the visitor to perform an action.
 */
export const TOUR_STEPS: Array<Step & { id: string }> = [
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
    title: 'That’s it',
    content: 'You can take this tour again at any time from this button. Enjoy exploring.',
  },
];
