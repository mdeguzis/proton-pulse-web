// phrases (api) for the admin page.

import { SUPABASE_URL } from '../config.js';
import { supabaseHeaders } from '../utils.js';

export async function fetchBannedPhrases(session) {
  const url = `${SUPABASE_URL}/rest/v1/banned_phrases?select=*&order=created_at.desc`;
  const res = await fetch(url, { headers: supabaseHeaders(session) });
  if (!res.ok) throw new Error(`Fetch phrases failed: ${res.status}`);
  return res.json();
}


export async function addBannedPhrase(session, { pattern, is_regex, description }) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/banned_phrases`, {
    method: 'POST',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ pattern, is_regex: !!is_regex, description: description || null, created_by: session.user.id }),
  });
  if (!res.ok) throw new Error(`Add phrase failed: ${res.status} ${await res.text()}`);
}


export async function removeBannedPhrase(session, id) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/banned_phrases?id=eq.${id}`, {
    method: 'DELETE',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
  });
  if (!res.ok) throw new Error(`Remove phrase failed: ${res.status}`);
}


export async function toggleBannedPhrase(session, id, enabled) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/banned_phrases?id=eq.${id}`, {
    method: 'PATCH',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(`Toggle phrase failed: ${res.status}`);
}
