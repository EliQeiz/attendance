import React, { useEffect, useId, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { AlertCircle, Camera, RefreshCw, Upload } from 'lucide-react';

const clearScanner = (scanner) => {
  try {
    const result = scanner.clear();
    if (result?.catch) result.catch(() => {});
  } catch {
    // The library throws when the DOM node has already been removed.
  }
};

export default function Scanner({ onResult, onClose }) {
  const [isCameraMode, setIsCameraMode] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState('');
  const scannerRef = useRef(null);
  const generatedId = useId();
  const readerId = `qr-reader-${generatedId.replace(/:/g, '')}`;

  useEffect(() => {
    scannerRef.current = new Html5Qrcode(readerId);

    return () => {
      const scanner = scannerRef.current;
      if (!scanner) return;

      if (scanner.isScanning) {
        scanner.stop()
          .then(() => clearScanner(scanner))
          .catch(() => {});
      } else {
        clearScanner(scanner);
      }
    };
  }, [readerId]);

  const stopCamera = async () => {
    const scanner = scannerRef.current;
    if (scanner?.isScanning) {
      await scanner.stop();
    }
    setIsCameraMode(false);
  };

  const handleScanSuccess = async (decodedText) => {
    onResult(decodedText);
    await stopCamera();
  };

  const startCamera = async () => {
    setError('');
    setIsCameraMode(true);

    window.setTimeout(async () => {
      try {
        await scannerRef.current.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          handleScanSuccess,
          () => {}
        );
      } catch (scanError) {
        console.error('QR camera failed:', scanError);
        setError('Camera could not start. You can upload a QR image instead.');
        setIsCameraMode(false);
      }
    }, 50);
  };

  const handleFile = async (file) => {
    if (!file) return;
    setError('');

    try {
      const decodedText = await scannerRef.current.scanFile(file, true);
      await handleScanSuccess(decodedText);
    } catch (scanError) {
      console.error('QR file scan failed:', scanError);
      setError('No valid QR code was detected in this image.');
    }
  };

  return (
    <div className="scanner-root" style={{ minHeight: '360px' }}>
      {error && (
        <div style={{ background: '#fee2e2', color: '#b91c1c', padding: '10px', borderRadius: '8px', marginBottom: '10px', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <AlertCircle size={16} /> {error}
        </div>
      )}

      <div
        id={readerId}
        style={{
          display: isCameraMode ? 'block' : 'none',
          width: '100%',
          borderRadius: '12px',
          overflow: 'hidden',
          background: '#000'
        }}
      />

      {!isCameraMode && (
        <div
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFile(e.dataTransfer.files[0]); }}
          style={{
            border: '2px dashed #006837',
            borderRadius: '16px',
            padding: '48px 20px',
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

      <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'center', gap: '10px', flexWrap: 'wrap' }}>
        {!isCameraMode ? (
          <button onClick={startCamera} className="toggle-btn camera" style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
            <Camera size={18} /> Use Camera
          </button>
        ) : (
          <button onClick={stopCamera} className="toggle-btn file" style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
            <RefreshCw size={18} /> Stop Camera
          </button>
        )}
      </div>

      {onClose && (
        <button onClick={onClose} style={{ marginTop: '18px', background: 'none', border: 'none', color: '#be123c', cursor: 'pointer', width: '100%', textDecoration: 'underline' }}>
          Close QR fallback
        </button>
      )}
    </div>
  );
}
