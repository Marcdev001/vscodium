/**
 * albion-lifecycle.js
 * Albion Lifecycle Bridge
 *
 * Hooks into Cline's VSCode extension lifecycle events to wire up:
 *   1. Session restore on editor startup (loadLastSession)
 *   2. Debounced conversation autosave after each AI response (saveTurn)
 *   3. Immediate flush on editor shutdown (flushAll + saveImmediately)
 *
 * DEPENDENCY CONTRACT:
 *   - Uses ONLY the bundled @supabase/supabase-js from node_modules/
 *   - NO dynamic npm install. NO network calls beyond Supabase API.
 *   - All required modules are pre-bundled in resources/albion/verifier/node_modules/
 *
 * ENVIRONMENT:
 *   - ALBION_VERIFIER_PATH: set by the VSCodium launcher, points to resources/albion/verifier/
 *   - SUPABASE_URL: injected from user's Albion account settings
 *   - SUPABASE_USER_TOKEN: the user's JWT, not the service key (client-side auth only)
 */

'use strict';

const path = require('path');

// ---------------------------------------------------------------------------
// Resolve the autosave module from the bundled verifier path.
// ALBION_VERIFIER_PATH is set by the VSCodium launcher script.
// ---------------------------------------------------------------------------
const VERIFIER_PATH = process.env.ALBION_VERIFIER_PATH || path.join(__dirname);
const { saveTurn, saveImmediately, flushAll, loadLastSession } = require(
  path.join(VERIFIER_PATH, 'supabase-autosave.js')
);

// ---------------------------------------------------------------------------
// activate(context, cline, vscode)
//
// Call this from the Cline extension's activate() function.
// Attempts to restore the last session for this project and user.
//
// Parameters:
//   context  - VSCode ExtensionContext
//   cline    - Cline extension API object
//   vscode   - The vscode module (passed in to avoid a direct require)
// ---------------------------------------------------------------------------
async function activate(context, cline, vscode) {
  const userId = context.globalState.get('albion.userId');
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const projectPath = workspaceFolders?.[0]?.uri?.fsPath;

  if (!userId || !projectPath) {
    // No user logged in or no workspace open — skip restore
    return;
  }

  try {
    const lastSession = await loadLastSession(userId, projectPath);

    if (!lastSession) {
      return; // No previous session found — fresh start
    }

    const updatedAt = new Date(lastSession.updatedAt).toLocaleString();
    const choice = await vscode.window.showInformationMessage(
      `Albion: Restore your last session from ${updatedAt}?`,
      { modal: false },
      'Restore',
      'Start Fresh'
    );

    if (choice === 'Restore') {
      cline.restoreConversation(lastSession.messages);
      if (lastSession.fileEdits && lastSession.fileEdits.length > 0) {
        cline.restoreFileEdits(lastSession.fileEdits);
      }
    }
  } catch (err) {
    // Non-fatal: log and continue. Never block editor startup.
    console.error('[albion-lifecycle] Session restore failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// onResponse(sessionId, userId, cline, response)
//
// Call this inside Cline's onDidReceiveResponse event handler.
// Triggers the debounced (2s) Supabase upsert for the current conversation state.
//
// Parameters:
//   sessionId   - unique ID for this conversation session
//   userId      - Albion user ID from auth context
//   projectPath - absolute path to the open workspace
//   cline       - Cline extension API object
//   response    - the AI response object from the LLM
// ---------------------------------------------------------------------------
function onResponse(sessionId, userId, projectPath, cline, response) {
  // Non-blocking debounced save — returns a Promise but we don't await it here.
  // Errors are swallowed after logging; the user's workflow must never be interrupted
  // by an autosave failure.
  saveTurn(sessionId, userId, {
    projectPath,
    messages:     cline.getConversationHistory?.() || [],
    fileEdits:    cline.getPendingEdits?.()        || [],
    currentStep:  'awaiting_user_input',
    modelUsed:    response?.model                  || 'unknown',
    tokenCount:   response?.usage?.total_tokens    || 0
  }).catch((err) => {
    console.error('[albion-lifecycle] Autosave failed:', err.message);
  });
}

// ---------------------------------------------------------------------------
// deactivate(sessionId, userId, projectPath, cline)
//
// Call this from the Cline extension's deactivate() function.
// Flushes all pending debounced saves and performs an immediate final save.
//
// Parameters:
//   sessionId   - unique ID for this conversation session
//   userId      - Albion user ID from auth context
//   projectPath - absolute path to the open workspace
//   cline       - Cline extension API object
// ---------------------------------------------------------------------------
async function deactivate(sessionId, userId, projectPath, cline) {
  // Cancel all pending debounce timers — we're about to do an immediate save
  flushAll();

  try {
    await saveImmediately(sessionId, userId, {
      projectPath,
      messages:    cline.getConversationHistory?.() || [],
      fileEdits:   cline.getPendingEdits?.()        || [],
      currentStep: 'session_closed',
      modelUsed:   null,
      tokenCount:  0
    });
  } catch (err) {
    // On deactivate, we cannot show UI. Log and exit cleanly.
    console.error('[albion-lifecycle] Final save on deactivate failed:', err.message);
  }
}

module.exports = { activate, onResponse, deactivate };
