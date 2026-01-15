import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCgGpneKP91LkEn0BL6gwg4iFayduNuC28",
  authDomain: "knust-attendance.firebaseapp.com",
  projectId: "knust-attendance",
  storageBucket: "knust-attendance.firebasestorage.app",
  messagingSenderId: "440470715605",
  appId: "1:440470715605:web:1fcda573016e560b15365c",
  measurementId: "G-F1HNK8SKM4"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// 🟢 EXPORT THESE - This is the "Engine" that makes your site work
export const auth = getAuth(app);
export const db = getFirestore(app);

export default app;