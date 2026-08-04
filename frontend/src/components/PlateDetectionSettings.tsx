import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ScanSearch, Lock } from 'lucide-react';
import { api } from '../api/client';
import { Card, CardContent, CardHeader } from './Card';
import { useToast } from '../contexts/ToastContext';

type Provider = 'opencv' | 'ai';

/**
 * Global build-plate detection settings (#63).
 *
 * Mirrors the Obico block in FailureDetectionSettings: self-contained queries,
 * debounced auto-save, no explicit save button. Per-printer enablement stays on
 * `printers.plate_detection_enabled` — this card only picks WHICH detector runs.
 *
 * `..._from_env` response booleans mark a field as environment-managed, in
 * which case the input is disabled and read-only (same as ha_token_from_env).
 */
export function PlateDetectionSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [provider, setProvider] = useState<Provider>('opencv');
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [timeoutSeconds, setTimeoutSeconds] = useState(5);
  const [initialized, setInitialized] = useState(false);

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
  });

  useEffect(() => {
    if (!settings) return;
    setProvider(settings.plate_detection_provider === 'ai' ? 'ai' : 'opencv');
    setEndpoint(settings.plate_detection_ai_endpoint ?? '');
    setModel(settings.plate_detection_ai_model ?? '');
    setApiKey(settings.plate_detection_ai_api_key ?? '');
    setTimeoutSeconds(settings.plate_detection_ai_timeout ?? 5);
    setInitialized(true);
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.updateSettings({
        plate_detection_provider: provider,
        plate_detection_ai_endpoint: endpoint,
        plate_detection_ai_model: model,
        plate_detection_ai_api_key: apiKey,
        plate_detection_ai_timeout: timeoutSeconds,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      showToast(t('settings.toast.settingsSaved'));
    },
    onError: (error: Error) => showToast(error.message || t('common.unknownError'), 'error'),
  });

  // Auto-save on change (debounced), matching the Obico settings block.
  useEffect(() => {
    if (!initialized || !settings) return;
    // Compare against the same defaults the load effect applies, so a settings
    // payload that omits these fields does not look like a pending edit.
    const changed =
      (settings.plate_detection_provider === 'ai' ? 'ai' : 'opencv') !== provider ||
      (settings.plate_detection_ai_endpoint ?? '') !== endpoint ||
      (settings.plate_detection_ai_model ?? '') !== model ||
      (settings.plate_detection_ai_api_key ?? '') !== apiKey ||
      (settings.plate_detection_ai_timeout ?? 5) !== timeoutSeconds;
    if (!changed) return;
    const id = setTimeout(() => saveMutation.mutate(), 500);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, endpoint, model, apiKey, timeoutSeconds, initialized]);

  const endpointFromEnv = settings?.plate_detection_ai_endpoint_from_env ?? false;
  const modelFromEnv = settings?.plate_detection_ai_model_from_env ?? false;
  const apiKeyFromEnv = settings?.plate_detection_ai_api_key_from_env ?? false;

  const inputClass = (readOnly: boolean) =>
    `w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm ${
      readOnly ? 'opacity-60 cursor-not-allowed' : ''
    }`;

  const envLabel = (fromEnv: boolean) =>
    fromEnv ? (
      <span className="ml-2 text-xs text-bambu-green">{t('settings.environmentManagedLabel')}</span>
    ) : null;

  return (
    <Card id="card-plate-detection">
      <CardHeader>
        <div className="flex items-center gap-2">
          <ScanSearch className="w-5 h-5 text-bambu-green" />
          <h2 className="text-lg font-semibold text-white">{t('plateDetection.title')}</h2>
        </div>
        <p className="text-sm text-bambu-gray mt-2">{t('plateDetection.description')}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <label className="block text-sm text-bambu-gray mb-1" htmlFor="plate-detection-provider">
            {t('plateDetection.provider')}
          </label>
          <select
            id="plate-detection-provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as Provider)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm"
          >
            <option value="opencv">{t('plateDetection.providerOpencv')}</option>
            <option value="ai">{t('plateDetection.providerAi')}</option>
          </select>
          <p className="text-xs text-bambu-gray mt-1">{t('plateDetection.providerHint')}</p>
        </div>

        {provider === 'ai' && (
          <>
            <div>
              <label className="block text-sm text-bambu-gray mb-1" htmlFor="plate-detection-endpoint">
                {t('plateDetection.endpoint')}
                {envLabel(endpointFromEnv)}
              </label>
              <div className="relative">
                <input
                  id="plate-detection-endpoint"
                  type="text"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  disabled={endpointFromEnv}
                  className={inputClass(endpointFromEnv)}
                />
                {endpointFromEnv && <Lock className="absolute right-3 top-2.5 w-4 h-4 text-bambu-gray" />}
              </div>
              <p className="text-xs text-bambu-gray mt-1">
                {endpointFromEnv
                  ? t('plateDetection.envReadOnly', { var: 'PLATE_DETECTION_AI_ENDPOINT' })
                  : t('plateDetection.endpointHint')}
              </p>
            </div>

            <div>
              <label className="block text-sm text-bambu-gray mb-1" htmlFor="plate-detection-model">
                {t('plateDetection.model')}
                {envLabel(modelFromEnv)}
              </label>
              <div className="relative">
                <input
                  id="plate-detection-model"
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="gpt-4o-mini"
                  disabled={modelFromEnv}
                  className={inputClass(modelFromEnv)}
                />
                {modelFromEnv && <Lock className="absolute right-3 top-2.5 w-4 h-4 text-bambu-gray" />}
              </div>
              <p className="text-xs text-bambu-gray mt-1">
                {modelFromEnv
                  ? t('plateDetection.envReadOnly', { var: 'PLATE_DETECTION_AI_MODEL' })
                  : t('plateDetection.modelHint')}
              </p>
            </div>

            <div>
              <label className="block text-sm text-bambu-gray mb-1" htmlFor="plate-detection-api-key">
                {t('plateDetection.apiKey')}
                {envLabel(apiKeyFromEnv)}
              </label>
              <div className="relative">
                <input
                  id="plate-detection-api-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  disabled={apiKeyFromEnv}
                  className={inputClass(apiKeyFromEnv)}
                />
                {apiKeyFromEnv && <Lock className="absolute right-3 top-2.5 w-4 h-4 text-bambu-gray" />}
              </div>
              <p className="text-xs text-bambu-gray mt-1">
                {apiKeyFromEnv
                  ? t('plateDetection.envReadOnly', { var: 'PLATE_DETECTION_AI_API_KEY' })
                  : t('plateDetection.apiKeyHint')}
              </p>
            </div>

            <div>
              <label className="block text-sm text-bambu-gray mb-1" htmlFor="plate-detection-timeout">
                {t('plateDetection.timeout')}
              </label>
              <input
                id="plate-detection-timeout"
                type="number"
                value={timeoutSeconds}
                onChange={(e) => setTimeoutSeconds(Math.max(1, Math.min(9, Number(e.target.value) || 5)))}
                min={1}
                max={9}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm"
              />
              <p className="text-xs text-bambu-gray mt-1">{t('plateDetection.timeoutHint')}</p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
