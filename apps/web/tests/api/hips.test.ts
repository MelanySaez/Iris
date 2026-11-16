import { describe, expect, it } from 'vitest';
import { channelByIndex, channelVirtualHipsUrl, imagePropertiesFromCube, parseChannels, remoteTilePath, VIRTUAL_HIPS_ROOT } from '../../src/api/hips';

const wavelengths = Array.from({ length: 102 }, (_, index) => (0.753 + index * 0.041).toFixed(3));
wavelengths[0] = '0.753';
wavelengths[62] = '3.293';
const fixture = [
  'dataproduct_type=cube',
  'hips_order=5',
  'hips_tile_width=512',
  'hips_tile_format=png',
  'hips_cube_depth=102',
  'hips_cube_firstframe=1',
  `data_cube_crval3_arr=${wavelengths.join(',')}`,
].join('\n');

describe('SPHEREx HiPS metadata', () => {
  it('keeps raw channel 62 on the adapter filename mapping', () => {
    expect(remoteTilePath(0, 0, 0, 62)).toBe('Norder0/Dir0/Npix0_62.png');
  });

  it('parses all real spectral planes except the two documented gaps', () => {
    const channels = parseChannels(fixture);
    expect(channels).toHaveLength(100);
    expect(channels.map(({ index }) => index)).not.toContain(50);
    expect(channels.map(({ index }) => index)).not.toContain(51);
    expect(channels.find(({ index }) => index === 0)?.wavelengthMicrometres).toBe(0.753);
    expect(channels.find(({ index }) => index === 62)?.wavelengthMicrometres).toBe(3.293);
  });

  it('looks up channel 62 by its raw spectral index after filtered gaps', () => {
    const channels = parseChannels(fixture);
    expect(channelByIndex(channels, 62)).toEqual({ index: 62, wavelengthMicrometres: 3.293 });
    expect(channels[62]).not.toEqual(channelByIndex(channels, 62));
  });

  it('builds distinct same-origin virtual HiPS roots and rejects invalid channels', () => {
    const channel0 = channelVirtualHipsUrl(0, 'https://app.example.test');
    const channel62 = channelVirtualHipsUrl(62, 'https://app.example.test');
    expect(channel0).toBe('https://app.example.test/spherex-virtual-hips/channel/0');
    expect(channel62).toBe('https://app.example.test/spherex-virtual-hips/channel/62');
    expect(channel0).not.toBe(channel62);
    expect(() => channelVirtualHipsUrl(50)).toThrow(/unavailable/);
    expect(() => channelVirtualHipsUrl(51)).toThrow(/unavailable/);
    expect(() => channelVirtualHipsUrl(102)).toThrow(/unavailable/);
  });

  it('fails closed if official wavelength metadata is missing or inconsistent', () => {
    expect(() => parseChannels('dataproduct_type=cube\nhips_cube_depth=102')).toThrow(/missing cube depth or wavelength/);
    expect(() => parseChannels('dataproduct_type=cube\nhips_cube_depth=2\ndata_cube_crval3_arr=1')).toThrow(/Expected 2 finite wavelengths/);
  });

  it('maps index zero to the observed unsuffixed file and other channels to suffixed files', () => {
    expect(remoteTilePath(0, 0, 0, 0)).toBe('Norder0/Dir0/Npix0.png');
    expect(remoteTilePath(0, 0, 0, 62)).toBe('Norder0/Dir0/Npix0_62.png');
    expect(() => remoteTilePath(0, 0, 0, 50)).toThrow(/blank/);
  });

  it('emits only image-compatible metadata and routes the virtual service locally', () => {
    const cubeProperties = `${fixture}\nhips_frame=equatorial\nhips_order_min=0\nhips_service_url=https://example.invalid/cube\ncustom_tile_format=fits-cube\ndata_cube_bunit3=um\ndata_cube_crval3=0.01`;
    const result = imagePropertiesFromCube(cubeProperties);
    expect(result).toContain('dataproduct_type=image');
    expect(result).toContain('hips_order=5');
    expect(result).toContain(`hips_service_url=${VIRTUAL_HIPS_ROOT}`);
    expect(result).not.toContain('example.invalid');
    expect(result).not.toContain('custom_tile_format');
    expect(result).not.toContain('hips_cube_');
    expect(result).not.toContain('data_cube_');
  });
});
