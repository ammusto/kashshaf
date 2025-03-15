import React from 'react';
import { Link, NavLink } from 'react-router-dom';

const Header: React.FC = () => {
  return (
    <header>
      <div className="header-container">
        <nav className="nav-container">
          <div className="nav-left">
            <li className="header-logo">
              kashshāf
            </li>
          </div>
          <div className="nav-center">
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
          </div>
        </nav>
      </div>
    </header>
  );
};

export default Header;