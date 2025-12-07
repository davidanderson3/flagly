import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const signInBtn = document.getElementById('authSignIn');
const signOutBtn = document.getElementById('authSignOut');
const profileLink = document.getElementById('profileLink');
const profileAvatar = document.getElementById('profileAvatar');

if (signInBtn) {
  signInBtn.style.visibility = 'hidden';
}

function setButton(btn, text, disabled = false) {
  if (!btn) return;
  btn.textContent = text;
  if (btn.tagName === 'BUTTON') {
    btn.disabled = disabled;
  }
  if (disabled) {
    btn.setAttribute('aria-disabled', 'true');
  } else {
    btn.removeAttribute('aria-disabled');
  }
}

function getInitial(user) {
  const name = user.displayName || user.email || '';
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const first = trimmed[0].toUpperCase();
  return /[A-Z]/.test(first) ? first : '🙂';
}

const config = window.FIREBASE_CONFIG || null;
const missingConfig =
  !config ||
  !config.apiKey ||
  String(config.apiKey).startsWith('REPLACE_WITH_');

if (missingConfig) {
  setButton(signInBtn, 'Sign-in disabled', true);
  if (signOutBtn) signOutBtn.style.display = 'none';
  if (profileLink) profileLink.style.display = 'none';
  if (signInBtn) {
    signInBtn.style.visibility = 'visible';
  }
} else {
  const app = initializeApp(config);
  const auth = getAuth(app);
  const provider = new GoogleAuthProvider();

  setButton(signInBtn, 'Sign In');
  if (signInBtn) signInBtn.style.display = 'inline-flex';
  if (signOutBtn) signOutBtn.style.display = 'none';
  if (profileLink) profileLink.style.display = 'none';

  onAuthStateChanged(auth, (user) => {
    if (!user) {
      setButton(signInBtn, 'Sign In', false);
      if (signInBtn) signInBtn.style.display = 'inline-flex';
      if (signInBtn) signInBtn.style.visibility = 'visible';
      if (signOutBtn) {
        signOutBtn.style.display = 'none';
        setButton(signOutBtn, 'Sign out', false);
      }
      if (profileLink) profileLink.style.display = 'none';
      return;
    }

    if (signInBtn) {
      signInBtn.style.display = 'none';
      setButton(signInBtn, 'Sign In', false);
    }
    if (signOutBtn) {
      setButton(signOutBtn, 'Sign out', false);
      signOutBtn.style.display = 'inline-flex';
    }
    if (profileLink && profileAvatar) {
      profileLink.style.display = 'inline-flex';
      profileLink.href = '/profile.html';
      const photo = user.photoURL;
      profileAvatar.textContent = '';
      profileAvatar.innerHTML = '';
      if (photo) {
        const img = document.createElement('img');
        img.src = photo;
        img.alt = 'Profile';
        profileAvatar.appendChild(img);
      } else {
        profileAvatar.textContent = getInitial(user);
      }
    }
  });

  if (signInBtn) {
    signInBtn.addEventListener('click', async (evt) => {
      evt.preventDefault();
      if (!auth.currentUser) {
        try {
          setButton(signInBtn, 'Signing in...', true);
          await signInWithPopup(auth, provider);
        } catch (err) {
          console.error('Sign-in failed', err);
          setButton(signInBtn, 'Sign In', false);
        }
      }
    });
  }

  if (signOutBtn) {
    signOutBtn.addEventListener('click', async (evt) => {
      evt.preventDefault();
      try {
        setButton(signOutBtn, 'Signing out...', true);
        await signOut(auth);
      } catch (err) {
        console.error('Sign-out failed', err);
        setButton(signOutBtn, 'Sign out', false);
      }
    });
  }
}
