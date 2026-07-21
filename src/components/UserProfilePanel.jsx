import React, { useEffect, useMemo, useState } from 'react';
import { Camera, CheckCircle, IdCard, Save, ShieldCheck, UploadCloud } from 'lucide-react';
import { updateProfile } from 'firebase/auth';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { auth, db, storage } from '../firebase';

const MAX_PROFILE_IMAGE_BYTES = 2 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const stripControlCharacters = (value = '') => (
  Array.from(String(value), char => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : char;
  }).join('')
);

const cleanText = (value = '', maxLength = 120) => (
  stripControlCharacters(value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
);

const getInitials = (name = 'KNUST User') => (
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase())
    .join('') || 'KU'
);

export default function UserProfilePanel({ user, onUserUpdate }) {
  const [form, setForm] = useState({
    name: user?.name || '',
    phone: user?.phone || '',
    department: user?.department || '',
    programme: user?.programme || '',
    level: user?.level || '',
    bio: user?.bio || '',
    photoURL: user?.photoURL || ''
  });
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const initials = useMemo(() => getInitials(form.name || user?.name), [form.name, user?.name]);

  useEffect(() => {
    setForm({
      name: user?.name || '',
      phone: user?.phone || '',
      department: user?.department || '',
      programme: user?.programme || '',
      level: user?.level || '',
      bio: user?.bio || '',
      photoURL: user?.photoURL || ''
    });
  }, [user]);

  const updateField = (field, value) => {
    setForm(prev => ({ ...prev, [field]: value }));
    setError('');
    setStatus('');
  };

  const saveProfile = async (updates = form) => {
    if (!user?.uid) return;

    const profileUpdates = {
      name: cleanText(updates.name || user.name, 90),
      phone: cleanText(updates.phone, 30),
      department: cleanText(updates.department, 90),
      programme: cleanText(updates.programme, 90),
      level: cleanText(updates.level, 40),
      bio: cleanText(updates.bio, 220),
      photoURL: cleanText(updates.photoURL, 500),
      updatedAt: serverTimestamp()
    };

    if (!profileUpdates.name) {
      setError('Display name is required.');
      return;
    }

    setIsSaving(true);
    setError('');
    setStatus('Saving profile...');

    try {
      await setDoc(doc(db, 'users', user.uid), profileUpdates, { merge: true });

      if (auth.currentUser) {
        await updateProfile(auth.currentUser, {
          displayName: profileUpdates.name,
          photoURL: profileUpdates.photoURL || null
        }).catch(() => {});
      }

      const stateUpdates = { ...profileUpdates };
      delete stateUpdates.updatedAt;
      onUserUpdate?.(stateUpdates);
      setStatus('Profile updated successfully.');
    } catch (saveError) {
      console.error('Profile save failed:', saveError);
      setError('Unable to save profile. Check permissions and try again.');
      setStatus('');
    } finally {
      setIsSaving(false);
    }
  };

  const uploadProfileImage = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file || !user?.uid) return;

    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      setError('Upload a JPG, PNG, or WebP image.');
      return;
    }

    if (file.size > MAX_PROFILE_IMAGE_BYTES) {
      setError('Profile image must be under 2 MB.');
      return;
    }

    setIsUploading(true);
    setError('');
    setStatus('Uploading profile picture...');

    try {
      const extension = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
      const imageRef = ref(storage, `profilePictures/${user.uid}/avatar-${Date.now()}.${extension}`);
      await uploadBytes(imageRef, file, {
        contentType: file.type,
        customMetadata: {
          owner: user.uid,
          role: user.role || ''
        }
      });
      const photoURL = await getDownloadURL(imageRef);
      const nextForm = { ...form, photoURL };
      setForm(nextForm);
      await saveProfile(nextForm);
    } catch (uploadError) {
      console.error('Profile image upload failed:', uploadError);
      setError('Unable to upload profile picture. Check Storage rules and try again.');
      setStatus('');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <section className="profile-panel">
      <div className="profile-identity">
        <div className="profile-avatar">
          {form.photoURL ? (
            <img src={form.photoURL} alt={`${form.name || user.name} profile`} />
          ) : (
            <span>{initials}</span>
          )}
        </div>

        <div>
          <p className="aura-eyebrow">Profile Workspace</p>
          <h3>{form.name || user.name}</h3>
          <p>{user.role === 'lecturer' ? 'Lecturer Account' : 'Student Account'} - {user.knust_id || user.id}</p>
        </div>

        <label className="mini-action-btn present profile-upload-btn">
          <Camera size={15} />
          {isUploading ? 'Uploading...' : 'Photo'}
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={uploadProfileImage} disabled={isUploading || isSaving} />
        </label>
      </div>

      <div className="profile-form-grid">
        <input className="pro-input" placeholder="Display name" value={form.name} onChange={(event) => updateField('name', event.target.value)} />
        <input className="pro-input" placeholder="Phone number" value={form.phone} onChange={(event) => updateField('phone', event.target.value)} />
        <input className="pro-input" placeholder="Department" value={form.department} onChange={(event) => updateField('department', event.target.value)} />
        <input className="pro-input" placeholder={user.role === 'student' ? 'Programme' : 'Office / Faculty'} value={form.programme} onChange={(event) => updateField('programme', event.target.value)} />
        <input className="pro-input" placeholder={user.role === 'student' ? 'Academic level' : 'Title / Rank'} value={form.level} onChange={(event) => updateField('level', event.target.value)} />
        <input className="pro-input" placeholder="Short bio / advisory note" value={form.bio} onChange={(event) => updateField('bio', event.target.value)} />
      </div>

      {(status || error) && (
        <div className={`notice-card profile-notice ${error ? 'error' : 'success'}`}>
          {error ? <UploadCloud size={16} /> : <CheckCircle size={16} />}
          <span>{error || status}</span>
        </div>
      )}

      <div className="profile-meta-row">
        <span><IdCard size={14} /> {user.email || user.recoveryEmail || 'No email on file'}</span>
        <span><ShieldCheck size={14} /> Role locked by Firebase profile</span>
      </div>

      <button type="button" className="btn-download profile-save-btn" onClick={() => saveProfile()} disabled={isSaving || isUploading}>
        <Save size={16} /> {isSaving ? 'Saving...' : 'Save Profile'}
      </button>
    </section>
  );
}
