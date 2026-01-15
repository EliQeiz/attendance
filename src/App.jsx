import React, { useState } from 'react';
import Login from './components/Login';
import LecturerDashboard from './components/LecturerDashboard';
import StudentDashboard from './components/StudentDashboard';
import './App.css';

function App() {
  const [user, setUser] = useState(null);

  return (
    <div className="app-container">
      {!user ? (
        <Login onLogin={setUser} />
      ) : user.role === 'lecturer' ? (
        <LecturerDashboard user={user} onLogout={() => setUser(null)} />
      ) : (
        <StudentDashboard user={user} onLogout={() => setUser(null)} />
      )}
    </div>
  );
}

export default App;