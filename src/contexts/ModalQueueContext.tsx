import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import type { TargetPlatform } from '../types';
import { isWebTarget } from '../utils/storage';

export interface QueuedModal {
  id: string;
  priority: number;
  target: TargetPlatform;
  render: (onDismiss: () => void) => ReactNode;
}

export const MODAL_PRIORITIES = {
  DOWNLOAD: 10,
  APP_UPDATE: 15,
  FORCED_ANNOUNCEMENT: 20,
  IMPORTANT_ANNOUNCEMENT: 30,
  NORMAL_ANNOUNCEMENT: 40,
  PROMO: 50,
} as const;

interface ModalQueueContextValue {
  /** The current modal to display (first in queue) */
  currentModal: QueuedModal | null;
  /** Add a modal to the queue */
  enqueue: (modal: QueuedModal) => void;
  /** Remove a specific modal from the queue by ID */
  dequeue: (id: string) => void;
  /** Dismiss the current modal (removes first in queue) */
  dismissCurrent: () => void;
  /** Check if a modal with the given ID is in the queue */
  isInQueue: (id: string) => boolean;
}

const ModalQueueContext = createContext<ModalQueueContextValue | null>(null);

interface ModalQueueProviderProps {
  children: ReactNode;
}

export function ModalQueueProvider({ children }: ModalQueueProviderProps) {
  const [queue, setQueue] = useState<QueuedModal[]>([]);

  const enqueue = useCallback((modal: QueuedModal) => {
    setQueue(prev => {
      // Check for duplicate ID
      if (prev.some(m => m.id === modal.id)) {
        return prev;
      }

      // Check platform targeting
      const isWeb = isWebTarget;
      if (modal.target !== 'all') {
        if (isWeb && modal.target !== 'web') return prev;
        if (!isWeb && modal.target !== 'desktop') return prev;
      }

      // Add to queue and sort by priority (lower priority number = higher precedence)
      const newQueue = [...prev, modal];
      newQueue.sort((a, b) => a.priority - b.priority);
      return newQueue;
    });
  }, []);

  const dequeue = useCallback((id: string) => {
    setQueue(prev => prev.filter(m => m.id !== id));
  }, []);

  const dismissCurrent = useCallback(() => {
    setQueue(prev => prev.slice(1));
  }, []);

  const isInQueue = useCallback((id: string) => {
    return queue.some(m => m.id === id);
  }, [queue]);

  const currentModal = queue.length > 0 ? queue[0] : null;

  const value: ModalQueueContextValue = {
    currentModal,
    enqueue,
    dequeue,
    dismissCurrent,
    isInQueue,
  };

  return (
    <ModalQueueContext.Provider value={value}>
      {children}
      {/* Render the current modal as overlay */}
      {currentModal && currentModal.render(() => dismissCurrent())}
    </ModalQueueContext.Provider>
  );
}

export function useModalQueue(): ModalQueueContextValue {
  const context = useContext(ModalQueueContext);
  if (!context) {
    throw new Error('useModalQueue must be used within a ModalQueueProvider');
  }
  return context;
}
