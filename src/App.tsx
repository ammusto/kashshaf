import React from 'react';
import { BrowserRouter as Router } from 'react-router-dom';
import Header from './components/Layout/Header';
import MainContent from './components/Layout/MainContent';
import Footer from './components/Layout/Footer';
import { MetadataProvider } from './contexts/MetadataContext';
import { SearchProvider } from './contexts/SearchContext';
import './index.css';

const App: React.FC = () => {
  return (
    <Router>
      <MetadataProvider>
        <SearchProvider>
          <div className="min-h-screen  flex flex-col" dir="rtl">
            <Header />
            <MainContent />
            <Footer />
          </div>
        </SearchProvider>
      </MetadataProvider>
    </Router>
  );
};

export default App;