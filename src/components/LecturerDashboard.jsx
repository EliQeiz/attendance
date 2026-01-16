import React, { useState, useEffect, useCallback } from 'react';
import Scanner from './Scanner';
import { Search, Download, LogOut, Menu, X, CheckCircle } from 'lucide-react'; 
import { Parser } from '@json2csv/plainjs';
// 🟢 Firebase Additions
import { db } from '../firebase'; 
import { collection, query, where, onSnapshot, addDoc, setDoc, doc } from "firebase/firestore";

export default function LecturerDashboard({ user, onLogout }) {
  const [courses, setCourses] = useState([]);
  const [attendance, setAttendance] = useState({});
  const [activeCourse, setActiveCourse] = useState(null);
  const [currentWeek, setCurrentWeek] = useState(1);
  const [isScanning, setIsScanning] = useState(false);
  const [scanned, setScanned] = useState(false); // 🟢 Tracks if a scan just happened
  const [lastScanned, setLastScanned] = useState(null); 
  const [searchTerm, setSearchTerm] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    const q = query(collection(db, "courses"), where("lecturerId", "==", user.id));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setCourses(snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id })));
    });
    return () => unsubscribe();
  }, [user.id]);

  useEffect(() => {
    if (!activeCourse) return;
    const sessionKey = `${activeCourse.code}-W${currentWeek}`;
    const q = query(collection(db, "attendance", sessionKey, "records"));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setAttendance(prev => ({
        ...prev,
        [sessionKey]: snapshot.docs.map(doc => doc.data())
      }));
    });
    return () => unsubscribe();
  }, [activeCourse, currentWeek]);

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

  // 🟢 FIXED: Captures Name and ID accurately and triggers "Scan Next" UI
  const handleScanSuccess = useCallback(async (rawResult) => {
    if (!activeCourse || scanned) return;
    const sessionKey = `${activeCourse.code}-W${currentWeek}`;
    
    // Improved extraction logic to capture names from the new QR format
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
      timestamp: new Date()
    });

    setLastScanned(extractedName);
    setScanned(true); // Switch to "Scan Next" view
  }, [activeCourse, currentWeek, scanned]);

  const downloadCSV = () => {
    const sessionKey = `${activeCourse.code}-W${currentWeek}`;
    const data = attendance[sessionKey] || [];
    if (!data.length) return alert("No records found.");
    try {
      const parser = new Parser({ fields: ['studentID', 'fullName', 'timeVerified', 'status'] });
      const csv = parser.parse(data);
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = window.URL.createObjectURL(blob);
      a.download = `${activeCourse.code}_Week${currentWeek}.csv`;
      a.click();
    } catch (e) { console.error(e); }
  };

  return (
    <div className="dashboard-layout">
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <img src="https://images.seeklogo.com/logo-png/35/2/kwame-nkrumah-university-of-science-technology-logo-png_seeklogo-350387.png" className="sidebar-logo" alt="KNUST" style={{ width: '80px' }} />
          <X className="mobile-close-btn" onClick={() => setSidebarOpen(false)} />
        </div>

        <div style={{ background: 'rgba(255,255,255,0.1)', padding: '15px', borderRadius: '12px', marginBottom: '20px' }}>
          <p style={{ fontSize: '0.7rem', opacity: 0.7 }}>LOGGED IN AS</p>
          <p><strong>{user.name}</strong></p>
          <p style={{ fontSize: '0.8rem', opacity: 0.8 }}>ID: {user.id}</p>
        </div>

        <div style={{ flexGrow: 1 }}></div>

        <button onClick={onLogout} className="logout-btn-sidebar" style={{
            background: '#be123c', color: 'white', border: 'none', padding: '14px', borderRadius: '12px', 
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            width: '100%', marginTop: 'auto', marginBottom: '50px'
        }}>
          <LogOut size={18} /> Logout
        </button>
      </aside>

      <main className="main-content">
        <div style={{display: 'flex', alignItems: 'center', marginBottom: '10px'}}>
            <button className="hamburger" onClick={() => setSidebarOpen(true)}>
                <Menu size={28} />
            </button>
            {activeCourse && <button onClick={() => setActiveCourse(null)} style={{background:'none', border:'none', cursor:'pointer', color:'#64748b', marginLeft: '10px'}}>← Back to Hub</button>}
        </div>

        {!activeCourse ? (
          <div className="hub">
            <h2 style={{color: '#003366', marginBottom: '25px'}}>Academic Hub</h2>
            <div className="table-card">
              <form onSubmit={addCourse} style={{display: 'flex', gap: '10px', flexWrap: 'wrap'}}>
                <input name="cn" placeholder="Course Title" required style={{flex: '2 1 200px', padding: '12px', borderRadius: '8px', border: '1px solid #ddd'}} />
                <input name="cc" placeholder="Code" required style={{flex: '1 1 100px', padding: '12px', borderRadius: '8px', border: '1px solid #ddd'}} />
                <button type="submit" style={{padding: '12px 25px', background: '#006837', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer'}}>Add Course</button>
              </form>
            </div>
            <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '20px'}}>
              {courses.map(c => (
                <div key={c.id} className="table-card" onClick={() => setActiveCourse(c)} style={{cursor: 'pointer', borderLeft: '5px solid #003366', marginBottom: 0}}>
                  <strong>{c.code}</strong><br/><small>{c.name}</small>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="session">
            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '10px'}}>
              <h2 style={{color: '#003366'}}>{activeCourse.code} - Attendance</h2>
              <button onClick={downloadCSV} className="btn-download"><Download size={18}/> Export CSV</button>
            </div>

            <div style={{display: 'flex', gap: '10px', margin: '20px 0', flexWrap: 'wrap'}}>
              <div style={{flex: 1, background: 'white', display: 'flex', alignItems: 'center', padding: '0 15px', borderRadius: '12px', border: '1px solid #ddd', minWidth: '200px'}}>
                <Search size={18} color="#94a3b8" />
                <input placeholder="Search Student ID..." onChange={(e) => setSearchTerm(e.target.value)} style={{border:'none', padding:'12px', width:'100%', outline:'none'}} />
              </div>
              <button onClick={() => { setIsScanning(!isScanning); setScanned(false); setLastScanned(null); }} style={{padding:'12px 30px', background: isScanning ? '#be123c' : '#006837', color:'white', border:'none', borderRadius:'12px', cursor: 'pointer', flex: '1 1 auto', fontWeight: 'bold'}}>
                {isScanning ? 'Close Scanner' : 'Start Scanning'}
              </button>
            </div>

            {isScanning && (
              <div className="table-card" style={{border: '3px solid #006837', padding: '10px', borderRadius: '16px', overflow: 'hidden', textAlign: 'center'}}>
                {!scanned ? (
                  <>
                    <Scanner onResult={handleScanSuccess} />
                    <p style={{marginTop: '10px', color: '#64748b', fontSize: '0.9rem'}}>Align the student's QR code within the frame</p>
                  </>
                ) : (
                  <div style={{padding: '30px', background: '#f0fdf4', borderRadius: '12px'}}>
                    <CheckCircle size={48} color="#166534" style={{marginBottom: '10px'}} />
                    <h3 style={{color: '#166534'}}>Verified: {lastScanned}</h3>
                    <button 
                      onClick={() => setScanned(false)} 
                      style={{marginTop: '20px', padding: '12px 25px', background: '#006837', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold'}}
                    >
                      Scan Next Student
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className="table-card" style={{overflowX: 'auto'}}>
              <table className="pro-table">
                <thead>
                  <tr><th>Student Details</th><th>Time</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {(attendance[`${activeCourse.code}-W${currentWeek}`] || [])
                    .filter(s => s.studentID.includes(searchTerm))
                    .sort((a,b) => b.timestamp?.seconds - a.timestamp?.seconds)
                    .map((s, i) => (
                      <tr key={i}>
                        <td>
                          <div style={{display: 'flex', flexDirection: 'column'}}>
                            <span style={{fontWeight: '700', color: '#003366'}}>{s.studentID}</span>
                            <span style={{fontSize: '0.75rem', color: '#64748b'}}>{s.fullName}</span>
                          </div>
                        </td>
                        <td>{s.timeVerified}</td>
                        <td><span style={{background: '#dcfce7', color: '#166534', padding: '5px 12px', borderRadius: '20px', fontSize: '0.75rem', fontWeight: 'bold'}}>Verified ✅</span></td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}