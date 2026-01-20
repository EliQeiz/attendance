import React, { useState, useEffect, useCallback } from 'react';
import Scanner from './Scanner';
import { Search, Download, LogOut, Menu, X, CheckCircle, BookOpen, History, Moon, Sun, LayoutGrid, Users, ArrowLeft, ChevronRight, FileSpreadsheet } from 'lucide-react'; 
import { Parser } from '@json2csv/plainjs';
import { db } from '../firebase'; 
import { collection, query, where, onSnapshot, addDoc, setDoc, doc, getDocs, orderBy } from "firebase/firestore";

export default function LecturerDashboard({ user, onLogout }) {
  const [courses, setCourses] = useState([]);
  const [attendance, setAttendance] = useState({});
  const [activeCourse, setActiveCourse] = useState(null);
  const [currentWeek, setCurrentWeek] = useState(1);
  const [isScanning, setIsScanning] = useState(false);
  const [scanned, setScanned] = useState(false); 
  const [lastScanned, setLastScanned] = useState(null); 
  const [searchTerm, setSearchTerm] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [view, setView] = useState('hub'); // 'hub', 'session', 'history'

  const weeks = Array.from({ length: 15 }, (_, i) => i + 1);

  // Fetch Courses
  useEffect(() => {
    if (!user?.id) return;
    const q = query(collection(db, "courses"), where("lecturerId", "==", user.id));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setCourses(snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id })));
    });
    return () => unsubscribe();
  }, [user.id]);

  // Fetch Session Attendance
  useEffect(() => {
    if (!activeCourse) return;
    const sessionKey = `${activeCourse.code}-W${currentWeek}`;
    const q = query(collection(db, "attendance", sessionKey, "records"), orderBy("timestamp", "desc"));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setAttendance(prev => ({
        ...prev,
        [sessionKey]: snapshot.docs.map(doc => doc.data())
      }));
    });
    return () => unsubscribe();
  }, [activeCourse, currentWeek]);

  // Fetch ALL history for active course when entering History View
  useEffect(() => {
    if (view === 'history' && activeCourse) {
      weeks.forEach(week => {
        const sessionKey = `${activeCourse.code}-W${week}`;
        const q = query(collection(db, "attendance", sessionKey, "records"));
        getDocs(q).then(snapshot => {
          if (!snapshot.empty) {
            setAttendance(prev => ({
              ...prev,
              [sessionKey]: snapshot.docs.map(doc => doc.data())
            }));
          }
        });
      });
    }
  }, [view, activeCourse]);

  const addCourse = async (e) => {
    e.preventDefault();
    await addDoc(collection(db, "courses"), {
      name: e.target.cn.value,
      code: e.target.cc.value,
      lecturerId: user.id,
      createdAt: new Date()
    });
    e.target.reset();
  };

  const handleScanSuccess = useCallback(async (rawResult) => {
    if (!activeCourse || scanned) return;
    const sessionKey = `${activeCourse.code}-W${currentWeek}`;
    const idMatch = rawResult.match(/ID:\s*(\d+)/i) || rawResult.match(/(\d{7,10})/); 
    const nameMatch = rawResult.match(/Name:\s*([^|]+)/i);
    const extractedID = idMatch ? idMatch[1] : "Unknown ID";
    const extractedName = nameMatch ? nameMatch[1].trim() : "Student " + extractedID;

    const docRef = doc(db, "attendance", sessionKey, "records", extractedID);
    await setDoc(docRef, {
      studentID: extractedID,
      fullName: extractedName,
      timeVerified: new Date().toLocaleTimeString(),
      status: "Verified",
      timestamp: new Date(),
      week: currentWeek,
      courseCode: activeCourse.code 
    });

    setLastScanned(extractedName);
    setScanned(true); 
  }, [activeCourse, currentWeek, scanned]);

  const downloadCSV = (weekNum) => {
    const sessionKey = `${activeCourse.code}-W${weekNum || currentWeek}`;
    const data = attendance[sessionKey] || [];
    if (!data.length) return alert("No records found for this week.");
    try {
      const formattedData = data.map(s => ({
        Course: activeCourse.code,
        Week: `Week ${weekNum || currentWeek}`,
        StudentID: s.studentID,
        FullName: s.fullName,
        Time: s.timeVerified,
        Status: s.status
      }));
      const parser = new Parser({ fields: ['Course', 'Week', 'StudentID', 'FullName', 'Time', 'Status'] });
      const csv = parser.parse(formattedData);
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = window.URL.createObjectURL(blob);
      a.download = `${activeCourse.code}_Week${weekNum || currentWeek}.csv`;
      a.click();
    } catch (e) { console.error(e); }
  };

  return (
    <div className={`dashboard-layout ${darkMode ? 'dark-theme' : ''}`}>
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header" style={{ marginBottom: '40px' }}>
          <img src="https://images.seeklogo.com/logo-png/35/2/kwame-nkrumah-university-of-science-technology-logo-png_seeklogo-350387.png" className="sidebar-logo" alt="KNUST" style={{ width: '80px', filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.2))' }} />
          <X className="mobile-close-btn" onClick={() => setSidebarOpen(false)} />
        </div>

        <nav className="sidebar-nav">
          <div className="nav-group">
            <p className="nav-label">Main Menu</p>
            <button onClick={() => { setView('hub'); setActiveCourse(null); setSidebarOpen(false); }} className={`nav-item ${view === 'hub' ? 'active-nav' : ''}`}>
              <LayoutGrid size={20} /> Academic Hub
            </button>
            <button 
                onClick={() => { if(activeCourse) setView('history'); setSidebarOpen(false); }} 
                className={`nav-item ${view === 'history' ? 'active-nav' : ''}`}
                disabled={!activeCourse}
                style={{ opacity: activeCourse ? 1 : 0.4 }}
            >
              <History size={20} /> Attendance History
            </button>
          </div>

          <div className="nav-group" style={{marginTop: '30px'}}>
            <p className="nav-label">UI Preferences</p>
            <button onClick={() => setDarkMode(!darkMode)} className="nav-item">
              {darkMode ? <Sun size={20} /> : <Moon size={20} />} 
              {darkMode ? 'Light Theme' : 'Dark Theme'}
            </button>
          </div>

          {activeCourse && (
            <div className="nav-group" style={{marginTop: '30px'}}>
              <p className="nav-label">Switch Context</p>
              {courses.filter(c => c.id !== activeCourse.id).map(c => (
                <button key={c.id} onClick={() => { setActiveCourse(c); setView('session'); setSidebarOpen(false); }} className="nav-item-sub">
                  <div style={{display:'flex', alignItems:'center', gap: '8px'}}>
                    <div style={{width: '6px', height:'6px', borderRadius:'50%', background:'var(--knust-yellow)'}}></div>
                    {c.code}
                  </div>
                </button>
              ))}
            </div>
          )}
        </nav>

        <div className="sidebar-user-card" style={{marginTop: 'auto', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)'}}>
          <p style={{ fontSize: '0.65rem', opacity: 0.6, letterSpacing: '1px' }}>LOGGED IN AS</p>
          <p style={{fontSize: '0.95rem', margin: '4px 0'}}><strong>{user.name}</strong></p>
          <p style={{ fontSize: '0.75rem', opacity: 0.8, marginBottom: '12px' }}>ID: {user.id}</p>
          <button onClick={onLogout} className="mini-logout" style={{width: '100%', justifyContent:'center', display:'flex', gap: '8px'}}><LogOut size={14} /> Sign Out</button>
        </div>
      </aside>

      <main className="main-content">
        {/* --- 🟢 TOP BAR REFINEMENT --- */}
        <header className="top-bar" style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: '30px'}}>
            <div style={{display:'flex', alignItems:'center', gap: '15px'}}>
                <button className="hamburger" onClick={() => setSidebarOpen(true)}><Menu size={28} /></button>
                <div>
                  <h4 style={{fontSize: '0.75rem', color: 'var(--knust-green)', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '2px'}}>Lecturer Portal</h4>
                  <h1 style={{fontSize: '1.5rem', color: 'var(--knust-blue)', fontWeight: '900'}}>{activeCourse ? activeCourse.code : 'Academic Overview'}</h1>
                </div>
            </div>
            {activeCourse && view !== 'hub' && (
                <div className="course-badge" style={{background: 'var(--knust-blue)', color: 'white', padding: '6px 16px', borderRadius: '20px', fontSize: '0.85rem', fontWeight: '600'}}>
                    {activeCourse.name}
                </div>
            )}
        </header>

        {/* --- 🏠 ACADEMIC HUB --- */}
        {view === 'hub' && (
          <div className="hub fade-in">
            <div className="welcome-banner" style={{marginBottom: '40px'}}>
              <h2 style={{fontSize: '2.5rem', fontWeight: '900', background: 'linear-gradient(45deg, var(--knust-blue), var(--knust-green))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent'}}>
                Welcome back, {user.name.split(' ')[0]}!
              </h2>
              <p style={{fontSize: '1.1rem', color: 'var(--text-muted)', marginTop: '5px'}}>Select a course to start recording attendance or view semester analytics.</p>
            </div>

            <div className="table-card" style={{padding: '30px', border: '1px solid var(--knust-blue)', borderLeftWidth: '6px'}}>
              <h3 style={{marginBottom: '20px', fontSize: '1rem', color: 'var(--knust-blue)'}}>Quick Actions: Register New Course</h3>
              <form onSubmit={addCourse} style={{display: 'flex', gap: '15px', flexWrap: 'wrap'}}>
                <input name="cn" placeholder="Course Title (e.g. Thermodynamics)" required className="pro-input" style={{flex: 3}} />
                <input name="cc" placeholder="Code (e.g. ME 221)" required className="pro-input" style={{flex: 1}} />
                <button type="submit" className="pro-btn-primary" style={{padding: '12px 30px', boxShadow: '0 10px 15px rgba(0, 104, 55, 0.2)'}}>+ Add to Ledger</button>
              </form>
            </div>

            <div className="course-grid" style={{marginTop: '30px'}}>
              {courses.map(c => (
                <div key={c.id} className="course-card" onClick={() => { setActiveCourse(c); setView('session'); }} style={{padding: '25px', border: '1px solid var(--border-color)'}}>
                  <div className="course-icon" style={{background: 'rgba(0, 51, 102, 0.1)', color: 'var(--knust-blue)'}}><BookOpen size={28} /></div>
                  <div className="course-info">
                    <strong style={{fontSize: '1.2rem'}}>{c.code}</strong>
                    <p style={{color: 'var(--text-muted)', fontSize: '0.9rem'}}>{c.name}</p>
                  </div>
                  <ChevronRight size={20} style={{marginLeft: 'auto', opacity: 0.3}} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* --- 📅 LIVE SESSION VIEW --- */}
        {view === 'session' && activeCourse && (
          <div className="session fade-in">
            <div className="session-header-card" style={{borderTop: '5px solid var(--knust-green)'}}>
              <div className="week-selector-box">
                <label style={{fontSize: '0.8rem', fontWeight: '700', color: 'var(--text-muted)', display: 'block', marginBottom: '8px'}}>SESSION WEEK</label>
                <select value={currentWeek} onChange={(e) => setCurrentWeek(parseInt(e.target.value))} className="week-dropdown" style={{minWidth: '150px'}}>
                  {weeks.map(w => <option key={w} value={w}>Academic Week {w}</option>)}
                </select>
              </div>
              <button onClick={() => downloadCSV()} className="btn-download" style={{background: 'var(--knust-blue)', height: 'fit-content'}}>
                <FileSpreadsheet size={18}/> Export CSV (Week {currentWeek})
              </button>
            </div>

            <div className="action-row" style={{display: 'flex', gap: '15px', marginBottom: '25px'}}>
              <div className="search-bar" style={{flex: 2, background: 'var(--card-bg)', border: '1px solid var(--border-color)'}}>
                <Search size={18} color="#94a3b8" />
                <input placeholder="Search student ID or Name..." onChange={(e) => setSearchTerm(e.target.value)} />
              </div>
              <button 
                onClick={() => { setIsScanning(!isScanning); setScanned(false); }} 
                className={`scan-btn-master ${isScanning ? 'is-active' : ''}`}
                style={{minWidth: '220px'}}
              >
                {isScanning ? '🛑 Stop Scanner' : '📷 Start Scanning'}
              </button>
            </div>

            {isScanning && (
              <div className="scanner-container" style={{marginBottom: '30px'}}>
                {!scanned ? (
                  <div className="scanner-frame" style={{maxWidth: '500px', margin: '0 auto', borderRadius: '24px', overflow: 'hidden', border: '4px solid var(--knust-green)'}}>
                    <Scanner onResult={handleScanSuccess} />
                    <div className="scanner-overlay"></div>
                  </div>
                ) : (
                  <div className="success-badge" style={{padding: '40px', background: 'var(--knust-green)', color: 'white', borderRadius: '20px', textAlign: 'center'}}>
                    <CheckCircle size={64} style={{marginBottom: '15px'}} />
                    <h2 style={{fontSize: '1.8rem'}}>{lastScanned}</h2>
                    <p style={{opacity: 0.9, marginBottom: '20px'}}>Attendance successfully logged.</p>
                    <button onClick={() => setScanned(false)} style={{background: 'white', color: 'var(--knust-green)', padding: '12px 30px', borderRadius: '12px', fontWeight: '800', border: 'none'}}>SCAN NEXT</button>
                  </div>
                )}
              </div>
            )}

            <div className="table-card table-wrapper">
              <div style={{padding: '20px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between'}}>
                <h3 style={{fontSize: '1rem'}}>Live Attendance List</h3>
                <span style={{fontSize: '0.8rem', color: 'var(--knust-green)', fontWeight: '700'}}>{(attendance[`${activeCourse.code}-W${currentWeek}`] || []).length} Students Present</span>
              </div>
              <table className="pro-table">
                <thead><tr><th>Student Details</th><th>Check-in Time</th><th>Verification</th></tr></thead>
                <tbody>
                  {(attendance[`${activeCourse.code}-W${currentWeek}`] || [])
                    .filter(s => s.studentID.includes(searchTerm) || s.fullName.toLowerCase().includes(searchTerm.toLowerCase()))
                    .map((s, i) => (
                      <tr key={i}>
                        <td><div className="student-cell"><span className="s-id">{s.studentID}</span><span className="s-name">{s.fullName}</span></div></td>
                        <td>{s.timeVerified}</td>
                        <td><span className="status-tag-verified" style={{display: 'flex', alignItems: 'center', gap: '5px', width: 'fit-content'}}><CheckCircle size={12}/> Verified</span></td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* --- 📜 STRUCTURED ATTENDANCE HISTORY --- */}
        {view === 'history' && activeCourse && (
          <div className="history-view fade-in">
            <div className="history-header" style={{marginBottom: '30px'}}>
                <button onClick={() => setView('session')} className="back-btn" style={{marginBottom: '20px'}}><ArrowLeft size={18}/> Back to Active Session</button>
                <h2 style={{fontSize: '2rem', color: 'var(--knust-blue)', fontWeight: '900'}}>Semester Ledger: {activeCourse.code}</h2>
                <p style={{color: 'var(--text-muted)'}}>Historical data organized by academic week.</p>
            </div>

            <div className="stats-grid">
                <div className="stat-card" style={{borderLeft: '5px solid var(--knust-blue)'}}><h3>Global Records</h3><p>{Object.values(attendance).flat().filter(s => s.courseCode === activeCourse.code).length}</p></div>
                <div className="stat-card" style={{borderLeft: '5px solid var(--knust-green)'}}><h3>Unique Students</h3><p>{new Set(Object.values(attendance).flat().filter(s => s.courseCode === activeCourse.code).map(s => s.studentID)).size}</p></div>
                <div className="stat-card" style={{borderLeft: '5px solid var(--knust-yellow)'}}><h3>Weeks Recorded</h3><p>{weeks.filter(w => attendance[`${activeCourse.code}-W${w}`]?.length > 0).length}</p></div>
            </div>

            <div className="history-content">
              {weeks.map(weekNum => {
                const weekData = attendance[`${activeCourse.code}-W${weekNum}`] || [];
                if (weekData.length === 0) return null;

                return (
                  <div key={weekNum} className="table-card" style={{marginBottom: '40px', padding: '0', overflow: 'hidden'}}>
                    <div style={{background: '#f8fafc', padding: '20px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                      <div>
                        <h3 style={{color: 'var(--knust-blue)', fontSize: '1.2rem'}}>Academic Week {weekNum}</h3>
                        <p style={{fontSize: '0.85rem', color: 'var(--text-muted)'}}>{weekData.length} records found</p>
                      </div>
                      <button onClick={() => downloadCSV(weekNum)} className="btn-download" style={{padding: '8px 16px', fontSize: '0.8rem'}}>
                        <Download size={14}/> Download Week {weekNum}
                      </button>
                    </div>
                    <table className="pro-table">
                      <thead><tr><th>Student</th><th>Time Logged</th><th>Status</th></tr></thead>
                      <tbody>
                        {weekData.map((s, idx) => (
                          <tr key={idx}>
                            <td><div className="student-cell"><span className="s-id">{s.studentID}</span><span className="s-name">{s.fullName}</span></div></td>
                            <td>{s.timeVerified}</td>
                            <td><span className="status-tag-verified">Verified</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}
              
              {weeks.every(w => (attendance[`${activeCourse.code}-W${w}`] || []).length === 0) && (
                <div style={{textAlign: 'center', padding: '100px 0', opacity: 0.5}}>
                  <History size={64} style={{margin: '0 auto 20px'}} />
                  <h3>No historical records found for this course.</h3>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}