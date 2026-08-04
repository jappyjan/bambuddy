/**
 * Tests for the global build-plate detection settings card (#63).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { PlateDetectionSettings } from '../../components/PlateDetectionSettings';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const baseSettings = {
  plate_detection_provider: 'opencv',
  plate_detection_ai_endpoint: '',
  plate_detection_ai_model: '',
  plate_detection_ai_api_key: '',
  plate_detection_ai_timeout: 5,
  plate_detection_ai_endpoint_from_env: false,
  plate_detection_ai_model_from_env: false,
  plate_detection_ai_api_key_from_env: false,
};

describe('PlateDetectionSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    server.use(http.get('/api/v1/settings/', () => HttpResponse.json(baseSettings)));
  });

  it('defaults to OpenCV and keeps the AI fields hidden', async () => {
    render(<PlateDetectionSettings />);

    const select = (await screen.findByLabelText(/Detection method/i)) as HTMLSelectElement;
    expect(select.value).toBe('opencv');
    expect(screen.queryByLabelText(/Endpoint base URL/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/API key/i)).not.toBeInTheDocument();
  });

  it('reveals the AI fields and saves the provider when "ai" is selected', async () => {
    const saved: Record<string, unknown>[] = [];
    server.use(
      http.put('/api/v1/settings/', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        saved.push(body);
        return HttpResponse.json({ ...baseSettings, ...body });
      }),
    );
    render(<PlateDetectionSettings />);

    const select = await screen.findByLabelText(/Detection method/i);
    await userEvent.selectOptions(select, 'ai');

    expect(await screen.findByLabelText(/Endpoint base URL/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Model$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/API key/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Timeout/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(saved.length).toBeGreaterThan(0);
    });
    expect(saved[saved.length - 1].plate_detection_provider).toBe('ai');
  });

  it('renders env-managed fields as read-only', async () => {
    server.use(
      http.get('/api/v1/settings/', () =>
        HttpResponse.json({
          ...baseSettings,
          plate_detection_provider: 'ai',
          plate_detection_ai_api_key: 'sk-from-env',
          plate_detection_ai_api_key_from_env: true,
        }),
      ),
    );
    render(<PlateDetectionSettings />);

    const apiKey = (await screen.findByLabelText(/API key/i)) as HTMLInputElement;
    expect(apiKey).toBeDisabled();
    expect(screen.getByText(/PLATE_DETECTION_AI_API_KEY/)).toBeInTheDocument();

    // Fields without the env flag stay editable.
    expect(await screen.findByLabelText(/Endpoint base URL/i)).not.toBeDisabled();
  });

  it('clamps the timeout to the backend-enforced 1-9s range', async () => {
    const saved: Record<string, unknown>[] = [];
    server.use(
      http.get('/api/v1/settings/', () =>
        HttpResponse.json({ ...baseSettings, plate_detection_provider: 'ai' }),
      ),
      http.put('/api/v1/settings/', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        saved.push(body);
        return HttpResponse.json({ ...baseSettings, ...body });
      }),
    );
    render(<PlateDetectionSettings />);

    const timeout = await screen.findByLabelText(/Timeout/i);
    await userEvent.clear(timeout);
    await userEvent.type(timeout, '30');

    await waitFor(() => {
      expect(saved.length).toBeGreaterThan(0);
    });
    expect(saved[saved.length - 1].plate_detection_ai_timeout).toBe(9);
  });
});
