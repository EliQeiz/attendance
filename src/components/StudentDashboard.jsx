import React from 'react';
import { QRCodeCanvas } from 'qrcode.react';

export default function StudentDashboard({ user, onLogout }) {
  return (
    <div className="knust-login-page"> {/* Reuse centering background */}
      <div className="login-glass-card">
        <h2>Welcome, {user.name}</h2>
        <p>ID: {user.id}</p>
        <div style={{margin: '30px 0'}}>
          <QRCodeCanvas value={user.id} size={200} />
        </div>
        <button onClick={onLogout} className="login-btn-final" style={{background: '#64748b'}}>Logout</button>
      </div>
    </div>
  );
}