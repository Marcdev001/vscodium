# Albion Phase 3: Memory & Context — Local Testing Protocol

This document provides step-by-step instructions to verify Phase 3 components locally:
1. **Incremental Repo Indexer** (`repo-indexer.js`)
2. **Project Memory Manager** (`project-memory.js` / `.albion/memory.md`)
3. **Conversation Continuity Engine** (`supabase-autosave.js` / `mergeContinuity`)

---

## 1. Prerequisites

- Node.js 18+
- Active `.env` file in `albion-proxy` or `albion-verifier` with:
  ```ini
  SUPABASE_URL=https://<your-project-ref>.supabase.co
  SUPABASE_SERVICE_KEY=ey...
  DEEPINFRA_API_KEY=...  # Optional: offline embeddings used if omitted
  ```
- Supabase SQL schema from `docs/phase3-schema.sql` applied in your Supabase SQL Editor.

---

## 2. Automated Test Suite

Run the complete offline/online test suite in one command:

```powershell
node albion-verifier/scripts/test-phase3.js
```

This automated script verifies:
1. Auto-creation of `.albion/memory.md` with default template
2. Read-only permissions enforcement on `.albion/memory.md`
3. Agent update hook (`updateMemory` / `updateMemorySection`)
4. System prompt injection formatting (`getMemoryContext`)
5. Code chunking logic on function/class boundaries
6. SHA256 chunk hashing and deduplication
7. Continuity merge logic (`mergeContinuity`)
8. Offline embedding generation fallback (768 dimensions)

---

## 3. Manual Step-by-Step Verification with Live Supabase

### Step 3.1: Create Test Workspace
```powershell
$testDir = "$env:TEMP\albion-phase3-test"
New-Item -ItemType Directory -Force -Path "$testDir\src"

# File 1: Authentication module
@'
function authenticateUser(email, password) {
  if (!email || !password) throw new Error("Credentials required");
  return { id: "user_123", email };
}
module.exports = { authenticateUser };
'@ | Set-Content "$testDir\src\auth.js"

# File 2: Database service
@'
class DatabaseService {
  constructor(url) { this.url = url; }
  async query(sql) { return []; }
}
module.exports = { DatabaseService };
'@ | Set-Content "$testDir\src\db.js"
```

### Step 3.2: Test Incremental Indexer
Run indexer on the created files:
```javascript
const { indexChangedFiles } = require('./albion-verifier/repo-indexer');
await indexChangedFiles('test-user-id', testDir, ['src/auth.js', 'src/db.js']);
```
- Query Supabase: `SELECT file_path, line_start, line_end, chunk_hash FROM repo_embeddings;`
- Expected: 2 rows inserted.

### Step 3.3: Test Incremental Change (No duplicate embeddings)
Modify `src/auth.js` only, then run indexer again:
- Expected: Only `src/auth.js` has updated timestamp, `src/db.js` chunk hash was skipped.

### Step 3.4: Test Deletion Handling
Delete `src/db.js`:
```javascript
const { removeDeletedFile } = require('./albion-verifier/repo-indexer');
await removeDeletedFile('test-user-id', testDir, 'src/db.js');
```
- Query Supabase: rows for `src/db.js` are removed immediately.

### Step 3.5: Test Memory Manager
```javascript
const { ensureMemoryFile, updateMemorySection, getMemoryContext } = require('./albion-verifier/project-memory');

ensureMemoryFile(testDir);
updateMemorySection(testDir, 'Tech Stack', '- Node.js 20\n- PostgreSQL with pgvector\n- Express 5');

console.log(getMemoryContext(testDir));
```
- Expected: Prints prompt injection XML `<project_memory>` containing the updated Tech Stack.
