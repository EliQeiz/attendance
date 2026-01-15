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
  const [loading, setLoading] = useState(true); // 🟢 Prevents screen flicker during check

  useEffect(() => {
    // 🟢 Listen for authentication state (Persistent Login)
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser) {
        // User is logged in, restore their session from Firebase and LocalStorage
        setUser({
          id: localStorage.getItem('knustId') || firebaseUser.uid,
          email: firebaseUser.email,
          name: firebaseUser.displayName || "KNUST User",
          role: localStorage.getItem('userRole') || 'student' 
        });
      } else {
        setUser(null);
      }
      setLoading(false); // Finished checking Firebase status
    });

    return () => unsubscribe();
  }, []);

  // 🟢 Enhanced Login Handler
  const handleLogin = (userData) => {
    localStorage.setItem('userRole', userData.role);
    localStorage.setItem('knustId', userData.id);
    setUser(userData);
  };

  // 🟢 Enhanced Logout Handler
  const handleLogout = async () => {
    try {
      await signOut(auth);
      localStorage.removeItem('userRole');
      localStorage.removeItem('knustId');
      setUser(null);
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  // 🟢 Safety: Show a loading screen while Firebase is verifying the user
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
        <Login onLogin={handleLogin} />
      ) : user.role === 'lecturer' ? (
        <LecturerDashboard user={user} onLogout={handleLogout} />
      ) : (
        <StudentDashboard user={user} onLogout={handleLogout} />
      )}
    </div>
  );
}

export default App;