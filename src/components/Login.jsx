import React, { useState } from 'react';

export default function Login({ onLogin }) {
  const [data, setData] = useState({ name: '', id: '', role: 'student' });

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

        <form onSubmit={(e) => { e.preventDefault(); onLogin(data); }} className="login-form">
          <input 
            placeholder="Full Name" required 
            style={{width: '100%', padding: '12px', marginBottom: '10px', borderRadius: '8px', border: '1px solid #ddd'}}
            onChange={e => setData({...data, name: e.target.value})} 
          />
          <input 
            placeholder="ID Number" required 
            style={{width: '100%', padding: '12px', marginBottom: '10px', borderRadius: '8px', border: '1px solid #ddd'}}
            onChange={e => setData({...data, id: e.target.value})} 
          />
          
          <div className="role-toggle">
            <button 
              type="button" 
              className={data.role === 'student' ? 'active' : ''}
              onClick={() => setData({...data, role: 'student'})}>
              Student
            </button>
            <button 
              type="button" 
              className={data.role === 'lecturer' ? 'active' : ''}
              onClick={() => setData({...data, role: 'lecturer'})}>
              Lecturer
            </button>
          </div>

          <button type="submit" className="login-btn-final" style={{width: '100%', padding: '14px', background: '#006837', color: 'white', border: 'none', borderRadius: '12px', fontWeight: 'bold', cursor: 'pointer'}}>
            Sign In
          </button>
        </form>
      </div>
    </div>
  );
}