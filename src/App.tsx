import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Header from './components/Layout/Header';
import MainContent from './components/Layout/MainContent';
import AboutPage from './components/About/AboutPage';
import TextDetailPage from './components/TextDetailPage';
import Footer from './components/Layout/Footer';
import { MetadataProvider } from './contexts/MetadataContext';
import { SearchProvider } from './contexts/SearchContext';
import './index.css';

const App: React.FC = () => {
  return (
    <Router>
      <MetadataProvider>
        <SearchProvider>
          <div className="min-h-screen flex flex-col">
            <Header />
            <Routes>
              <Route path="/" element={<MainContent />} />
              <Route path="/about" element={<AboutPage />} />
              <Route path="/text/:textId" element={<TextDetailPage />} />
            </Routes>
            <Footer />
          </div>
        </SearchProvider>
      </MetadataProvider>
    </Router>
  );
};

export default App;