import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PanelBoundary } from './PanelBoundary';

/**
 * A panel that throws should cost that panel and nothing else (A1). React
 * logs the error itself, so the console is silenced here to keep the test
 * output readable.
 */

function Boom({ when }: { when: boolean }) {
  if (when) throw new Error("Cannot use 'in' operator to search for 'Person' in الجنيد");
  return <p>the panel</p>;
}

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('PanelBoundary', () => {
  it('renders its panel when nothing is wrong', () => {
    render(
      <PanelBoundary name="Network">
        <Boom when={false} />
      </PanelBoundary>
    );
    expect(screen.getByText('the panel')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-error')).toBeNull();
  });

  it('shows the panel name and the message instead of a white screen', () => {
    render(
      <PanelBoundary name="Network">
        <Boom when />
      </PanelBoundary>
    );
    const box = screen.getByTestId('panel-error');
    expect(box).toHaveTextContent('The Network panel could not draw.');
    expect(box).toHaveTextContent("Cannot use 'in' operator");
    expect(box).toHaveTextContent('nothing you have confirmed is affected');
  });

  it('clears when another panel is opened', () => {
    const { rerender } = render(
      <PanelBoundary name="Network">
        <Boom when />
      </PanelBoundary>
    );
    expect(screen.getByTestId('panel-error')).toBeInTheDocument();
    rerender(
      <PanelBoundary name="Stats">
        <Boom when={false} />
      </PanelBoundary>
    );
    expect(screen.queryByTestId('panel-error')).toBeNull();
    expect(screen.getByText('the panel')).toBeInTheDocument();
  });

  it('retries on request', () => {
    let fail = true;
    function Flaky() {
      if (fail) throw new Error('once');
      return <p>recovered</p>;
    }
    render(
      <PanelBoundary name="Reuse">
        <Flaky />
      </PanelBoundary>
    );
    expect(screen.getByTestId('panel-error')).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('recovered')).toBeInTheDocument();
  });
});
