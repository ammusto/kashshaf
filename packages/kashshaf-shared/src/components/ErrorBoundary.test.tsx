import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

function Bomb({ explode }: { explode: boolean }) {
  if (explode) throw new Error('Maximum update depth exceeded');
  return <p>the reader</p>;
}

describe('ErrorBoundary', () => {
  it('shows a message in place of a child that throws, and remounts it on "Try again"', () => {
    const onError = vi.fn();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let explode = true;
    const { rerender } = render(
      <ErrorBoundary what="The reader" onError={onError}>
        <Bomb explode={explode} />
      </ErrorBoundary>
    );
    const alert = screen.getByTestId('error-boundary');
    expect(alert).toHaveTextContent('The reader ran into a problem and stopped.');
    expect(alert).toHaveTextContent('Maximum update depth exceeded');
    expect(onError).toHaveBeenCalledTimes(1);

    // The fault is gone; trying again brings the child back.
    explode = false;
    rerender(
      <ErrorBoundary what="The reader" onError={onError}>
        <Bomb explode={explode} />
      </ErrorBoundary>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('the reader')).toBeInTheDocument();
    expect(screen.queryByTestId('error-boundary')).not.toBeInTheDocument();
    spy.mockRestore();
  });

  it('adds nothing around a child that works', () => {
    const { container } = render(
      <ErrorBoundary what="The reader">
        <p>fine</p>
      </ErrorBoundary>
    );
    expect(container.firstElementChild?.tagName).toBe('P');
  });
});
