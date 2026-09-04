# Albion Verifier - Extension Integration Guide

This document explains how to wire `verifier.js` and `supabase-autosave.js` into the bundled Cline extension within Albion.

---

## 1. Supabase Schema Additions

Run these SQL statements in your Supabase SQL Editor to create the required tables:

### conversations table (Conversation Continuity)

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_path TEXT,
  state_json JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast lookups by user + project
CREATE INDEX idx_conversations_user_project
  ON conversations(user_id, project_path, updated_at DESC);

-- Index for session restore
CREATE INDEX idx_conversations_session
  ON conversations(session_id);

-- Enable RLS
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

-- Policy: users can only access their own conversations
CREATE POLICY "Users can manage own conversations"
  ON conversations
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

### Verify existing tables

Ensure these tables from Phase 1 exist:

```sql
-- subscriptions (Phase 1 - Cap Enforcement)
-- Should already exist with: user_id, tier, cycle_start, status

-- usage_logs (Phase 1 - Usage Tracking)
-- Should already exist with: user_id, model, prompt_tokens, completion_tokens, actual_cost, session_id, timestamp
```

### RPC function for cycle usage (Phase 1 dependency)

```sql
CREATE OR REPLACE FUNCTION get_current_cycle_usage(p_user_id UUID, p_cycle_start TIMESTAMPTZ)
RETURNS BIGINT AS $$
  SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0)::BIGINT
  FROM usage_logs
  WHERE user_id = p_user_id
    AND timestamp >= p_cycle_start;
$$ LANGUAGE sql STABLE;
```

---

## 2. Wiring the Verification Engine into Cline

### Option A: Custom MCP Tool (Recommended)

Register `verifier.js` as an MCP tool that Cline can invoke. Create an MCP server config at `albion-verifier/mcp-server.json`:

```json
{
  "mcpServers": {
    "albion-verifier": {
      "command": "node",
      "args": ["albion-verifier/verifier.js"],
      "description": "Local code verification engine. Runs linters in isolated git worktrees."
    }
  }
}
```

Add this to the Cline extension's MCP configuration in VSCodium settings:

```json
{
  "cline.mcpServers": {
    "albion-verifier": {
      "command": "node",
      "args": ["${workspaceFolder}/../albion-verifier/verifier.js"],
      "disabled": false
    }
  }
}
```

### Option B: Direct child_process Invocation

If MCP integration is not feasible, the extension can invoke the verifier directly:

```javascript
const { spawn } = require('child_process');

function runAlbionVerifier(projectPath, editPlan, language) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [
      path.join(__dirname, '..', 'albion-verifier', 'verifier.js'),
      projectPath,
      JSON.stringify(editPlan),
      language
    ], {
      timeout: 35000, // slightly above verifier's internal 30s timeout
      shell: false
    });

    let output = '';
    child.stdout.on('data', (d) => output += d);
    child.on('close', (code) => {
      try {
        resolve(JSON.parse(output));
      } catch (e) {
        reject(new Error(`Verifier output parse error: ${output}`));
      }
    });
  });
}
```

### Retry Logic (3 attempts max)

```javascript
const { MAX_RETRIES } = require('../albion-verifier/verifier');

async function verifyWithRetries(projectPath, editPlan, language, onRetry) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await runAlbionVerifier(projectPath, editPlan, language);

    if (result.success) {
      return result; // Verification passed
    }

    if (!result.needsRetry || attempt === MAX_RETRIES) {
      return result; // Fatal error or max retries exhausted
    }

    // Feed the error back to the AI for correction
    if (onRetry) {
      editPlan = await onRetry(result.error, attempt);
    }
  }
}
```

---

## 3. Wiring Conversation Continuity into Cline

### Hook into Cline's lifecycle events

The autosave module should be triggered at these points:

#### After each AI response (debounced save)

```javascript
const { saveTurn } = require('../albion-verifier/supabase-autosave');

// After each AI turn completes:
cline.onDidReceiveResponse((response) => {
  saveTurn(sessionId, userId, {
    projectPath: vscode.workspace.workspaceFolders[0].uri.fsPath,
    messages: cline.getConversationHistory(),
    fileEdits: cline.getPendingEdits(),
    currentStep: 'awaiting_user_input',
    modelUsed: response.model,
    tokenCount: response.usage?.total_tokens || 0
  });
});
```

#### On window close (immediate save)

```javascript
const { saveImmediately, flushAll } = require('../albion-verifier/supabase-autosave');

// In extension's deactivate() function:
export async function deactivate() {
  flushAll(); // Cancel pending debounces

  // Save final state immediately
  await saveImmediately(sessionId, userId, {
    projectPath: vscode.workspace.workspaceFolders[0].uri.fsPath,
    messages: cline.getConversationHistory(),
    fileEdits: cline.getPendingEdits(),
    currentStep: 'session_closed',
    modelUsed: lastModelUsed,
    tokenCount: totalTokensUsed
  });
}
```

#### On editor startup (session restore)

```javascript
const { loadLastSession } = require('../albion-verifier/supabase-autosave');

// In extension's activate() function:
export async function activate(context) {
  const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (projectPath && userId) {
    const lastSession = await loadLastSession(userId, projectPath);

    if (lastSession) {
      const restore = await vscode.window.showInformationMessage(
        `Restore your last Albion session from ${new Date(lastSession.updatedAt).toLocaleString()}?`,
        'Restore', 'Start Fresh'
      );

      if (restore === 'Restore') {
        cline.restoreConversation(lastSession.messages);
        cline.restoreFileEdits(lastSession.fileEdits);
      }
    }
  }
}
```

---

## 4. VSCodium Settings for Phase 2

Add these to your VSCodium `settings.json` (in addition to the Phase 1 settings):

```json
{
  "albion.verifierEnabled": true,
  "albion.verifierLanguage": "auto",
  "albion.autosaveEnabled": true,
  "albion.autosaveDebounceMs": 2000,
  "albion.maxVerificationRetries": 3
}
```

---

## 5. File Layout After Phase 2

```
vscodium/
├── albion-proxy/           # Phase 1: Backend Proxy Core
│   ├── server.js
│   ├── litellm_config.yaml
│   ├── .env.example
│   └── docs/
│
├── albion-verifier/        # Phase 2: Reliability Layer
│   ├── verifier.js         # Local Verification Engine
│   ├── supabase-autosave.js # Conversation Continuity
│   ├── package.json
│   └── docs/
│       └── extension-integration.md (this file)
│
└── bundled-extensions/
    └── saoudrizwan.claude-dev-4.1.16.vsix (Albion-wired)
```

---

## 6. Data Flow Diagram

```
User types prompt in Cline
  │
  ▼
Cline sends to Albion Proxy (Phase 1)
  │
  ▼
AI generates code edits
  │
  ├─► supabase-autosave.saveTurn()     ← Save conversation state (debounced 2s)
  │
  ▼
verifier.js (Phase 2)
  │
  ├─ 1. git worktree add (temp copy)
  ├─ 2. Apply AI edits to worktree
  ├─ 3. Run whitelisted linter (30s timeout)
  ├─ 4. If PASS → apply edits to real project
  ├─ 5. If FAIL → feed error back to AI (max 3 retries)
  └─ 6. git worktree remove (cleanup)
```
