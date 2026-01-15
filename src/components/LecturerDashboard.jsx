import React, { useState, useEffect, useCallback } from 'react';
import Scanner from './Scanner';
import { Search, Download, ArrowLeft, PlusSquare, LogOut, CheckCircle } from 'lucide-react';
import { Parser } from '@json2csv/plainjs';

export default function LecturerDashboard({ user, onLogout }) {
  const [courses, setCourses] = useState(() => JSON.parse(localStorage.getItem(`courses_${user.id}`)) || []);
  const [attendance, setAttendance] = useState(() => JSON.parse(localStorage.getItem(`attendance_${user.id}`)) || {});
  const [activeCourse, setActiveCourse] = useState(null);
  const [currentWeek, setCurrentWeek] = useState(1);
  const [isScanning, setIsScanning] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  useEffect(() => { localStorage.setItem(`courses_${user.id}`, JSON.stringify(courses)); }, [courses, user.id]);
  useEffect(() => { localStorage.setItem(`attendance_${user.id}`, JSON.stringify(attendance)); }, [attendance, user.id]);

  const addCourse = (e) => {
    e.preventDefault();
    setCourses([...courses, { name: e.target.cn.value, code: e.target.cc.value, id: Date.now() }]);
    e.target.reset();
  };

  // 🛠️ FIXED: CONTINUOUS SCANNING & FULL NAME PARSING
  const handleScanSuccess = useCallback((rawResult) => {
    if (!activeCourse) return;
    
    const sessionKey = `${activeCourse.code}-W${currentWeek}`;

    // 1. Robust Data Extraction
    const idMatch = rawResult.match(/(\d{7,10})/); 
    const extractedID = idMatch ? idMatch[1] : "Unknown ID";
    
    // Clean Name: Remove "Name:", "ID:", and the ID numbers themselves
    const cleanedName = rawResult
      .replace(/Name:/gi, "")
      .replace(/ID:\s*\d+/gi, "")
      .replace(extractedID, "")
      .replace(/[:]/g, "")
      .trim();

    const extractedName = cleanedName || "Student " + extractedID;

    // 2. State Update without re-mounting the Scanner
    setAttendance(prevAttendance => {
      const currentSessionList = prevAttendance[sessionKey] || [];
      
      // Prevent duplicate scan processing
      if (currentSessionList.some(s => s.studentID === extractedID)) {
        return prevAttendance; 
      }

      const newEntry = { 
        studentID: extractedID, 
        fullName: extractedName, 
        timeVerified: new Date().toLocaleTimeString(),
        status: "Verified"
      };

      return {
        ...prevAttendance,
        [sessionKey]: [...currentSessionList, newEntry]
      };
    });
    
    // Notice: We NEVER call setIsScanning(false) here. 
    // The camera will remain active for the next student.
  }, [activeCourse, currentWeek]);

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
      {/* Sidebar and rest of UI remain identical to your working version */}
      <aside className="sidebar">
        <img src="https://images.seeklogo.com/logo-png/35/2/kwame-nkrumah-university-of-science-technology-logo-png_seeklogo-350387.png" className="sidebar-logo" alt="KNUST" />
        <div style={{background: 'rgba(255,255,255,0.1)', padding: '15px', borderRadius: '12px', marginTop: '20px', marginBottom: 'auto'}}>
          <p style={{fontSize: '0.7rem', opacity: 0.7}}>LOGGED IN AS</p>
          <p><strong>{user.name}</strong></p>
          <p style={{fontSize: '0.8rem', opacity: 0.8}}>ID: {user.id}</p>
        </div>
        <button onClick={onLogout} style={{background: '#be123c', color: 'white', border: 'none', padding: '12px', borderRadius: '8px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginTop: '20px'}}>
          <LogOut size={18}/> Logout
        </button>
      </aside>

      <main className="main-content">
        {!activeCourse ? (
          <div className="hub">
             {/* Hub Content */}
             <h2 style={{color: '#003366', marginBottom: '25px'}}>Academic Hub</h2>
            <div className="table-card">
              <form onSubmit={addCourse} style={{display: 'flex', gap: '10px'}}>
                <input name="cn" placeholder="Course Title" required style={{flex: 2, padding: '12px', borderRadius: '8px', border: '1px solid #ddd'}} />
                <input name="cc" placeholder="Code" required style={{flex: 1, padding: '12px', borderRadius: '8px', border: '1px solid #ddd'}} />
                <button type="submit" style={{padding: '0 25px', background: '#006837', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer'}}>Add Course</button>
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
            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px'}}>
              <button onClick={() => setActiveCourse(null)} style={{background:'none', border:'none', cursor:'pointer', color:'#64748b'}}>← Back to Hub</button>
              <h2 style={{color: '#003366'}}>{activeCourse.code}: {activeCourse.name}</h2>
              <button onClick={downloadCSV} className="btn-download"><Download size={18}/> Export CSV</button>
            </div>

            <div style={{display: 'flex', gap: '10px', margin: '20px 0'}}>
              <div style={{flex: 1, background: 'white', display: 'flex', alignItems: 'center', padding: '0 15px', borderRadius: '12px', border: '1px solid #ddd'}}>
                <Search size={18} color="#94a3b8" />
                <input placeholder="Search ID..." onChange={(e) => setSearchTerm(e.target.value)} style={{border:'none', padding:'12px', width:'100%', outline:'none'}} />
              </div>
              <button onClick={() => setIsScanning(!isScanning)} style={{padding:'0 30px', background: isScanning ? '#be123c' : '#006837', color:'white', border:'none', borderRadius:'12px', cursor: 'pointer'}}>
                {isScanning ? 'Close Scanner' : 'Start Scanning'}
              </button>
            </div>

            {/* THE SCANNER BOX - Kept alive by the useCallback pattern above */}
            {isScanning && (
              <div className="table-card" style={{border: '2px solid #006837'}}>
                <p style={{fontSize: '0.8rem', color: '#006837', marginBottom: '10px', fontWeight: 'bold'}}>LIVE SCANNER ACTIVE - BRING QR TO CAMERA</p>
                <Scanner onResult={handleScanSuccess} />
              </div>
            )}

            <div className="table-card">
              <table className="pro-table">
                <thead>
                  <tr><th>Student ID</th><th>Full Name</th><th>Time Verified</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {(attendance[`${activeCourse.code}-W${currentWeek}`] || [])
                    .filter(s => s.studentID.includes(searchTerm))
                    .map((s, i) => (
                      <tr key={i}>
                        <td style={{fontWeight: '700', color: '#003366'}}>{s.studentID}</td>
                        <td style={{fontWeight: '500'}}>{s.fullName}</td>
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