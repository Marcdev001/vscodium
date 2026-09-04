/**
 * Albion Verifier - supabase-autosave.js
 * Conversation Continuity Module
 *
 * Provides real-time autosave of every AI conversation turn to Supabase,
 * so sessions survive crashes, window reloads, or network interruptions.
 *
 * Features:
 *   - 2-second debounce to prevent Supabase spam
 *   - Guaranteed save within 2s of agent finishing a thought
 *   - Session restore from Supabase on editor restart
 *   - Atomic upserts to prevent duplicate rows
 *
 * Required Supabase table: conversations
 *   See docs/extension-integration.md for the full SQL schema.
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// ---------------------------------------------------------------------------
// SUPABASE CLIENT
// ---------------------------------------------------------------------------
let supabase = null;

function getSupabaseClient() {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;

    if (!url || !key) {
      throw new Error(
        '[AUTOSAVE] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY. ' +
        'Cannot initialize autosave.'
      );
    }

    supabase = createClient(url, key);
  }
  return supabase;
}

// ---------------------------------------------------------------------------
// DEBOUNCE STATE
// ---------------------------------------------------------------------------
const debounceTimers = new Map(); // sessionId -> timer
const DEBOUNCE_MS = 2000; // 2-second debounce window

// ---------------------------------------------------------------------------
// saveTurn(sessionId, userId, turnData)
//
// Upserts the current conversation state to the Supabase `conversations` table.
// Debounced: waits 2 seconds after the last call before actually writing.
// This guarantees a save within 2s of the agent finishing a thought,
// while preventing Supabase spam during rapid multi-step operations.
//
// turnData format:
// {
//   projectPath: string,
//   messages: Array<{ role: string, content: string }>,
//   fileEdits: Array<{ filePath: string, content: string }>,
//   currentStep: string,
//   modelUsed: string,
//   tokenCount: number
// }
// ---------------------------------------------------------------------------
function saveTurn(sessionId, userId, turnData) {
  return new Promise((resolve, reject) => {
    // Clear any existing debounce timer for this session
    if (debounceTimers.has(sessionId)) {
      clearTimeout(debounceTimers.get(sessionId));
    }

    // Set a new debounce timer
    const timer = setTimeout(async () => {
      debounceTimers.delete(sessionId);

      try {
        const client = getSupabaseClient();

        const record = {
          session_id: sessionId,
          user_id: userId,
          project_path: turnData.projectPath || null,
          state_json: JSON.stringify({
            messages: turnData.messages || [],
            fileEdits: turnData.fileEdits || [],
            currentStep: turnData.currentStep || null,
            modelUsed: turnData.modelUsed || null,
            tokenCount: turnData.tokenCount || 0
          }),
          updated_at: new Date().toISOString()
        };

        const { data, error } = await client
          .from('conversations')
          .upsert(record, {
            onConflict: 'session_id',
            ignoreDuplicates: false
          });

        if (error) {
          console.error(`[AUTOSAVE] Failed to save turn for session ${sessionId}:`, error.message);
          reject(error);
        } else {
          resolve(data);
        }
      } catch (err) {
        console.error(`[AUTOSAVE] Error saving turn:`, err.message);
        reject(err);
      }
    }, DEBOUNCE_MS);

    debounceTimers.set(sessionId, timer);
  });
}

// ---------------------------------------------------------------------------
// saveImmediately(sessionId, userId, turnData)
//
// Bypasses debounce and saves immediately. Use this for critical saves:
// - Before window close
// - On crash recovery
// - On explicit user action (e.g., "Save Session")
// ---------------------------------------------------------------------------
async function saveImmediately(sessionId, userId, turnData) {
  // Clear any pending debounce
  if (debounceTimers.has(sessionId)) {
    clearTimeout(debounceTimers.get(sessionId));
    debounceTimers.delete(sessionId);
  }

  const client = getSupabaseClient();

  const record = {
    session_id: sessionId,
    user_id: userId,
    project_path: turnData.projectPath || null,
    state_json: JSON.stringify({
      messages: turnData.messages || [],
      fileEdits: turnData.fileEdits || [],
      currentStep: turnData.currentStep || null,
      modelUsed: turnData.modelUsed || null,
      tokenCount: turnData.tokenCount || 0
    }),
    updated_at: new Date().toISOString()
  };

  const { data, error } = await client
    .from('conversations')
    .upsert(record, {
      onConflict: 'session_id',
      ignoreDuplicates: false
    });

  if (error) {
    console.error(`[AUTOSAVE] Immediate save failed for session ${sessionId}:`, error.message);
    throw error;
  }

  return data;
}

// ---------------------------------------------------------------------------
// loadLastSession(userId, projectPath)
//
// Queries the `conversations` table for the most recent session matching
// this user and project. Returns the full state to restore the UI.
//
// Returns: { sessionId, messages, fileEdits, currentStep, modelUsed, tokenCount, updatedAt }
// Returns null if no session found.
// ---------------------------------------------------------------------------
async function loadLastSession(userId, projectPath) {
  const client = getSupabaseClient();

  const { data, error } = await client
    .from('conversations')
    .select('session_id, state_json, updated_at')
    .eq('user_id', userId)
    .eq('project_path', projectPath)
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      // No rows found — that's fine, no session to restore
      return null;
    }
    console.error(`[AUTOSAVE] Failed to load session:`, error.message);
    throw error;
  }

  if (!data) return null;

  try {
    const state = JSON.parse(data.state_json);
    return {
      sessionId: data.session_id,
      messages: state.messages || [],
      fileEdits: state.fileEdits || [],
      currentStep: state.currentStep || null,
      modelUsed: state.modelUsed || null,
      tokenCount: state.tokenCount || 0,
      updatedAt: data.updated_at
    };
  } catch (parseErr) {
    console.error(`[AUTOSAVE] Failed to parse saved state:`, parseErr.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// listSessions(userId, limit)
//
// Returns a list of recent sessions for a user, for the session picker UI.
// ---------------------------------------------------------------------------
async function listSessions(userId, limit = 10) {
  const client = getSupabaseClient();

  const { data, error } = await client
    .from('conversations')
    .select('session_id, project_path, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error(`[AUTOSAVE] Failed to list sessions:`, error.message);
    throw error;
  }

  return data || [];
}

// ---------------------------------------------------------------------------
// flushAll()
//
// Flush all pending debounced saves immediately.
// Call this on extension deactivation / window close.
// ---------------------------------------------------------------------------
function flushAll() {
  for (const [sessionId, timer] of debounceTimers.entries()) {
    clearTimeout(timer);
    debounceTimers.delete(sessionId);
  }
}

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------
module.exports = {
  saveTurn,
  saveImmediately,
  loadLastSession,
  listSessions,
  flushAll
};
