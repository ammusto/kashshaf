import React from 'react';
import { Link } from 'react-router-dom';

const Header: React.FC = () => {

  return (
    <header>
      <div className="header-container">
        <nav className="nav-container">
          <div className="nav-left">
            <li className="header-logo">kashshāf</li>
          </div>
          <div className="nav-center">
            <li>
              <Link to="/">
                Search
              </Link>
            </li>
            <li>
              <Link to="/about">
                About
              </Link>
            </li>
          </div>

        </nav>
      </div>
    </header>
  );
};

export default Header;