/**
 * Per-slice process override editor (slicer UX redesign, ticket #13 —
 * step-5.1; mockup screen 2, the left rail of the desktop layout).
 *
 * Standalone by design: props in, override diff out. It fetches nothing,
 * knows nothing about the slicer page, routing, presets or slice jobs, and
 * holds no state the caller cannot see. That is what lets the desktop rail
 * (#15) and the mobile wizard's Settings step (#11) mount the *same*
 * component and differ only in `className`.
 *
 * ## The rule
 *
 * `onOverridesChange` is only ever handed a diff of fields that genuinely
 * differ from their resolved default. Set a value back to what the preset
 * says and the key is **removed**, not written back as a no-op. A no-op
 * override reaches the slicer as a real patch on the resolved process JSON,
 * invalidates "Print now" for no reason, and makes two identical slices look
 * like different ones. The logic lives in `processFields.ts::nextOverrides`
 * so it can be tested without a DOM.
 *
 * ## Where the values come from
 *
 * `fields` is `GET /slicer/process-fields` — curated metadata already
 * filtered to the keys the configured slicer actually has. `resolvedProcess`
 * is `GET /slicer/resolved-process`, the preset's real current values, so an
 * untouched control shows what the print will do rather than a curated
 * default that would silently propose a change on every field at once.
 *
 * The caller does both fetches. Neither belongs in a component that the
 * wizard mounts inside an already-loaded page.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw, Search, SlidersHorizontal } from 'lucide-react';
import {
  APPROX_TOTAL_SLICER_SETTINGS,
  categoriesOf,
  clampToRange,
  filterFields,
  formatNumber,
  nextOverrides,
  overriddenKeys,
  resolveDefaults,
} from './processFields';
import type { ProcessField, ProcessFieldValue, ProcessOverrides, ResolvedProcess } from './processFields';

export interface ProcessSettingsEditorProps {
  /** Curated fields from `GET /slicer/process-fields` (`.fields`). */
  fields: ProcessField[];
  /**
   * Resolved process JSON from `GET /slicer/resolved-process`, or `null`
   * while it loads / for the `standard` tier, whose values only exist on the
   * sidecar. With `null` every control starts empty and any entry is an
   * override — which is the honest reading, not a degraded one.
   */
  resolvedProcess?: ResolvedProcess | null;
  /** The current diff. Controlled: the caller owns it. */
  overrides: ProcessOverrides;
  /**
   * The new diff, whenever it changes. Contains only genuinely-changed
   * fields; never a key whose value equals its resolved default. Keys the
   * caller put in `overrides` for fields not in `fields` pass through
   * untouched.
   */
  onOverridesChange: (overrides: ProcessOverrides) => void;
  /** Disables every control (e.g. while a slice is in flight). */
  disabled?: boolean;
  /** Renders the loading state instead of the field list. */
  isLoading?: boolean;
  /** Renders in place of the field list when the metadata fetch failed. */
  error?: string | null;
  /** Layout hook for the mount point (desktop rail vs wizard step). */
  className?: string;
  /**
   * Render the "Print settings" title row.
   *
   * Off when the rail wraps this editor in its own collapsible section (#46),
   * whose header carries the same title and the same icon. Everything below
   * the title — the subset note, the tier chips, the search box, the category
   * chips and the scrolling field list — is unaffected: the section adds a
   * header, it does not take the editor's own controls away.
   */
  showHeading?: boolean;
}

const CHIP = 'px-2 py-0.5 rounded-full text-xs transition-colors whitespace-nowrap';

export function ProcessSettingsEditor({
  fields,
  resolvedProcess = null,
  overrides,
  onOverridesChange,
  disabled = false,
  isLoading = false,
  error = null,
  className = '',
  showHeading = true,
}: ProcessSettingsEditorProps) {
  const { t } = useTranslation();
  const [tier, setTier] = useState<'basic' | 'advanced'>('basic');
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Uncommitted text for number inputs. Committing on blur/Enter rather than
  // per keystroke is what makes clamping usable: clamping mid-type would
  // rewrite "1" to the max before the user reaches "0.15".
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const defaults = useMemo(() => resolveDefaults(fields, resolvedProcess), [fields, resolvedProcess]);
  const categories = useMemo(() => categoriesOf(fields), [fields]);
  const changed = useMemo(() => new Set(overriddenKeys(fields, overrides, defaults)), [fields, overrides, defaults]);
  const visible = useMemo(() => filterFields(fields, { tier, category, query }), [fields, tier, category, query]);

  const categoryLabel = (name: string) =>
    t(`slice.settingsEditor.categories.${name}`, { defaultValue: name });

  const commit = (key: string, value: ProcessFieldValue | undefined) => {
    setDrafts((current) => {
      if (!(key in current)) return current;
      const rest = { ...current };
      delete rest[key];
      return rest;
    });
    onOverridesChange(nextOverrides(overrides, defaults, key, value));
  };

  const resetAll = () => {
    const remaining = { ...overrides };
    for (const field of fields) delete remaining[field.key];
    setDrafts({});
    onOverridesChange(remaining);
  };

  /** The value a control shows: the override if there is one, else the preset's. */
  const valueOf = (field: ProcessField): ProcessFieldValue | null =>
    field.key in overrides ? overrides[field.key] : defaults[field.key];

  const commitNumber = (field: ProcessField, text: string) => {
    const trimmed = text.trim();
    // Cleared means "back to the preset value", not "zero".
    if (trimmed === '') {
      commit(field.key, undefined);
      return;
    }
    const parsed = Number(trimmed.replace(/%$/, ''));
    if (!Number.isFinite(parsed)) {
      // Defensive. `<input type="number">` reports '' for anything it cannot
      // parse, so this is unreachable today — it exists so that swapping in a
      // text input cannot start emitting NaN as an override.
      commit(field.key, field.key in overrides ? overrides[field.key] : undefined);
      return;
    }
    commit(field.key, clampToRange(field, parsed));
  };

  const renderControl = (field: ProcessField) => {
    const id = `process-field-${field.key}`;
    const value = valueOf(field);
    const common = 'bg-bambu-dark border border-bambu-dark-tertiary rounded text-white text-xs ' +
      'focus:outline-none focus:border-bambu-green disabled:opacity-50';

    if (field.type === 'boolean') {
      return (
        <input
          id={id}
          type="checkbox"
          disabled={disabled}
          checked={value === true}
          onChange={(event) => commit(field.key, event.target.checked)}
          className="w-4 h-4 accent-bambu-green cursor-pointer disabled:cursor-not-allowed"
        />
      );
    }

    if (field.type === 'select') {
      return (
        <select
          id={id}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => commit(field.key, event.target.value === '' ? undefined : event.target.value)}
          className={`${common} px-1.5 py-1 w-28`}
        >
          {value === null && <option value="">{t('slice.settingsEditor.unset')}</option>}
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    }

    const shown = field.key in drafts
      ? drafts[field.key]
      : typeof value === 'number'
        ? formatNumber(value)
        : '';
    return (
      <div className="flex items-center gap-1">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          disabled={disabled}
          value={shown}
          min={field.min}
          max={field.max}
          step={field.step}
          onChange={(event) => setDrafts((current) => ({ ...current, [field.key]: event.target.value }))}
          onBlur={(event) => commitNumber(field, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitNumber(field, (event.target as HTMLInputElement).value);
            }
          }}
          className={`${common} px-1.5 py-1 w-20 text-right`}
        />
        {field.unit && <span className="text-[10px] text-bambu-gray w-5">{field.unit}</span>}
      </div>
    );
  };

  const body = () => {
    if (isLoading) {
      return <p className="text-xs text-bambu-gray py-4 text-center">{t('slice.settingsEditor.loading')}</p>;
    }
    if (error) {
      return <p className="text-xs text-red-400 py-4 text-center">{error}</p>;
    }
    if (fields.length === 0) {
      return <p className="text-xs text-bambu-gray py-4 text-center">{t('slice.settingsEditor.noFields')}</p>;
    }
    if (visible.length === 0) {
      return <p className="text-xs text-bambu-gray py-4 text-center">{t('slice.settingsEditor.noResults')}</p>;
    }

    // Group under the category heading, so a search across categories stays
    // readable and the chips and the headings say the same thing.
    const groups = new Map<string, ProcessField[]>();
    for (const field of visible) {
      const bucket = groups.get(field.category);
      if (bucket) bucket.push(field);
      else groups.set(field.category, [field]);
    }

    return [...groups.entries()].map(([name, group]) => (
      <div key={name} className="mb-3">
        <h4 className="text-[10px] uppercase tracking-wide text-bambu-gray mb-1">{categoryLabel(name)}</h4>
        {group.map((field) => {
          const isChanged = changed.has(field.key);
          const preset = defaults[field.key];
          return (
            <div
              key={field.key}
              data-testid={`process-field-row-${field.key}`}
              data-overridden={isChanged ? 'true' : 'false'}
              className={`flex items-center gap-2 py-1 px-1 rounded ${isChanged ? 'bg-amber-500/10' : ''}`}
            >
              {/* Amber dot — the mockup's marker for an overridden field. */}
              <span
                aria-hidden="true"
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${isChanged ? 'bg-amber-400' : 'bg-transparent'}`}
              />
              <label
                htmlFor={`process-field-${field.key}`}
                title={field.description ?? field.key}
                className="flex-1 min-w-0 truncate text-xs text-bambu-gray-light cursor-pointer"
              >
                {field.label}
              </label>
              {isChanged && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => commit(field.key, undefined)}
                  title={
                    preset === null
                      ? t('slice.settingsEditor.revertField')
                      : t('slice.settingsEditor.revertFieldTo', { value: String(preset) })
                  }
                  aria-label={t('slice.settingsEditor.revertFieldAria', { field: field.label })}
                  className="text-bambu-gray hover:text-white shrink-0"
                >
                  <RotateCcw className="w-3 h-3" />
                </button>
              )}
              {renderControl(field)}
            </div>
          );
        })}
      </div>
    ));
  };

  return (
    <div className={`flex flex-col min-h-0 ${className}`} data-testid="process-settings-editor">
      {showHeading && (
        <div className="flex items-center gap-2 mb-1">
          <SlidersHorizontal className="w-3.5 h-3.5 text-bambu-green shrink-0" aria-hidden="true" />
          <h3 className="text-xs font-semibold text-white">{t('slice.settingsEditor.title')}</h3>
        </div>
      )}
      {/* Says out loud that this is a curated subset — the editor must not
          read as "all the slicer's settings". */}
      <p className="text-[10px] text-bambu-gray mb-2">
        {t('slice.settingsEditor.subsetNote', {
          shown: fields.length,
          total: APPROX_TOTAL_SLICER_SETTINGS,
        })}
      </p>

      <div className="flex gap-1 mb-2" role="group" aria-label={t('slice.settingsEditor.tierLabel')}>
        {(['basic', 'advanced'] as const).map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={tier === name}
            onClick={() => setTier(name)}
            className={`${CHIP} flex-1 ${
              tier === name ? 'bg-bambu-green text-white' : 'bg-bambu-dark text-bambu-gray hover:text-white'
            }`}
          >
            {t(`slice.settingsEditor.tier.${name}`)}
          </button>
        ))}
      </div>

      <div className="relative mb-2">
        <Search className="w-3 h-3 text-bambu-gray absolute left-2 top-1/2 -translate-y-1/2" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t('slice.settingsEditor.searchLabel')}
          placeholder={t('slice.settingsEditor.searchPlaceholder', { total: fields.length })}
          className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded pl-7 pr-2 py-1 text-xs
            text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green"
        />
      </div>

      <div className="flex flex-wrap gap-1 mb-2">
        <button
          type="button"
          aria-pressed={category === null}
          onClick={() => setCategory(null)}
          className={`${CHIP} ${
            category === null ? 'bg-bambu-dark-tertiary text-white' : 'bg-bambu-dark text-bambu-gray hover:text-white'
          }`}
        >
          {t('slice.settingsEditor.allCategories')}
        </button>
        {categories.map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={category === name}
            onClick={() => setCategory((current) => (current === name ? null : name))}
            className={`${CHIP} ${
              category === name ? 'bg-bambu-dark-tertiary text-white' : 'bg-bambu-dark text-bambu-gray hover:text-white'
            }`}
          >
            {categoryLabel(name)}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pr-1">{body()}</div>

      <div className="flex items-center justify-between gap-2 pt-2 mt-1 border-t border-bambu-dark-tertiary text-[10px]">
        <span className={changed.size > 0 ? 'text-amber-400' : 'text-bambu-gray'} data-testid="override-count">
          {changed.size > 0
            ? t('slice.settingsEditor.overrideCount', { changed: changed.size })
            : t('slice.settingsEditor.noOverrides')}
        </span>
        <button
          type="button"
          disabled={disabled || changed.size === 0}
          onClick={resetAll}
          title={t('slice.settingsEditor.resetTitle')}
          className="text-bambu-green hover:text-bambu-green-light disabled:opacity-40 disabled:hover:text-bambu-green"
        >
          {t('slice.settingsEditor.reset')}
        </button>
      </div>
    </div>
  );
}
