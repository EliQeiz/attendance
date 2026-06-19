import React, { useState, useEffect, lazy, Suspense } from 'react';
import Login from './components/Login';
import './App.css';
import { auth, db } from './firebase';
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";

const LecturerDashboard = lazy(() => import('./components/LecturerDashboard'));
const StudentDashboard = lazy(() => import('./components/StudentDashboard'));

function FullScreenLoader() {
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

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser) {
        setUser(null);
        setLoading(false);
        return;
      }

      try {
        const profileRef = doc(db, "users", firebaseUser.uid);
        const profileSnap = await getDoc(profileRef);
        const profile = profileSnap.exists() ? profileSnap.data() : null;

        if (!profile?.role) {
          setUser(null);
          setLoading(false);
          return;
        }

        const knustId = profile.knust_id || "";

        setUser({
          uid: firebaseUser.uid,
          id: profile.role === "lecturer" ? firebaseUser.uid : knustId,
          knust_id: knustId,
          name: profile.name || firebaseUser.displayName || "KNUST User",
          role: profile.role,
          email: profile.email || firebaseUser.email || "",
          recoveryEmail: profile.recoveryEmail || profile.email || firebaseUser.email || ""
        });
      } catch (error) {
        console.error("Failed to restore auth session:", error);
        setUser(null);
      } finally {
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, []);

  const handleLogin = (userData) => {
    setUser(userData);
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      localStorage.removeItem('userRole');
      localStorage.removeItem('knustId');
      localStorage.removeItem('knustName');
      localStorage.removeItem('authUid');
      setUser(null);
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  if (loading) {
    return <FullScreenLoader />;
  }

  return (
    <div className="app-container">
      {!user ? (
        <ProjectLogin onLogin={handleLogin} />
      ) : (
        <Suspense fallback={<FullScreenLoader />}>
          {user.role === 'lecturer' ? (
            <LecturerDashboard user={user} onLogout={handleLogout} />
          ) : (
            <StudentDashboard user={user} onLogout={handleLogout} />
          )}
        </Suspense>
      )}
    </div>
  );
}

function ProjectLogin({ onLogin }) {
  return <Login onLogin={onLogin} />;
}

export default App;
