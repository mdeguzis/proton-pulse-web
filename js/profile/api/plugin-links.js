// Plugin-link edge-function helpers: list/complete/remove linked plugins.
import { SUPABASE_URL } from '../config.js';
import { supabaseHeaders } from './supabase.js';

export function pluginFunctionUrl(name) {
  return `${SUPABASE_URL}/functions/v1/${name}`;
}

export async function callPluginLinkFunction(name, session, body) {
  const r = await fetch(pluginFunctionUrl(name), {
    method: 'POST',
    headers: supabaseHeaders(session),
    body: JSON.stringify(body || {}),
  });
  const text = await r.text();
  const payload = text ? (() => { try { return JSON.parse(text); } catch { return { error: text }; } })() : {};
  if (!r.ok) throw new Error(payload.error || payload.message || `HTTP ${r.status}`);
  return payload;
}

export async function listLinkedPlugins(session) {
  return await callPluginLinkFunction('plugin-links-list', session, {});
}

export async function completePluginLink(linkCode, session) {
  return await callPluginLinkFunction('plugin-link-complete', session, { linkCode });
}

export async function removePluginLink(installationId, session) {
  return await callPluginLinkFunction('plugin-link-remove', session, { installationId });
}
