import React from 'react';
import './Layout.css';

const Footer: React.FC = () => {
  return (
    <footer>
      <div className="div-footer">
        <div className="footer-link-container">
          <a href="mailto:amusto@gmail.com">Contact Us</a>
          <a href="https://github.com/ammusto/kashshaf">
            <img id="git_footer" src="/media/github-mark.png" alt="GitHub" />
          </a>
          <a href="mailto:amusto@gmail.com">Report a Bug</a>
        </div>
        <div>
          © Antonio Musto 2025
        </div>
      </div>
    </footer>
  );
};

export default Footer;