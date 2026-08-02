/**
 * `/slicer?file=42` (and `?archive=7`) — the desktop slicer page
 * (#15, step-5.3; spec §6/§7 step 5, mockup screen 2 "Proposed desktop layout").
 *
 * This is the integration ticket for step-5: it assembles `SlicerRail` (#13's
 * `ProcessSettingsEditor` under the preset triplet), `PlateStage` (#14) and the
 * action bar, and owns the state all three read. The pieces themselves know
 * nothing about each other — that is what let them be built in parallel — so
 * everything they need to agree on lives here.
 *
 * ## What this page owns
 *
 * The **selection**: presets (via `useSlicePresets`, the same hook `SliceModal`
 * consumes — preset logic is not re-derived here), the override diff, the
 * active plate, and the stage layout. It is assembled into one
 * `SliceSelection` per render, and *both* the slice request and the Print-now
 * gate are computed from that single object, so they cannot disagree about
 * what the user is currently looking at.
 *
 * ## Print now
 *
 * Enabled only while the last completed slice still matches the selection on
 * screen; the rule and the reasoning are in `sliceSelection.ts`. The page
 * records the fingerprint at dispatch time, keeps it with the job's result, and
 * compares against the live fingerprint on every render.
 *
 * ## Coexistence with SliceModal
 *
 * `SliceModal` stays reachable — the file grid's per-card Slice button still
 * opens it, and it remains the fallback until this page has been tested on real
 * hardware (spec §10). Only the *inspector panel's* Slice button routes here.
 * Both must produce the same request for the same selection;
 * `__tests__/pages/SlicerPage.test.tsx` pins that against the modal's real
 * dispatch rather than a copy of its body builder.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, FileQuestion } from 'lucide-react';
import {
  api,
  type PresetRef,
  type SliceArchiveResponse,
  type SliceResponse,
} from '../api/client';
import { useSliceJobTracker } from '../contexts/SliceJobTrackerContext';
import { useToast } from '../contexts/ToastContext';
import { useSlicePresets } from '../hooks/useSlicePresets';
import { PlateStage } from '../components/slicer/PlateStage';
import { SliceActionBar } from '../components/slicer/SliceActionBar';
import { SlicerRail } from '../components/slicer/SlicerRail';
import {
  applyTransformEdits,
  buildStagePlates,
  withTransformEdit,
  type PlateTransformEdits,
} from '../components/slicer/plateLayout';
import type { ObjectTransform } from '../types/plateStage';
import {
  resolveDefaults,
  sanitizeOverrides,
  type ProcessOverrides,
} from '../components/slicer/processFields';
import {
  buildSliceBody,
  isSelectionComplete,
  selectionFingerprint,
  type SliceSelection,
} from '../components/slicer/sliceSelection';
import { PrintModal } from '../components/PrintModal';
import type { PlateFilament } from '../types/plates';

type SourceKind = 'libraryFile' | 'archive';

/** A slice that finished, and the selection it was made from. */
interface CompletedSlice {
  fingerprint: string;
  printTimeSeconds: number | null;
  filamentGrams: number | null;
  /** What Print now hands to `PrintModal`. */
  target: { kind: 'libraryFile'; id: number; name: string } | { kind: 'archive'; id: number; name: string };
}

export function SlicerPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { trackJob } = useSliceJobTracker();
  const { showToast } = useToast();

  // Deep-linkable and refresh-proof: the source lives entirely in the URL, so
  // a reload, a bookmark and the browser Back button all behave without any
  // page-held navigation state.
  const fileParam = searchParams.get('file');
  const archiveParam = searchParams.get('archive');
  const source = useMemo<{ kind: SourceKind; id: number } | null>(() => {
    const fileId = Number(fileParam);
    if (fileParam != null && Number.isInteger(fileId) && fileId > 0) {
      return { kind: 'libraryFile', id: fileId };
    }
    const archiveId = Number(archiveParam);
    if (archiveParam != null && Number.isInteger(archiveId) && archiveId > 0) {
      return { kind: 'archive', id: archiveId };
    }
    return null;
  }, [fileParam, archiveParam]);

  const [overrides, setOverrides] = useState<ProcessOverrides>({});
  const [activePlate, setActivePlate] = useState(1);
  const [lastSlice, setLastSlice] = useState<CompletedSlice | null>(null);
  const [pendingJobId, setPendingJobId] = useState<number | null>(null);
  const [printOpen, setPrintOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Same query key as SliceModal's, so arriving here from the modal (or going
  // back to it) reuses the cached plate metadata instead of re-parsing the 3MF.
  const platesQuery = useQuery({
    queryKey: ['slicePlates', source?.kind, source?.id],
    queryFn: async () => {
      if (!source) throw new Error('no source');
      return source.kind === 'libraryFile'
        ? api.getLibraryFilePlates(source.id)
        : api.getArchivePlates(source.id);
    },
    enabled: source != null,
    staleTime: 60_000,
  });

  const filename = platesQuery.data?.filename ?? '';
  const platesMeta = useMemo(() => platesQuery.data?.plates ?? [], [platesQuery.data]);
  const isMultiPlate = !!platesQuery.data?.is_multi_plate && platesMeta.length > 1;

  // Saved arrangement (spec §4). Library files only — archives carry the same
  // column but expose no endpoint yet. Absent / null / wrong-version leaves
  // every object as designed, which `buildStagePlates` handles.
  const layoutQuery = useQuery({
    queryKey: ['libraryFileLayout', source?.id],
    queryFn: async () => api.getLibraryFileLayout(source!.id),
    enabled: source?.kind === 'libraryFile',
    staleTime: 60_000,
  });

  // What the gizmos have moved since the page loaded (#25). Held here, not in
  // `PlateStage`, because it has to reach `selection.plates` — that is what
  // makes a placement change invalidate a completed slice and disable Print
  // now. See the module header in `sliceSelection.ts`.
  const [transformEdits, setTransformEdits] = useState<PlateTransformEdits>({});

  // A different file is a different arrangement. Dropping the edits on the
  // source change rather than merging them stops one file's moves reappearing
  // on the next, which would be invisible until it was sliced.
  useEffect(() => {
    setTransformEdits({});
  }, [source?.kind, source?.id]);

  const basePlates = useMemo(
    () => buildStagePlates(platesMeta, layoutQuery.data?.layout ?? null),
    [platesMeta, layoutQuery.data],
  );
  const stagePlates = useMemo(
    () => applyTransformEdits(basePlates, transformEdits),
    [basePlates, transformEdits],
  );

  const handleTransformChange = useCallback(
    (plateIndex: number, objectId: string, transform: ObjectTransform) => {
      setTransformEdits((current) =>
        withTransformEdit(current, plateIndex, objectId, transform),
      );
    },
    [],
  );

  // `plate` mirrors SliceModal exactly: omitted for single-plate 3MFs, STLs and
  // anything whose metadata failed to load, so the backend's own default takes
  // over. Sending an explicit `1` there would be a *different* request.
  const platePayload = isMultiPlate ? activePlate : null;
  const effectivePlateId = isMultiPlate ? activePlate : 1;

  const filamentReqsQuery = useQuery({
    queryKey: ['sliceFilamentReqs', source?.kind, source?.id, effectivePlateId],
    queryFn: async () => {
      if (!source) throw new Error('no source');
      return source.kind === 'libraryFile'
        ? api.getLibraryFileFilamentRequirements(source.id, effectivePlateId)
        : api.getArchiveFilamentRequirements(source.id, effectivePlateId);
    },
    enabled: source != null && !platesQuery.isLoading,
    staleTime: 60_000,
  });

  // One synthetic slot for STL / "no metadata" so the rail still works as a
  // single dropdown, matching the modal's fallback.
  const filamentSlots = useMemo<PlateFilament[]>(() => {
    const reqs = filamentReqsQuery.data?.filaments ?? [];
    return reqs.length > 0
      ? (reqs as PlateFilament[])
      : [{ slot_id: 1, type: '', color: '', used_grams: 0, used_meters: 0 }];
  }, [filamentReqsQuery.data]);

  const {
    presets,
    isLoading: presetsLoading,
    isError: presetsError,
    isRefreshing,
    refreshPresets,
    printerPreset,
    setPrinterPreset,
    processPreset,
    setProcessPreset,
    filamentPresets,
    setFilamentPresetAt,
    bedType,
    setBedType,
    useEmbedded,
    setUseEmbedded,
    canUseEmbedded,
    selectedPrinterName,
    compatIndex,
  } = useSlicePresets({
    filamentSlots,
    embeddedPrinter: platesQuery.data?.embedded_printer ?? null,
    embeddedProcess: platesQuery.data?.embedded_process ?? null,
    enabled: source != null && !platesQuery.isLoading,
  });

  // Curated field metadata, filtered server-side to the keys the configured
  // slicer actually has. That filtering depends on the sidecar exposing
  // `GET /schema`; against an image without it the backend falls back to the
  // curated file's whole key list, and the rail will offer settings the slicer
  // does not have — the slice then 422s rather than silently ignoring them.
  const processFieldsQuery = useQuery({
    queryKey: ['slicerProcessFields'],
    queryFn: () => api.getProcessFields(),
    staleTime: 5 * 60_000,
  });

  // The preset's *real* current values, so an untouched control shows what the
  // print will do. Re-fetched per process preset — which is exactly why the
  // override diff has to be re-sanitised below when it changes.
  const resolvedProcessQuery = useQuery({
    queryKey: ['slicerResolvedProcess', processPreset?.source, processPreset?.id],
    queryFn: () => api.getResolvedProcess(processPreset as PresetRef),
    enabled: processPreset != null,
    staleTime: 60_000,
  });

  const processFields = useMemo(
    () => processFieldsQuery.data?.fields ?? [],
    [processFieldsQuery.data],
  );
  const resolvedProcess = resolvedProcessQuery.data ?? null;

  // Changing the process preset moves the resolved defaults under a diff the
  // user already typed, which can turn a real override into a no-op one. The
  // editor never *emits* a no-op, but it will happily render one it is handed,
  // and a no-op override would invalidate Print now for no reason at all. So
  // the diff is re-sanitised whenever the defaults move.
  useEffect(() => {
    if (processFields.length === 0) return;
    const defaults = resolveDefaults(processFields, resolvedProcess);
    setOverrides((current) => {
      const cleaned = sanitizeOverrides(current, defaults);
      const sameSize = Object.keys(cleaned).length === Object.keys(current).length;
      return sameSize ? current : cleaned;
    });
  }, [processFields, resolvedProcess]);

  // The single object both the request and the Print-now gate are derived from.
  const selection = useMemo<SliceSelection>(
    () => ({
      printerPreset,
      processPreset,
      filamentPresets,
      bedType,
      // Mirrors SliceModal: the flag is meaningless without the gate.
      useEmbedded: useEmbedded && canUseEmbedded,
      plate: platePayload,
      processOverrides: overrides,
      plates: stagePlates,
    }),
    [
      printerPreset,
      processPreset,
      filamentPresets,
      bedType,
      useEmbedded,
      canUseEmbedded,
      platePayload,
      overrides,
      stagePlates,
    ],
  );
  const fingerprint = selectionFingerprint(selection);

  const sliceMutation = useMutation({
    mutationFn: async () => {
      const body = buildSliceBody(selection);
      if (!source) throw new Error('no source');
      return source.kind === 'libraryFile'
        ? api.sliceLibraryFile(source.id, body)
        : api.sliceArchive(source.id, body);
    },
    onSuccess: (enqueued) => {
      // The existing tracker still owns the toasts, the progress ticker and
      // the failure modal; the page polls alongside it purely to learn *what
      // the slice produced*, which the tracker does not expose.
      trackJob(enqueued.job_id, source!.kind, filename || String(source!.id));
      setPendingJobId(enqueued.job_id);
    },
    onError: (err: unknown) => {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    },
  });

  // The fingerprint as it was when this job was dispatched. Captured at
  // dispatch, not at completion: the user is free to keep fiddling while the
  // slice runs, and the result describes the selection it *started* with.
  const [pendingFingerprint, setPendingFingerprint] = useState<string | null>(null);

  const jobQuery = useQuery({
    queryKey: ['sliceJob', pendingJobId],
    queryFn: () => api.getSliceJob(pendingJobId as number),
    enabled: pendingJobId != null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'completed' || status === 'failed' ? false : 1500;
    },
  });

  const jobState = jobQuery.data;
  useEffect(() => {
    if (!jobState || pendingJobId == null) return;
    if (jobState.status === 'failed') {
      // The tracker already raises the failure modal with the slicer's reason.
      setPendingJobId(null);
      setPendingFingerprint(null);
      return;
    }
    if (jobState.status !== 'completed') return;

    const result = jobState.result;
    setPendingJobId(null);
    if (result && pendingFingerprint != null) {
      const target =
        'library_file_id' in result
          ? ({ kind: 'libraryFile', id: (result as SliceResponse).library_file_id, name: result.name } as const)
          : ({ kind: 'archive', id: (result as SliceArchiveResponse).archive_id, name: result.name } as const);
      setLastSlice({
        fingerprint: pendingFingerprint,
        printTimeSeconds: result.print_time_seconds ?? null,
        filamentGrams: result.filament_used_g ?? null,
        target,
      });
    }
    setPendingFingerprint(null);
  }, [jobState, pendingJobId, pendingFingerprint]);

  const handleSlice = useCallback(() => {
    setErrorMessage(null);
    setPendingFingerprint(fingerprint);
    sliceMutation.mutate();
  }, [fingerprint, sliceMutation]);

  // **The rule.** Print now is live only while the completed slice still
  // describes what is on screen. Everything that can change the output is in
  // the fingerprint by construction — see `sliceSelection.ts`.
  const canPrintNow = lastSlice != null && lastSlice.fingerprint === fingerprint;

  const isSlicing = sliceMutation.isPending || pendingJobId != null;
  const canSlice =
    source != null && isSelectionComplete(selection) && filamentReqsQuery.isSuccess && !isSlicing;

  // Estimate: the last matching slice's real numbers when we have them, else
  // whatever the source's own plate metadata already knows (a re-sliced file
  // carries its previous print time). Never the two mixed.
  const activePlateMeta = platesMeta.find((plate) => plate.index === effectivePlateId) ?? null;
  const estimate = canPrintNow
    ? { printTimeSeconds: lastSlice.printTimeSeconds, filamentGrams: lastSlice.filamentGrams }
    : activePlateMeta
      ? {
          printTimeSeconds: activePlateMeta.print_time_seconds,
          filamentGrams: activePlateMeta.filament_used_grams,
        }
      : null;

  const contextLabel = [selectedPrinterName, bedType].filter(Boolean).join(' · ') || null;

  const handleBack = useCallback(() => {
    if (window.history.length > 1) navigate(-1);
    else navigate(source?.kind === 'archive' ? '/archives' : '/files');
  }, [navigate, source]);

  const modelUrl =
    source == null
      ? ''
      : source.kind === 'libraryFile'
        ? api.getLibraryFileDownloadUrl(source.id)
        : api.getArchiveDownload(source.id);

  if (source == null) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8 text-center text-bambu-gray">
        <FileQuestion className="h-8 w-8" />
        <p className="text-sm">{t('slicer.noSource')}</p>
        <button
          type="button"
          onClick={() => navigate('/files')}
          className="rounded-md border border-bambu-dark-tertiary px-3 py-1.5 text-sm text-bambu-gray transition-colors hover:border-bambu-gray hover:text-white"
        >
          {t('slicer.backToFiles')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100vh-64px)] flex-col gap-3 p-4 lg:h-[calc(100vh-64px)]">
      <header className="flex flex-shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={handleBack}
          className="inline-flex items-center gap-1.5 text-sm text-bambu-gray transition-colors hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('slicer.back')}
        </button>
        <h1 className="min-w-0 truncate text-sm font-medium text-white" title={filename}>
          {filename || t('slicer.title')}
        </h1>
      </header>

      {errorMessage && (
        <div
          role="alert"
          className="flex-shrink-0 rounded border border-red-900/40 bg-red-900/20 p-2 text-sm text-red-700 dark:text-red-400"
        >
          {errorMessage}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <SlicerRail
          className="w-full lg:w-80 lg:flex-shrink-0"
          presets={presets}
          presetsLoading={presetsLoading || platesQuery.isLoading}
          presetsError={presetsError}
          isRefreshing={isRefreshing}
          onRefreshPresets={refreshPresets}
          printerPreset={printerPreset}
          onPrinterPresetChange={setPrinterPreset}
          processPreset={processPreset}
          onProcessPresetChange={setProcessPreset}
          filamentPresets={filamentPresets}
          onFilamentPresetChange={setFilamentPresetAt}
          filamentSlots={filamentSlots}
          filamentSlotsLoading={filamentReqsQuery.isLoading}
          bedType={bedType}
          onBedTypeChange={setBedType}
          useEmbedded={useEmbedded}
          onUseEmbeddedChange={setUseEmbedded}
          canUseEmbedded={canUseEmbedded}
          selectedPrinterName={selectedPrinterName}
          compatIndex={compatIndex}
          processFields={processFields}
          resolvedProcess={resolvedProcess}
          processFieldsLoading={processFieldsQuery.isLoading}
          processFieldsError={
            processFieldsQuery.isError ? t('slicer.processFieldsFailed') : null
          }
          overrides={overrides}
          onOverridesChange={setOverrides}
          disabled={isSlicing}
        />

        <PlateStage
          className="min-h-[24rem] flex-1 overflow-hidden rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary lg:min-h-0"
          url={modelUrl}
          fileType={platesMeta.length > 0 ? '3mf' : undefined}
          plates={stagePlates}
          initialPlate={activePlate}
          onActivePlateChange={setActivePlate}
          onTransformChange={handleTransformChange}
          actionBar={
            <SliceActionBar
              estimate={estimate}
              contextLabel={contextLabel}
              onSlice={handleSlice}
              canSlice={canSlice}
              isSlicing={isSlicing}
              onPrintNow={() => setPrintOpen(true)}
              canPrintNow={canPrintNow}
              hasCompletedSlice={lastSlice != null}
              // The gizmos move objects (#25) but persisting the result is
              // #32: turning this on now would need the delta-to-absolute
              // conversion described in `PlateStage`'s header, and writing a
              // half-converted layout is worse than not writing one — the
              // save appears to succeed and the slice comes out wrong.
              canSaveLayout={false}
              saveLayoutHint={t('slicer.saveLayoutComingSoon')}
            />
          }
        />
      </div>

      {/* Print now hands the *produced* file to the existing PrintModal — the
          slice's output, not the source that was sliced. */}
      {printOpen && lastSlice && canPrintNow && (
        <PrintModal
          mode="create"
          archiveName={lastSlice.target.name}
          {...(lastSlice.target.kind === 'libraryFile'
            ? { libraryFileId: lastSlice.target.id }
            : { archiveId: lastSlice.target.id })}
          onClose={() => setPrintOpen(false)}
          onSuccess={() => {
            setPrintOpen(false);
            showToast(t('slicer.printQueued'), 'success');
          }}
        />
      )}
    </div>
  );
}
