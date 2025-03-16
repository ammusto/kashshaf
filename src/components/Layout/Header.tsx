import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useSearch } from '../../contexts/SearchContext';
import './Layout.css';

const Header: React.FC = () => {
  const { resetSearch } = useSearch();
  const location = useLocation();
  
  const handleHomeClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    // If we're already on the home page, prevent default navigation and just reset the search
    if (location.pathname === '/' && location.search) {
      e.preventDefault();
      resetSearch();
    }
    // Otherwise, let the normal navigation happen
  };
  
  return (
    <header>
      <div className="header-container">
        <nav>
          <div className="nav-container">
            <div className="nav-left">
              <div className="header-logo">
                kashshāf <span className="text-xs align-top relative top-[1em]">(beta)</span>
              </div>
            </div>
            <ul className="nav-center">
              <li>
                <NavLink
                  to="/"
                  className={({ isActive }) => isActive ? "font-semibold" : ""}
                  onClick={handleHomeClick}
                >
                  Search
                </NavLink>
              </li>
              <li>
                <NavLink
                  to="/about"
                  className={({ isActive }) => isActive ? "font-semibold" : ""}
                >
                  About
                </NavLink>
              </li>
            </ul>
          </div>
        </nav>
      </div>
    </header>
  );
};

export default Header;