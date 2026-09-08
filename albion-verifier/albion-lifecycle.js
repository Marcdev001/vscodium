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
// Resolve modules from the bundled verifier path.
// ALBION_VERIFIER_PATH is set by the VSCodium launcher script.
// ---------------------------------------------------------------------------
const VERIFIER_PATH = process.env.ALBION_VERIFIER_PATH || path.join(__dirname);
const {
  saveTurn,
  saveImmediately,
  flushAll,
  restoreSessionSilently
} = require(path.join(VERIFIER_PATH, 'supabase-autosave.js'));

const { ensureMemoryFile } = require(path.join(VERIFIER_PATH, 'project-memory.js'));
const { indexChangedFiles } = require(path.join(VERIFIER_PATH, 'repo-indexer.js'));

// ---------------------------------------------------------------------------
// DOCUMENT CHANGE DEBOUNCER
// Debounces active keystrokes (1.5s idle window) so unsaved changes are
// indexed without spamming the embedding endpoint on every keystroke.
// ---------------------------------------------------------------------------
const indexDebounceTimers = new Map();
const INDEX_DEBOUNCE_MS = 1500;

/**
 * Queues an incremental index call for a changed file.
 * Resets debounce timer if the same file is modified again within the idle window.
 */
function queueDocumentIndex(
  filePath,
  projectPath,
  userId,
  onIndexCallback = indexChangedFiles,
  delayMs = INDEX_DEBOUNCE_MS
) {
  if (indexDebounceTimers.has(filePath)) {
    clearTimeout(indexDebounceTimers.get(filePath));
  }

  return new Promise((resolve) => {
    const timer = setTimeout(async () => {
      indexDebounceTimers.delete(filePath);
      try {
        const res = await onIndexCallback(userId, projectPath, [filePath]);
        resolve({ indexed: true, result: res });
      } catch (err) {
        resolve({ indexed: false, error: err.message });
      }
    }, delayMs);

    indexDebounceTimers.set(filePath, timer);
  });
}

/**
 * Wires VS Code's onDidChangeTextDocument event to the incremental repo indexer.
 */
function wireDocumentWatcher(context, vscode, userId) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) return;
  const projectPath = workspaceFolders[0].uri.fsPath;

  const disposable = vscode.workspace.onDidChangeTextDocument((event) => {
    const document = event.document;

    // Ignore non-file schemes (git diffs, outputs, debug consoles)
    if (document.uri.scheme !== 'file') return;

    const filePath = document.uri.fsPath;

    // Ignore .albion, node_modules, and git files
    if (
      filePath.includes('node_modules') ||
      filePath.includes('.git') ||
      filePath.includes('.albion')
    ) {
      return;
    }

    queueDocumentIndex(filePath, projectPath, userId);
  });

  context.subscriptions.push(disposable);
}

// ---------------------------------------------------------------------------
// activate(context, cline, vscode)
//
// Called from Cline extension's activate() before webview / UI renders.
// Performs silent session restore and wires real-time indexer.
// ---------------------------------------------------------------------------
async function activate(context, cline, vscode) {
  const userId = context.globalState.get('albion.userId');
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const projectPath = workspaceFolders?.[0]?.uri?.fsPath;

  if (!userId || !projectPath) return;

  // 1. Ensure .albion/memory.md exists
  try {
    ensureMemoryFile(projectPath);
  } catch (err) {
    console.warn('[ALBION-LIFECYCLE] Failed to verify .albion/memory.md:', err.message);
  }

  // 2. Silent Session Restore (ZERO modal, ZERO dialog, ZERO flicker)
  try {
    const result = await restoreSessionSilently(userId, projectPath, cline);
    if (result.restored) {
      vscode.window.setStatusBarMessage(
        `$(check) Albion: Restored session (${result.messageCount} messages)`,
        4000
      );
    }
  } catch (err) {
    console.error('[ALBION-LIFECYCLE] Silent restore failed:', err.message);
  }

  // 3. Wire real-time document watcher for incremental indexing
  wireDocumentWatcher(context, vscode, userId);
}

// ---------------------------------------------------------------------------
// onResponse(sessionId, userId, projectPath, cline, response)
//
// Called inside Cline's onDidReceiveResponse event handler.
// Triggers the debounced (2s) Supabase upsert for the current conversation state.
// ---------------------------------------------------------------------------
function onResponse(sessionId, userId, projectPath, cline, response) {
  saveTurn(sessionId, userId, {
    projectPath,
    messages: cline.getConversationHistory?.() || [],
    fileEdits: cline.getPendingEdits?.() || [],
    currentStep: 'awaiting_user_input',
    modelUsed: response?.model || 'unknown',
    tokenCount: response?.usage?.total_tokens || 0
  }).catch((err) => {
    console.error('[albion-lifecycle] Autosave failed:', err.message);
  });
}

// ---------------------------------------------------------------------------
// deactivate(sessionId, userId, projectPath, cline)
// ---------------------------------------------------------------------------
async function deactivate(sessionId, userId, projectPath, cline) {
  flushAll();

  // Cancel any pending index debounces
  for (const [, timer] of indexDebounceTimers.entries()) {
    clearTimeout(timer);
  }
  indexDebounceTimers.clear();

  try {
    await saveImmediately(sessionId, userId, {
      projectPath,
      messages: cline.getConversationHistory?.() || [],
      fileEdits: cline.getPendingEdits?.() || [],
      currentStep: 'session_closed',
      modelUsed: null,
      tokenCount: 0
    });
  } catch (err) {
    console.error('[albion-lifecycle] Final save on deactivate failed:', err.message);
  }
}

module.exports = {
  activate,
  onResponse,
  deactivate,
  queueDocumentIndex,
  wireDocumentWatcher,
  INDEX_DEBOUNCE_MS
};

