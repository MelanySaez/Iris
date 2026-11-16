import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../src/api/api';
import type { JobCreateRequest, RegionRequest } from '../../src/types/types';

describe('api client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls getHealth with GET /api/health', async () => {
    const mockHealth = {
      status: 'ok',
      version: '0.2.0',
      products: ['DR1 All-Sky Cube HiPS'],
      network: 'configured',
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockHealth,
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.getHealth();
    expect(result).toEqual(mockHealth);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/health',
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: 'application/json' }),
      }),
    );
  });

  it('calls getCatalog with GET /api/catalog', async () => {
    const mockCatalog = {
      objects: [
        {
          id: 'm101-field',
          name: 'M101 field',
          ra_deg: 210.80227,
          dec_deg: 54.34895,
          type: 'Galaxy field',
          default_size_arcmin: 6,
        },
      ],
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockCatalog,
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await api.getCatalog();
    expect(res).toEqual(mockCatalog);
    expect(fetchMock).toHaveBeenCalledWith('/api/catalog', expect.anything());
  });

  it('calls resolveRegion with POST /api/regions/resolve and correct JSON body', async () => {
    const regionReq: RegionRequest = {
      ra_deg: 210.80227,
      dec_deg: 54.34895,
      size_arcmin: 6,
    };
    const mockResponse = {
      region: { ...regionReq, fov_deg: 0.1 },
      coverage: 'available',
      cached: false,
      query_ms: 250,
      warning: null,
      products: [],
      detectors: [],
      notes: [],
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await api.resolveRegion(regionReq);
    expect(res).toEqual(mockResponse);
    expect(fetchMock).toHaveBeenCalledWith('/api/regions/resolve', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(regionReq),
    });
  });

  it('calls createJob with POST /api/jobs and correct payload structure', async () => {
    const jobReq: JobCreateRequest = {
      ra_deg: 210.80227,
      dec_deg: 54.34895,
      size_arcmin: 6,
      channels: [44],
      products: ['image'],
      mode: 'latest',
      stretch: 'asinh',
    };

    const mockJobSnapshot = {
      id: 'job-12345',
      status: 'queued',
      progress: 0,
      stage: 'Queued',
      error: null,
      request: jobReq,
      region: { ra_deg: 210.80227, dec_deg: 54.34895, size_arcmin: 6, fov_deg: 0.1 },
      channels: [],
      products: ['image'],
      frames: [],
      cutouts: [],
      cache: { hit: false },
      wavelength_status: 'wcs_wave_approximate',
      calibrated: false,
      multi_product_mosaic: 'pending',
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockJobSnapshot,
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await api.createJob(jobReq);
    expect(res.id).toBe('job-12345');
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(jobReq),
    });
  });

  it('builds frame URLs with query parameters correctly', () => {
    const url1 = api.getFrameUrl('job-abc', 44, 'image');
    expect(url1).toBe('/api/jobs/job-abc/frames/44/image.png');

    const url2 = api.getFrameUrl('job-abc', 44, 'image', {
      mode: 'slice',
      epoch: 1,
      stretch: 'linear',
    });
    expect(url2).toBe('/api/jobs/job-abc/frames/44/image.png?mode=slice&epoch=1&stretch=linear');

    const flagUrl = api.getFrameUrl('job-abc', 44, 'flags', {
      bit: 21,
    });
    expect(flagUrl).toBe('/api/jobs/job-abc/frames/44/flags.png?bit=21');
  });

  it('surfaces backend string detail on HTTP errors', async () => {
    const errorDetail = 'This region exceeds the 30-arcmin single-FITS limit; multi-file mosaicking is pending.';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      json: async () => ({ detail: errorDetail }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.createJob({
      ra_deg: 0,
      dec_deg: 0,
      size_arcmin: 45,
      channels: [44],
      products: ['image'],
    })).rejects.toThrowError(errorDetail);

    try {
      await api.createJob({
        ra_deg: 0,
        dec_deg: 0,
        size_arcmin: 45,
        channels: [44],
        products: ['image'],
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(422);
      expect(apiErr.detail).toBe(errorDetail);
      expect(apiErr.message).toBe(errorDetail);
    }
  });

  it('surfaces Pydantic validation list errors in detail message', async () => {
    const pydanticErrors = [
      { loc: ['body', 'size_arcmin'], msg: 'Input should be less than or equal to 30' },
    ];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      json: async () => ({ detail: pydanticErrors }),
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await api.resolveRegion({ ra_deg: 0, dec_deg: 0, size_arcmin: 50 });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(422);
      expect(apiErr.detail).toContain('size_arcmin');
      expect(apiErr.detail).toContain('Input should be less than or equal to 30');
    }
  });

  it('falls back to status text when error body is not JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => {
        throw new Error('Not JSON');
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await api.getChannels();
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(502);
      expect(apiErr.message).toContain('HTTP 502 Bad Gateway');
      expect(apiErr.detail).toBeUndefined();
    }
  });

  it('lists saved selections with limit and cursor', async () => {
    const body = { items: [], next_before: null };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.listSelections({ limit: 20, before: '2026-11-14T10:00:00Z' });
    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/selections?limit=20&before=2026-11-14T10%3A00%3A00Z',
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: 'application/json' }),
      }),
    );
  });

  it('lists saved selections without query when no params are given', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [], next_before: null }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await api.listSelections();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/selections');
  });

  it('deletes a selection with DELETE and accepts an empty 204 body', async () => {
    const json = vi.fn().mockRejectedValue(new SyntaxError('Unexpected end of JSON input'));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, json });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.deleteSelection('abc-123')).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/selections/abc-123',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('renames a selection with a PATCH and returns the updated record', async () => {
    const updated = { id: 'abc-123', name: 'M101 core' };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => updated });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.renameSelection('abc-123', 'M101 core')).resolves.toEqual(updated);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/selections/abc-123',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: 'M101 core' }),
      }),
    );
  });

  it('sends assistant chat turns and reads its logs', async () => {
    const reply = { conversation_id: 'c', request_id: 'r', reply: 'Hi', actions: [], cached: false, cache_kind: null };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => reply })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    const body = { conversation_id: 'c', messages: [{ role: 'user' as const, content: 'hi' }], context: { workspace: 'sky' as const } };
    await expect(api.assistantChat(body)).resolves.toEqual(reply);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/assistant/chat',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }),
    );

    await api.assistantLogs({ limit: 50, conversationId: 'abc' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/assistant/logs?limit=50&conversation_id=abc');
  });

  it('surfaces the 503 detail when selection storage is disabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({ detail: 'Selection records are disabled: set DATABASE_URL on the server.' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.listSelections()).rejects.toMatchObject({
      status: 503,
      detail: 'Selection records are disabled: set DATABASE_URL on the server.',
    });
  });
});
