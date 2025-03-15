import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { loadTextsMetadata, loadAuthorsMetadata } from '../services/opensearch';
import { Text, Author } from '../types';

interface MetadataContextType {
  textsMetadata: Map<number, Text>;
  authorsMetadata: Map<number, Author>;
  isLoading: boolean;
  error: string | null;
}

const defaultContextValue: MetadataContextType = {
  textsMetadata: new Map(),
  authorsMetadata: new Map(),
  isLoading: true,
  error: null
};

const MetadataContext = createContext<MetadataContextType>(defaultContextValue);

export const useMetadata = () => useContext(MetadataContext);

interface MetadataProviderProps {
  children: ReactNode;
}

export const MetadataProvider: React.FC<MetadataProviderProps> = ({ children }) => {
  const [textsMetadata, setTextsMetadata] = useState<Map<number, Text>>(new Map());
  const [authorsMetadata, setAuthorsMetadata] = useState<Map<number, Author>>(new Map());
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadMetadata = async () => {
      setIsLoading(true);
      try {
        const [texts, authors] = await Promise.all([
          loadTextsMetadata(),
          loadAuthorsMetadata()
        ]);
        
        if (texts.size === 0 || authors.size === 0) {
          setError('No metadata loaded. Please check the Excel files in the public folder.');
        } else {
          setTextsMetadata(texts);
          setAuthorsMetadata(authors);
          setError(null);
        }
      } catch (error) {
        console.error('Failed to load metadata:', error);
        setError(`Error loading metadata: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setIsLoading(false);
      }
    };
    
    loadMetadata();
  }, []);

  return (
    <MetadataContext.Provider value={{ textsMetadata, authorsMetadata, isLoading, error }}>
      {children}
    </MetadataContext.Provider>
  );
};