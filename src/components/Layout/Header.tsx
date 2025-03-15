import React from 'react';
import { NavLink } from 'react-router-dom';
import './Layout.css';

const Header: React.FC = () => {
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