/**
 * Tests for ProcessSettingsEditor (slicer UX redesign, ticket #13 — step-5.1).
 *
 * The bulk of this file is about one rule: **the emitted diff contains only
 * fields that genuinely changed, and nothing at all for a field set back to
 * its resolved default.** A no-op override is patched into the resolved
 * process JSON like any other, so it reaches the slicer as a real change,
 * invalidates "Print now" for no reason, and makes two identical slices look
 * different. Every path back to the default is covered separately —
 * retyping, re-selecting, un-toggling, the per-field revert, Reset — because
 * they are five different call sites into the same guarantee.
 *
 * Number entry uses `fireEvent.change` + `fireEvent.blur` rather than
 * `userEvent.type`: jsdom sanitises `<input type="number">` on every
 * keystroke, so typing "0.28" one character at a time is not a faithful
 * model of a browser and would test jsdom rather than the component. Clicks,
 * selects and checkboxes use `userEvent`.
 */

import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { ProcessSettingsEditor } from '../../components/slicer/ProcessSettingsEditor';
import {
  nextOverrides,
  parseResolvedValue,
  sanitizeOverrides,
  valuesEqual,
} from '../../components/slicer/processFields';
import type {
  ProcessField,
  ProcessOverrides,
  ResolvedProcess,
} from '../../components/slicer/processFields';

/**
 * Fields copied in shape from `backend/app/data/process_fields.json`.
 * `default_acceleration` is deliberately outside `BASIC_FIELD_KEYS` so the
 * tier filter has something to hide.
 */
const FIELDS: ProcessField[] = [
  {
    key: 'layer_height',
    label: 'Layer Height',
    type: 'number',
    category: 'quality',
    description: 'Height of each printed layer',
    unit: 'mm',
    step: 0.01,
    min: 0.04,
    max: 0.6,
  },
  {
    key: 'sparse_infill_density',
    label: 'Infill Density',
    type: 'number',
    category: 'infill',
    description: 'Percentage of sparse infill',
    unit: '%',
    step: 1,
    min: 0,
    max: 100,
  },
  {
    key: 'sparse_infill_pattern',
    label: 'Infill Pattern',
    type: 'select',
    category: 'infill',
    description: 'Pattern for sparse infill',
    options: [
      { value: 'grid', label: 'Grid' },
      { value: 'gyroid', label: 'Gyroid' },
      { value: 'cubic', label: 'Cubic' },
    ],
  },
  {
    key: 'enable_support',
    label: 'Enable Support',
    type: 'boolean',
    category: 'support',
    description: 'Generate support material',
  },
  {
    key: 'default_acceleration',
    label: 'Normal Printing Acceleration',
    type: 'number',
    category: 'acceleration',
    description: 'Default acceleration',
    unit: 'mm/s²',
    step: 100,
    min: 100,
    max: 20000,
  },
];

/**
 * A resolved profile spells everything as a string, and per-extruder keys as
 * a list of strings. `default_acceleration` is a list here on purpose.
 */
const RESOLVED: ResolvedProcess = {
  layer_height: '0.2',
  sparse_infill_density: '20%',
  sparse_infill_pattern: 'grid',
  enable_support: '0',
  default_acceleration: ['6000'],
  // A key with no curated field — must be ignored, not rendered.
  print_sequence: 'by layer',
};

const onChange = vi.fn();

/** Controlled wrapper: the component owns no override state, the caller does. */
function Harness({
  fields = FIELDS,
  resolvedProcess = RESOLVED,
  initial = {} as ProcessOverrides,
}: {
  fields?: ProcessField[];
  resolvedProcess?: ResolvedProcess | null;
  initial?: ProcessOverrides;
}) {
  const [overrides, setOverrides] = useState<ProcessOverrides>(initial);
  return (
    <ProcessSettingsEditor
      fields={fields}
      resolvedProcess={resolvedProcess}
      overrides={overrides}
      onOverridesChange={(next) => {
        onChange(next);
        setOverrides(next);
      }}
    />
  );
}

/** The most recent diff the component emitted. */
function lastDiff(): ProcessOverrides {
  expect(onChange).toHaveBeenCalled();
  return onChange.mock.calls[onChange.mock.calls.length - 1][0] as ProcessOverrides;
}

/** Type into a number field and commit it the way a blur does. */
function enterNumber(label: string, value: string) {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
  return input as HTMLInputElement;
}

function isMarked(key: string): boolean {
  return screen.getByTestId(`process-field-row-${key}`).getAttribute('data-overridden') === 'true';
}

/** Switch to the Advanced tier so the whole field list is on screen. */
async function showAll(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Advanced' }));
}

beforeEach(() => {
  onChange.mockClear();
});

describe('ProcessSettingsEditor — resolved values', () => {
  it('prefills controls from the resolved process, not from curated defaults', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await showAll(user);

    expect((screen.getByLabelText('Layer Height') as HTMLInputElement).value).toBe('0.2');
    // '20%' in the profile is 20 in a percent-unit number control.
    expect((screen.getByLabelText('Infill Density') as HTMLInputElement).value).toBe('20');
    expect((screen.getByLabelText('Infill Pattern') as HTMLSelectElement).value).toBe('grid');
    // '0' is the profile's spelling of false.
    expect((screen.getByLabelText('Enable Support') as HTMLInputElement).checked).toBe(false);
    // A per-extruder list resolves to its first entry.
    expect((screen.getByLabelText('Normal Printing Acceleration') as HTMLInputElement).value).toBe('6000');
  });

  it('renders nothing for a resolved key with no curated field', () => {
    render(<Harness />);
    expect(screen.queryByLabelText(/print_sequence/i)).toBeNull();
    expect(screen.queryByText('by layer')).toBeNull();
  });

  it('starts every control empty when the resolved process is unavailable', () => {
    render(<Harness resolvedProcess={null} />);
    expect((screen.getByLabelText('Layer Height') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('override-count')).toHaveTextContent('Preset values');
  });

  it('says out loud that it covers only a curated subset', () => {
    render(<Harness />);
    expect(screen.getByText(/5 curated settings/)).toBeInTheDocument();
    expect(screen.getByText(/545\+/)).toBeInTheDocument();
    expect(screen.getByText(/not the full list/)).toBeInTheDocument();
  });
});

describe('ProcessSettingsEditor — override diff', () => {
  it('emits only the field that changed', () => {
    render(<Harness />);
    enterNumber('Layer Height', '0.28');

    expect(lastDiff()).toEqual({ layer_height: 0.28 });
    expect(isMarked('layer_height')).toBe(true);
    expect(screen.getByTestId('override-count')).toHaveTextContent('1 changed');
  });

  it('emits NOTHING for a value typed back to the resolved default', () => {
    render(<Harness />);

    enterNumber('Layer Height', '0.28');
    expect(lastDiff()).toEqual({ layer_height: 0.28 });

    enterNumber('Layer Height', '0.2');

    // The key is gone, not present-and-equal. This is the whole ticket.
    expect(lastDiff()).toEqual({});
    expect(lastDiff()).not.toHaveProperty('layer_height');
    expect(isMarked('layer_height')).toBe(false);
    expect(screen.getByTestId('override-count')).toHaveTextContent('Preset values');
  });

  it('treats a differently-spelled default as the default', () => {
    render(<Harness />);
    enterNumber('Layer Height', '0.28');
    // '0.20' is the same setting as the profile's '0.2'.
    enterNumber('Layer Height', '0.20');
    expect(lastDiff()).toEqual({});
  });

  it('drops only the reverted field, keeping the others', () => {
    render(<Harness />);
    enterNumber('Layer Height', '0.28');
    enterNumber('Infill Density', '35');
    expect(lastDiff()).toEqual({ layer_height: 0.28, sparse_infill_density: 35 });

    enterNumber('Layer Height', '0.2');
    expect(lastDiff()).toEqual({ sparse_infill_density: 35 });
    expect(screen.getByTestId('override-count')).toHaveTextContent('1 changed');
  });

  it('emits nothing when a select is put back on its resolved option', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.selectOptions(screen.getByLabelText('Infill Pattern'), 'gyroid');
    expect(lastDiff()).toEqual({ sparse_infill_pattern: 'gyroid' });

    await user.selectOptions(screen.getByLabelText('Infill Pattern'), 'grid');
    expect(lastDiff()).toEqual({});
    expect(isMarked('sparse_infill_pattern')).toBe(false);
  });

  it('emits nothing when a boolean is toggled back', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByLabelText('Enable Support'));
    expect(lastDiff()).toEqual({ enable_support: true });

    await user.click(screen.getByLabelText('Enable Support'));
    expect(lastDiff()).toEqual({});
    expect(isMarked('enable_support')).toBe(false);
  });

  it('emits nothing after the per-field revert button', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    enterNumber('Infill Density', '35');
    expect(lastDiff()).toEqual({ sparse_infill_density: 35 });

    const row = screen.getByTestId('process-field-row-sparse_infill_density');
    await user.click(within(row).getByRole('button', { name: /Revert Infill Density/i }));

    expect(lastDiff()).toEqual({});
    expect((screen.getByLabelText('Infill Density') as HTMLInputElement).value).toBe('20');
  });

  it('clearing a number field reverts it rather than sending 0', () => {
    render(<Harness />);
    enterNumber('Layer Height', '0.28');
    enterNumber('Layer Height', '');

    expect(lastDiff()).toEqual({});
    expect((screen.getByLabelText('Layer Height') as HTMLInputElement).value).toBe('0.2');
  });

  it('Reset clears every override at once', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    enterNumber('Layer Height', '0.28');
    await user.selectOptions(screen.getByLabelText('Infill Pattern'), 'cubic');
    expect(screen.getByTestId('override-count')).toHaveTextContent('2 changed');

    await user.click(screen.getByRole('button', { name: 'Reset' }));

    expect(lastDiff()).toEqual({});
    expect(screen.getByTestId('override-count')).toHaveTextContent('Preset values');
    expect((screen.getByLabelText('Layer Height') as HTMLInputElement).value).toBe('0.2');
  });

  it('every entry is an override when the resolved process is unavailable', () => {
    render(<Harness resolvedProcess={null} />);
    // With no default to compare against, 0.2 is a real instruction.
    enterNumber('Layer Height', '0.2');
    expect(lastDiff()).toEqual({ layer_height: 0.2 });

    enterNumber('Layer Height', '');
    expect(lastDiff()).toEqual({});
  });

  it('leaves override keys it was not given a field for alone', () => {
    render(<Harness initial={{ some_other_key: 5 }} />);
    enterNumber('Layer Height', '0.28');
    expect(lastDiff()).toEqual({ some_other_key: 5, layer_height: 0.28 });
  });

  it('does not mark an incoming override that already equals the default', () => {
    render(<Harness initial={{ layer_height: 0.2 }} />);
    expect(isMarked('layer_height')).toBe(false);
    expect(screen.getByTestId('override-count')).toHaveTextContent('Preset values');
  });
});

describe('ProcessSettingsEditor — range clamping', () => {
  it('clamps a value above max on commit and emits the clamped number', () => {
    render(<Harness />);
    const input = enterNumber('Layer Height', '999');

    expect(input.value).toBe('0.6');
    expect(lastDiff()).toEqual({ layer_height: 0.6 });
  });

  it('clamps a value below min on commit', () => {
    render(<Harness />);
    const input = enterNumber('Layer Height', '0.001');

    expect(input.value).toBe('0.04');
    expect(lastDiff()).toEqual({ layer_height: 0.04 });
  });

  it('clamps a percent field to its curated bounds', () => {
    render(<Harness />);
    expect(enterNumber('Infill Density', '150').value).toBe('100');
    expect(lastDiff()).toEqual({ sparse_infill_density: 100 });

    expect(enterNumber('Infill Density', '-5').value).toBe('0');
    expect(lastDiff()).toEqual({ sparse_infill_density: 0 });
  });

  it('does not clamp a field with no curated min or max', async () => {
    const user = userEvent.setup();
    const unbounded: ProcessField[] = [
      { key: 'line_width', label: 'Line Width', type: 'number', category: 'quality', unit: 'mm', step: 0.01 },
    ];
    render(<Harness fields={unbounded} resolvedProcess={{ line_width: '0.42' }} />);
    await showAll(user);

    expect(enterNumber('Line Width', '12.5').value).toBe('12.5');
    expect(lastDiff()).toEqual({ line_width: 12.5 });
  });

  it('treats a non-numeric entry as an empty one and reverts the field', () => {
    render(<Harness />);
    enterNumber('Layer Height', '0.28');
    // `<input type="number">` reports '' for anything it cannot parse — in
    // jsdom and in a real browser alike — so "abc" is indistinguishable from
    // a cleared field by the time the commit sees it. Reverting is the right
    // reading of a cleared field; the important part is that it does not
    // commit 0 or NaN.
    enterNumber('Layer Height', 'abc');

    expect(lastDiff()).toEqual({});
    expect((screen.getByLabelText('Layer Height') as HTMLInputElement).value).toBe('0.2');
  });
});

describe('ProcessSettingsEditor — search, categories and tiers', () => {
  it('filters by label', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByLabelText('Search settings'), 'infill');

    expect(screen.getByLabelText('Infill Density')).toBeInTheDocument();
    expect(screen.getByLabelText('Infill Pattern')).toBeInTheDocument();
    expect(screen.queryByLabelText('Layer Height')).toBeNull();
  });

  it('filters by key and by description too', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const search = screen.getByLabelText('Search settings');

    await user.type(search, 'enable_support');
    expect(screen.getByLabelText('Enable Support')).toBeInTheDocument();
    expect(screen.queryByLabelText('Layer Height')).toBeNull();

    await user.clear(search);
    await user.type(search, 'printed layer');
    expect(screen.getByLabelText('Layer Height')).toBeInTheDocument();
    expect(screen.queryByLabelText('Enable Support')).toBeNull();
  });

  it('reports when a search matches nothing', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByLabelText('Search settings'), 'zzzz');

    expect(screen.getByText('No setting matches that search.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Layer Height')).toBeNull();
  });

  it('narrows to one category when its chip is clicked, and widens again', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await showAll(user);

    await user.click(screen.getByRole('button', { name: 'Infill' }));
    expect(screen.getByLabelText('Infill Density')).toBeInTheDocument();
    expect(screen.queryByLabelText('Layer Height')).toBeNull();
    expect(screen.queryByLabelText('Enable Support')).toBeNull();

    // Clicking the active chip again clears the filter.
    await user.click(screen.getByRole('button', { name: 'Infill' }));
    expect(screen.getByLabelText('Layer Height')).toBeInTheDocument();
  });

  it('builds the chips from the fields own categories, in spec order', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await showAll(user);

    const chips = screen
      .getAllByRole('button')
      .map((button) => button.textContent)
      .filter((text): text is string =>
        ['All', 'Quality', 'Speed', 'Support', 'Infill', 'Acceleration'].includes(text ?? ''),
      );
    expect(chips).toEqual(['All', 'Quality', 'Support', 'Infill', 'Acceleration']);
    // A category no field uses gets no chip.
    expect(screen.queryByRole('button', { name: 'Speed' })).toBeNull();
  });

  it('combines a category chip with the search box', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Infill' }));
    await user.type(screen.getByLabelText('Search settings'), 'pattern');

    expect(screen.getByLabelText('Infill Pattern')).toBeInTheDocument();
    expect(screen.queryByLabelText('Infill Density')).toBeNull();
  });

  it('hides non-Basic fields on the Basic tier and shows them on Advanced', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    // Basic is the default tier.
    expect(screen.getByLabelText('Layer Height')).toBeInTheDocument();
    expect(screen.queryByLabelText('Normal Printing Acceleration')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.getByLabelText('Normal Printing Acceleration')).toBeInTheDocument();
  });

  it('lets a search reach an Advanced field while the Basic tier is selected', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByLabelText('Search settings'), 'acceleration');

    expect(screen.getByLabelText('Normal Printing Acceleration')).toBeInTheDocument();
  });

  it('keeps an override applied while it is filtered out of view', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    enterNumber('Layer Height', '0.28');

    await user.click(screen.getByRole('button', { name: 'Infill' }));
    expect(screen.queryByLabelText('Layer Height')).toBeNull();
    // Still counted, still in the diff — filtering is a view, not an edit.
    expect(screen.getByTestId('override-count')).toHaveTextContent('1 changed');
    expect(lastDiff()).toEqual({ layer_height: 0.28 });
  });
});

describe('ProcessSettingsEditor — states', () => {
  it('renders the loading state instead of fields', () => {
    render(
      <ProcessSettingsEditor fields={[]} overrides={{}} onOverridesChange={onChange} isLoading />,
    );
    expect(screen.getByText('Loading settings…')).toBeInTheDocument();
  });

  it('renders the error the caller hands it', () => {
    render(
      <ProcessSettingsEditor
        fields={[]}
        overrides={{}}
        onOverridesChange={onChange}
        error="Slicer sidecar unreachable"
      />,
    );
    expect(screen.getByText('Slicer sidecar unreachable')).toBeInTheDocument();
  });

  it('reports an empty curated field list', () => {
    render(<ProcessSettingsEditor fields={[]} overrides={{}} onOverridesChange={onChange} />);
    expect(screen.getByText('This slicer exposes no overridable settings.')).toBeInTheDocument();
  });

  it('disables every control and Reset when disabled', () => {
    render(
      <ProcessSettingsEditor
        fields={FIELDS}
        resolvedProcess={RESOLVED}
        overrides={{ layer_height: 0.28 }}
        onOverridesChange={onChange}
        disabled
      />,
    );
    expect(screen.getByLabelText('Layer Height')).toBeDisabled();
    expect(screen.getByLabelText('Enable Support')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
  });

  it('disables Reset when there is nothing to reset', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
  });
});

describe('processFields helpers', () => {
  const layerHeight = FIELDS[0];
  const support = FIELDS[3];
  const pattern = FIELDS[2];

  it('parses the string spellings a real profile uses', () => {
    expect(parseResolvedValue(layerHeight, { layer_height: '0.2' })).toBe(0.2);
    expect(parseResolvedValue(FIELDS[1], { sparse_infill_density: '20%' })).toBe(20);
    expect(parseResolvedValue(support, { enable_support: '1' })).toBe(true);
    expect(parseResolvedValue(support, { enable_support: '0' })).toBe(false);
    expect(parseResolvedValue(FIELDS[4], { default_acceleration: ['6000'] })).toBe(6000);
  });

  it('returns null when the preset says nothing usable', () => {
    expect(parseResolvedValue(layerHeight, {})).toBeNull();
    expect(parseResolvedValue(layerHeight, null)).toBeNull();
    expect(parseResolvedValue(layerHeight, { layer_height: 'default' })).toBeNull();
    expect(parseResolvedValue(support, { enable_support: 'maybe' })).toBeNull();
    // A select value the curated options do not list would fail the backend.
    expect(parseResolvedValue(pattern, { sparse_infill_pattern: 'monotonic' })).toBeNull();
  });

  it('never treats an unknown default as equal to anything', () => {
    expect(valuesEqual(null, null)).toBe(false);
    expect(valuesEqual(0.2, null)).toBe(false);
    expect(valuesEqual(0.2, 0.2)).toBe(true);
    expect(valuesEqual(0.1 + 0.2, 0.3)).toBe(true);
    expect(valuesEqual(false, false)).toBe(true);
  });

  it('nextOverrides removes a key rather than writing a no-op', () => {
    const defaults = { layer_height: 0.2, wall_loops: 2 };
    expect(nextOverrides({}, defaults, 'layer_height', 0.28)).toEqual({ layer_height: 0.28 });
    expect(nextOverrides({ layer_height: 0.28 }, defaults, 'layer_height', 0.2)).toEqual({});
    expect(nextOverrides({ layer_height: 0.28 }, defaults, 'layer_height', undefined)).toEqual({});
    expect(nextOverrides({ wall_loops: 4 }, defaults, 'layer_height', 0.2)).toEqual({ wall_loops: 4 });
  });

  it('sanitizeOverrides strips a caller-supplied no-op but keeps unknown keys', () => {
    const defaults = { layer_height: 0.2, wall_loops: 2 };
    expect(
      sanitizeOverrides({ layer_height: 0.2, wall_loops: 4, bed_type: 'textured_pei' }, defaults),
    ).toEqual({ wall_loops: 4, bed_type: 'textured_pei' });
  });
});
