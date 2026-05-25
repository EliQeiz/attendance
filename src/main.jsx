import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

// This log helps you debug. If you see this in the browser console (F12), 
// it means the file path between index.html and main.jsx is FIXED.
console.log("main.jsx has loaded successfully!");

const rootElement = document.getElementById('root');

if (!rootElement) {
  console.error("Failed to find the root element. Check if <div id='root'></div> exists in index.html");
} else {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>
  );
}