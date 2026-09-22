import { createClient } from '@supabase/supabase-js';
import { performPasswordRecovery, performPasswordSignIn, performPasswordUpdate } from './auth-operations.js';
import { resolveApplicationUrl } from './auth-callback.js';
import { downloadPrivateJson } from './candle-storage.js';
import { fromDatabaseRecord, toDatabaseRecord } from './research.js';

const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
export const supabaseConfigured = Boolean(url && publishableKey);

let client;
export function getSupabase() {
  if (!supabaseConfigured) throw new Error('Supabase não configurado. Consulte .env.example.');
  if (!client) {
    client = createClient(url, publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }
  return client;
}

export function signInWithPassword(email, password) {
  return performPasswordSignIn(getSupabase().auth, email, password);
}

export function requestPasswordRecovery(email) {
  const redirectTo = resolveApplicationUrl(window.location.origin, import.meta.env.BASE_URL);
  return performPasswordRecovery(getSupabase().auth, email, redirectTo);
}

export function updatePassword(password) {
  return performPasswordUpdate(getSupabase().auth, password);
}

export function downloadCandleJson(objectPath) {
  return downloadPrivateJson(getSupabase().storage, objectPath);
}

export async function signOut() {
  const { error } = await getSupabase().auth.signOut();
  if (error) throw error;
}

export async function currentSession() {
  if (!supabaseConfigured) return null;
  const { data, error } = await getSupabase().auth.getSession();
  if (error) throw error;
  return data.session;
}

export function onAuthStateChange(callback) {
  if (!supabaseConfigured) return () => {};
  const { data } = getSupabase().auth.onAuthStateChange((event, session) => callback(event, session));
  return () => data.subscription.unsubscribe();
}

export async function getMembership(userId) {
  const { data, error } = await getSupabase()
    .from('research_members')
    .select('user_id,email,display_name,is_admin')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

const RECORD_SELECT = '*,author:research_members!research_annotations_author_id_fkey(display_name,email)';

export async function listResearchRecords(contract, tradingDate) {
  const { data, error } = await getSupabase()
    .from('research_annotations')
    .select(RECORD_SELECT)
    .eq('contract', contract)
    .eq('trading_date', tradingDate)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data.map(fromDatabaseRecord);
}

export async function listResearchHistory(contract) {
  const { data, error } = await getSupabase()
    .from('research_annotations')
    .select(RECORD_SELECT)
    .eq('contract', contract)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data.map(fromDatabaseRecord);
}

export async function saveResearchRecord(draft, id = null) {
  const payload = toDatabaseRecord(draft);
  const query = id
    ? getSupabase().from('research_annotations').update(payload).eq('id', id)
    : getSupabase().from('research_annotations').insert(payload);
  const { data, error } = await query.select(RECORD_SELECT).single();
  if (error) throw error;
  return fromDatabaseRecord(data);
}

export async function deleteResearchRecord(id) {
  const { error } = await getSupabase().from('research_annotations').delete().eq('id', id);
  if (error) throw error;
}
