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
  const isHandlingResultRef = useRef(false);
  const generatedId = useId();
  const readerId = `qr-reader-${generatedId.replace(/[^a-zA-Z0-9]/g, '')}`;

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
    if (isHandlingResultRef.current) return;
    isHandlingResultRef.current = true;

    try {
      await onResult(decodedText);
      await stopCamera();
    } catch (scanError) {
      console.error('QR verification failed:', scanError);
      setError('The QR code could not be verified. Please try again.');
    } finally {
      isHandlingResultRef.current = false;
    }
  };

  const startCamera = async () => {
    setError('');
    setIsCameraMode(true);

    window.setTimeout(async () => {
      const scanner = scannerRef.current;
      if (!scanner) {
        setError('Scanner is not ready yet. Please try again.');
        setIsCameraMode(false);
        return;
      }

      try {
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          handleScanSuccess,
          () => {}
        );
      } catch (scanError) {
        console.error('QR camera failed:', scanError);
        const reason = scanError?.name === 'NotAllowedError'
          ? 'Camera permission was denied. Allow camera access or upload a QR image instead.'
          : 'Camera could not start. You can upload a QR image instead.';
        setError(reason);
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
    <div className="scanner-root">
      {error && (
        <div className="notice-card error scanner-alert">
          <AlertCircle size={16} /> {error}
        </div>
      )}

      <div
        id={readerId}
        className={`scanner-camera-frame ${isCameraMode ? 'is-active' : ''}`}
      />

      {!isCameraMode && (
        <div
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFile(e.dataTransfer.files[0]); }}
          className={`scanner-dropzone ${isDragging ? 'is-dragging' : ''}`}
        >
          <Upload size={40} />
          <p>Drop QR Code Here</p>
          <span>or click to select file</span>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => handleFile(e.target.files[0])}
            className="scanner-file-input"
          />
        </div>
      )}

      <div className="scanner-actions">
        {!isCameraMode ? (
          <button onClick={startCamera} className="toggle-btn camera">
            <Camera size={18} /> Use Camera
          </button>
        ) : (
          <button onClick={stopCamera} className="toggle-btn file">
            <RefreshCw size={18} /> Stop Camera
          </button>
        )}
      </div>

      {onClose && (
        <button onClick={onClose} className="scanner-close-btn">
          Close scanner
        </button>
      )}
    </div>
  );
}
