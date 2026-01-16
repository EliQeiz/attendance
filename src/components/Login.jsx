import React, { useState } from 'react';

export default function Login({ onLogin }) {
  const [data, setData] = useState({ name: '', id: '', role: 'student' });
  const [error, setError] = useState(''); // 🟢 State for the red notification

  const handleSubmit = (e) => {
    e.preventDefault();
    setError(''); // Clear previous errors

    // 🟢 8-Digit Constraint for Students only
    if (data.role === 'student' && data.id.length !== 8) {
      setError('Student ID must be exactly 8 digits.');
      return; // Stop the login process
    }

    // Save to localStorage immediately so App.jsx finds it on refresh
    localStorage.setItem('userRole', data.role);
    localStorage.setItem('knustId', data.id);
    localStorage.setItem('knustName', data.name); // 🟢 Save name for QR consistency
    
    // Proceed with the login
    onLogin(data);
  };

  return (
    <div className="knust-login-page">
      <div className="login-glass-card">
        <img 
          src="https://images.seeklogo.com/logo-png/35/2/kwame-nkrumah-university-of-science-technology-logo-png_seeklogo-350387.png" 
          alt="KNUST Logo" 
          style={{ width: '80px', height: 'auto', marginBottom: '15px' }} 
        />
        <h1 style={{color: '#003366', fontSize: '1.5rem'}}>KNUST Attendance</h1>
        <p style={{color: '#64748b', marginBottom: '20px'}}>Secure Portal Access</p>

        {/* 🟢 Red Error Notification Box */}
        {error && (
          <div style={{
            background: '#fee2e2',
            color: '#dc2626',
            padding: '10px',
            borderRadius: '8px',
            marginBottom: '15px',
            fontSize: '0.85rem',
            border: '1px solid #fecaca',
            textAlign: 'center',
            fontWeight: '500'
          }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="login-form">
          <input 
            placeholder="Full Name" required 
            style={{width: '100%', padding: '12px', marginBottom: '10px', borderRadius: '8px', border: '1px solid #ddd'}}
            onChange={e => setData({...data, name: e.target.value})} 
          />
          <input 
            placeholder="ID Number" required 
            type="text" // Using text to handle leading zeros if necessary
            style={{width: '100%', padding: '12px', marginBottom: '10px', borderRadius: '8px', border: '1px solid #ddd'}}
            onChange={e => setData({...data, id: e.target.value})} 
          />
          
          <div className="role-toggle">
            <button 
              type="button" 
              className={data.role === 'student' ? 'active' : ''}
              onClick={() => { setData({...data, role: 'student'}); setError(''); }}>
              Student
            </button>
            <button 
              type="button" 
              className={data.role === 'lecturer' ? 'active' : ''}
              onClick={() => { setData({...data, role: 'lecturer'}); setError(''); }}>
              Lecturer
            </button>
          </div>

          <button type="submit" className="login-btn-final" style={{width: '100%', padding: '14px', background: '#006837', color: 'white', border: 'none', borderRadius: '12px', fontWeight: 'bold', cursor: 'pointer', marginTop: '10px'}}>
            Sign In
          </button>
        </form>
      </div>
    </div>
  );
}