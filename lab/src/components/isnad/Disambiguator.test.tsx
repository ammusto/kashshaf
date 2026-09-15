import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { BookMetadata } from '@kashshaf/shared';

/**
 * The name disambiguator (10 A): the forms of the open text, the forms that
 * might be the same person, and the two verdicts.
 */

const api = vi.hoisted(() => ({
  dis: {
    forms: vi.fn(),
    candidates: vi.fn(),
    notSame: vi.fn(async () => 1),
    allowAgain: vi.fn(async () => 1),
    distinctions: vi.fn(async (): Promise<unknown[]> => []),
  },
}));

vi.mock('../../api/isnad', async () => {
  const real = await vi.importActual<typeof import('../../api/isnad')>('../../api/isnad');
  return { ...real, disambiguationApi: api.dis };
});

import { Disambiguator } from './Disambiguator';
import { Pages } from '../../api/pages';

const book: BookMetadata = { id: 527, title: 'الزهد', in_corpus: true, parts: 1 };
const labels = new Pages(
  [
    { book_id: 527, part_index: 0, page_id: 10, page_number: '14', part_label: 'ج١' },
    { book_id: 527, part_index: 0, page_id: 11, page_number: '15', part_label: 'ج١' },
  ],
  1
);

const AHMAD = 'احمد بن علي';
const AHMAD_FULL = 'احمد بن علي بن جعفر';
const OMAR = 'احمد بن عمر';

const forms = [
  { form_norm: AHMAD, raw: 'أحمد بن علي', count: 5, person_id: null, person_name: null, part_index: 0, page_id: 10 },
  { form_norm: AHMAD_FULL, raw: 'أحمد بن علي بن جعفر', count: 2, person_id: null, person_name: null, part_index: 0, page_id: 11 },
  { form_norm: OMAR, raw: 'أحمد بن عمر', count: 1, person_id: 4, person_name: 'أحمد بن عمر البزاز', part_index: 0, page_id: 11 },
];

const candidates = [
  {
    ...forms[1],
    score: 0.81,
    string_score: 0.78,
    neighbour_score: 0.83,
    shared_from: 2,
    shared_to: 1,
    occurrences: [
      { isnad_id: 9, transmitter_id: 90, part_index: 0, page_id: 11, from: 'الجنيد', to: 'أبو نصر' },
      { isnad_id: 12, transmitter_id: 91, part_index: 0, page_id: 11, from: 'الجنيد', to: null },
    ],
  },
  {
    ...forms[2],
    score: 0.22,
    string_score: 0.55,
    neighbour_score: 0.0,
    shared_from: 0,
    shared_to: 0,
    occurrences: [{ isnad_id: 15, transmitter_id: 95, part_index: 0, page_id: 11, from: null, to: null }],
  },
];

function view(over: Partial<React.ComponentProps<typeof Disambiguator>> = {}) {
  const onOp = vi.fn(async () => {});
  const onOpen = vi.fn();
  const onClose = vi.fn();
  render(<Disambiguator book={book} labels={labels} version={0} onOp={onOp} onOpen={onOpen} onClose={onClose} {...over} />);
  return { onOp, onOpen, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.dis.forms.mockResolvedValue(forms);
  api.dis.candidates.mockResolvedValue(candidates);
});

describe('Disambiguator', () => {
  it('lists every form by count, and says which are already a person', async () => {
    view();
    const list = await screen.findByTestId('name-list');
    const rows = within(list).getAllByRole('button');
    expect(rows[0]).toHaveTextContent('أحمد بن علي');
    expect(rows[0]).toHaveTextContent('5');
    // An already-linked form names its person.
    expect(rows[2]).toHaveTextContent('أحمد بن عمر البزاز');
    expect(screen.getByTestId('form-count')).toHaveTextContent('3');
  });

  it('ranks candidates with both components and the company they keep', async () => {
    view();
    fireEvent.click(await screen.findByTestId(`name-${AHMAD}`));
    await waitFor(() => expect(api.dis.candidates).toHaveBeenCalledWith(527, AHMAD));

    const best = await screen.findByTestId(`candidate-${AHMAD_FULL}`);
    // The score, and what it is made of, so the two can be weighed apart.
    expect(within(best).getByTestId(`score-${AHMAD_FULL}`)).toHaveTextContent('0.81');
    expect(within(best).getByTestId(`score-${AHMAD_FULL}`)).toHaveTextContent('spelling 0.78');
    expect(within(best).getByTestId(`score-${AHMAD_FULL}`)).toHaveTextContent('company 0.83');
    expect(within(best).getByTestId(`shared-${AHMAD_FULL}`)).toHaveTextContent('Shares 2 sources and 1 recipient');
    // Who stood on either side, and the page, by the C1 rule.
    expect(best).toHaveTextContent('الجنيد');
    expect(best).toHaveTextContent('أبو نصر');
    expect(within(best).getAllByTestId(/^open-/)[0]).toHaveTextContent('15');

    // One with nothing in common says so rather than showing a bare zero.
    expect(within(screen.getByTestId(`candidate-${OMAR}`)).getByTestId(`shared-${OMAR}`)).toHaveTextContent(
      'No transmitter in common'
    );
  });

  it('opens an occurrence in the workbench', async () => {
    const { onOpen } = view();
    fireEvent.click(await screen.findByTestId(`name-${AHMAD}`));
    const best = await screen.findByTestId(`candidate-${AHMAD_FULL}`);
    fireEvent.click(within(best).getAllByTestId(/^open-/)[0]);
    expect(onOpen).toHaveBeenCalledWith(9, 90);
  });

  it('builds a group and merges it into one person', async () => {
    const { onOp } = view();
    fireEvent.click(await screen.findByTestId(`name-${AHMAD}`));
    await screen.findByTestId(`candidate-${AHMAD_FULL}`);

    // The name being examined is in the group already; one action needs two.
    expect(screen.getByTestId('same-person')).toBeDisabled();
    fireEvent.click(within(screen.getByTestId(`candidate-${AHMAD_FULL}`)).getByRole('button', { pressed: false }));
    expect(screen.getByTestId(`candidate-${AHMAD_FULL}`)).toHaveAttribute('data-picked', 'true');
    expect(screen.getByTestId('selection-group')).toHaveTextContent('أحمد بن علي بن جعفر');

    fireEvent.click(screen.getByTestId('same-person'));
    await waitFor(() =>
      expect(onOp).toHaveBeenCalledWith({ op: 'same_name', book_id: 527, forms: [AHMAD, AHMAD_FULL], canonical_name: null })
    );
  });

  it('records a pair as not the same, and says so', async () => {
    view();
    fireEvent.click(await screen.findByTestId(`name-${AHMAD}`));
    await screen.findByTestId(`candidate-${OMAR}`);
    fireEvent.click(within(screen.getByTestId(`candidate-${OMAR}`)).getByRole('button', { pressed: false }));

    fireEvent.click(screen.getByTestId('not-the-same'));
    await waitFor(() => expect(api.dis.notSame).toHaveBeenCalledWith(527, [AHMAD, OMAR]));
    expect(await screen.findByRole('status')).toHaveTextContent('will not be suggested again');
  });
});
