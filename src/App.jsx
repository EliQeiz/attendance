import React, { useState, useEffect } from 'react';
import Login from './components/Login';
import LecturerDashboard from './components/LecturerDashboard';
import StudentDashboard from './components/StudentDashboard';
import './App.css';
// 🟢 Firebase Additions
import { auth } from './firebase'; 
import { onAuthStateChanged, signOut } from "firebase/auth";

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 🟢 Step 1: Check LocalStorage immediately before Firebase even responds
    // This prevents the "flash" of the login screen on refresh
    const savedRole = localStorage.getItem('userRole');
    const savedId = localStorage.getItem('knustId');
    const savedName = localStorage.getItem('knustName');

    if (savedRole && savedId) {
      setUser({ id: savedId, name: savedName || "User", role: savedRole });
    }

    // 🟢 Step 2: Listen for Firebase Auth state to verify the session
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser) {
        // If Firebase says we are logged in, but state is empty, re-sync from Storage
        if (!user && savedRole && savedId) {
          setUser({
            id: savedId,
            email: firebaseUser.email,
            name: savedName || firebaseUser.displayName || "KNUST User",
            role: savedRole
          });
        }
      } else {
        // Only force logout if Firebase explicitly says there is no user session
        // AND we don't have a saved role (to allow for offline/local-only testing)
        if (!savedRole) {
          setUser(null);
        }
      }
      setLoading(false); 
    });

    return () => unsubscribe();
  }, []);

  const handleLogin = (userData) => {
    localStorage.setItem('userRole', userData.role);
    localStorage.setItem('knustId', userData.id);
    localStorage.setItem('knustName', userData.name); 
    setUser(userData);
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      localStorage.removeItem('userRole');
      localStorage.removeItem('knustId');
      localStorage.removeItem('knustName');
      setUser(null);
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  if (loading) {
    return (
      <div style={{ 
        height: '100vh', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        background: '#f8fafc' 
      }}>
        <img 
          src="https://images.seeklogo.com/logo-png/35/2/kwame-nkrumah-university-of-science-technology-logo-png_seeklogo-350387.png" 
          style={{ width: '80px', opacity: 0.6 }} 
          alt="Loading..." 
        />
      </div>
    );
  }

  return (
    <div className="app-container">
      {!user ? (
        <ProjectLogin onLogin={handleLogin} />
      ) : user.role === 'lecturer' ? (
        <LecturerDashboard user={user} onLogout={handleLogout} />
      ) : (
        <StudentDashboard user={user} onLogout={handleLogout} />
      )}
    </div>
  );
}

// 🟢 Small helper component to ensure the Login component receives props correctly
function ProjectLogin({ onLogin }) {
  return <Login onLogin={onLogin} />;
}

export default App;