import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { Camera, Upload, RefreshCw, AlertCircle } from 'lucide-react';

export default function Scanner({ onResult, onClose }) {
  const [scannedData, setScannedData] = useState(null);
  const [isCameraMode, setIsCameraMode] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState("");
  
  const scannerInstance = useRef(null);

  // Initialize once and stay initialized
  useEffect(() => {
    scannerInstance.current = new Html5Qrcode("reader");
    
    return () => {
      // Clean cleanup on component close
      if (scannerInstance.current?.isScanning) {
        scannerInstance.current.stop().catch(() => {});
      }
    };
  }, []);

  const handleScanSuccess = (decodedText) => {
    const idMatch = decodedText.match(/ID:\s*(\d+)/i) || decodedText.match(/(\d{7,10})/);
    const nameMatch = decodedText.match(/Name:\s*([^ID\n]+)/i);
    
    setScannedData({ 
      id: idMatch ? idMatch[1] : "Unknown", 
      name: nameMatch ? nameMatch[1].trim() : "Student" 
    });
    
    onResult(decodedText);
    if (isCameraMode) stopCamera();
  };

  const startCamera = async () => {
    setError("");
    try {
      setIsCameraMode(true);
      // Wait for next tick so display:block is active
      setTimeout(async () => {
        await scannerInstance.current.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          handleScanSuccess,
          () => {}
        );
      }, 50);
    } catch (err) {
      setError("Camera failed to start.");
      setIsCameraMode(false);
    }
  };

  const stopCamera = async () => {
    if (scannerInstance.current?.isScanning) {
      await scannerInstance.current.stop();
    }
    setIsCameraMode(false);
  };

  const handleFile = async (file) => {
    if (!file) return;
    setError("");
    try {
      const decodedText = await scannerInstance.current.scanFile(file, true);
      handleScanSuccess(decodedText);
    } catch (err) {
      setError("No QR code detected in this image.");
    }
  };

  return (
    <div className="scanner-root" style={{ minHeight: '380px' }}>
      {error && (
        <div style={{ background: '#fee2e2', color: '#b91c1c', padding: '10px', borderRadius: '8px', marginBottom: '10px', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {/* SUCCESS SCREEN */}
      {scannedData ? (
        <div style={{ textAlign: 'center', padding: '40px 20px', background: '#f0fdf4', borderRadius: '16px', border: '2px solid #006837' }}>
          <div style={{ fontSize: '3rem', marginBottom: '10px' }}>✅</div>
          <h3 style={{ color: '#065f46', margin: '0' }}>Verified!</h3>
          <p style={{ fontWeight: 'bold', fontSize: '1.2rem', color: '#003366', margin: '10px 0' }}>{scannedData.name}</p>
          <p style={{ color: '#64748b' }}>ID: {scannedData.id}</p>
          <button 
            onClick={() => { setScannedData(null); setIsCameraMode(false); }}
            className="next-btn"
          >
            <RefreshCw size={18} /> SCAN NEXT
          </button>
        </div>
      ) : (
        <>
          {/* THE READER DIV - NEVER REMOVE FROM DOM */}
          <div 
            id="reader" 
            style={{ 
              display: isCameraMode ? 'block' : 'none',
              width: '100%',
              borderRadius: '12px',
              overflow: 'hidden',
              background: '#000'
            }}
          ></div>

          {/* UPLOAD ZONE */}
          {!isCameraMode && (
            <div 
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFile(e.dataTransfer.files[0]); }}
              style={{
                border: '2px dashed #006837',
                borderRadius: '16px',
                padding: '60px 20px',
                background: isDragging ? '#f0fdf4' : '#fff',
                textAlign: 'center',
                position: 'relative'
              }}
            >
              <Upload size={40} color="#006837" style={{ marginBottom: '10px', opacity: 0.6 }} />
              <p style={{ fontWeight: '600', color: '#1e293b' }}>Drop QR Code Here</p>
              <p style={{ fontSize: '0.8rem', color: '#64748b' }}>or click to select file</p>
              <input 
                type="file" 
                accept="image/*" 
                onChange={(e) => handleFile(e.target.files[0])}
                style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
              />
            </div>
          )}

          <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'center' }}>
            {!isCameraMode ? (
              <button onClick={startCamera} className="toggle-btn camera">
                <Camera size={18} /> Use Live Camera
              </button>
            ) : (
              <button onClick={stopCamera} className="toggle-btn file">
                <Upload size={18} /> Switch to File Mode
              </button>
            )}
          </div>
        </>
      )}

      <button onClick={onClose} style={{ marginTop: '20px', background: 'none', border: 'none', color: '#be123c', cursor: 'pointer', width: '100%', textDecoration: 'underline' }}>
        Cancel and Close
      </button>
    </div>
  );
}