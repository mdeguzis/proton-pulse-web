import { SUPABASE_ANON_KEY } from './config.js?v=ffed3d84';

export function supabaseHeaders(session, extra = {}) {
  const h = { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json', ...extra };
  if (session?.access_token) h.Authorization = `Bearer ${session.access_token}`;
  else h.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
  return h;
}

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

export function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Compact local timestamp: YYYY-MM-DD HH:MM in 24-hour local time. Fits a
// table cell on one line and sorts naturally.
export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function friendlyReason(raw) {
  if (!raw) return '—';
  if (raw.startsWith('wordlist:')) return raw.replace('wordlist:', 'Wordlist: ');
  if (raw.startsWith('openai:')) return raw.replace('openai:', 'OpenAI: ');
  if (raw.startsWith('admin:')) return raw.replace('admin:', 'Admin: ');
  return raw;
}

// Role display labels, shared by the users api (search filter) and component (render).
export const ROLE_LABELS = { super_admin: 'Super Admin', moderator: 'Moderator' };
export function roleLabel(role) { return ROLE_LABELS[role] || 'User'; }
