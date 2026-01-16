import React from 'react';
import { QRCodeCanvas } from 'qrcode.react';

export default function StudentDashboard({ user, onLogout }) {
  // 🟢 We use a strict template literal to ensure the Lecturer's scanner
  // can reliably find the "Name:" and "ID:" keys using the Regex we set up.
  const qrValue = `Name: ${user.name} | ID: ${user.id}`;

  return (
    <div className="knust-login-page"> {/* Reuse centering background */}
      <div className="login-glass-card">
        <img 
          src="https://images.seeklogo.com/logo-png/35/2/kwame-nkrumah-university-of-science-technology-logo-png_seeklogo-350387.png" 
          alt="KNUST Logo" 
          style={{ width: '60px', height: 'auto', marginBottom: '15px' }} 
        />
        <h2 style={{color: '#003366', fontSize: '1.4rem', marginBottom: '5px'}}>
          Welcome, {user.name}
        </h2>
        <p style={{color: '#64748b', marginBottom: '10px'}}>ID: {user.id}</p>
        
        <div style={{
          margin: '25px 0', 
          padding: '15px', 
          background: 'white', 
          borderRadius: '12px', 
          display: 'inline-block',
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
        }}>
          {/* 🟢 Render the QR code with high error correction */}
          <QRCodeCanvas 
            value={qrValue} 
            size={200} 
            level={"H"} // High error correction for better scanning
            includeMargin={true}
          />
        </div>
        
        <p style={{fontSize: '0.8rem', color: '#94a3b8', marginBottom: '20px'}}>
          Present this code to the lecturer for verification
        </p>

        <button 
          onClick={onLogout} 
          className="login-btn-final" 
          style={{background: '#64748b', width: '100%', padding: '12px', borderRadius: '10px', color: 'white', border: 'none', cursor: 'pointer'}}
        >
          Logout
        </button>
      </div>
    </div>
  );
}