# Albion Verifier - Local Testing Protocol

This guide verifies the complete Phase 2 pipeline locally without needing the full editor.

---

## Prerequisites

- Git installed and accessible on PATH
- Node.js 16+
- For language-specific tests: `ruff` (Python), or `npx eslint` (JavaScript)

---

## Setup: Create a Dummy Git Repo for Testing

Run these commands once to create a test project:

```powershell
# Create a temporary test project
New-Item -ItemType Directory -Force -Path $env:TEMP\albion-test-project
cd $env:TEMP\albion-test-project
git init
git config user.email "test@albion.dev"
git config user.name "Albion Test"

# Create a baseline Python file and commit it
'def hello():\n    print("Hello from Albion")' | Out-File -FilePath main.py -Encoding utf8
git add main.py
git commit -m "Initial commit"
```

---

## Test 1: Failing Verification (Python Syntax Error)

This test verifies the verifier catches a bad AI edit and returns `success: false`.

```powershell
# Create a mock edit plan with a Python syntax error
$editPlan = '[{"filePath":"main.py","content":"def hello(\n    print(\"missing paren\")"}]' | ConvertTo-Json -Compress

# Write to a temp file (avoids shell quoting issues)
$editPlan | Out-File -FilePath $env:TEMP\edit-fail.json -Encoding utf8

# Run the verifier against the test project
cd c:\Users\martin\albion-build\vscodium\albion-verifier
node verifier.js $env:TEMP\albion-test-project $env:TEMP\edit-fail.json python
```

**Expected output:**
```json
{
  "success": false,
  "error": "main.py:2:5: E999 SyntaxError: ...",
  "exitCode": 1,
  "needsRetry": true
}
```

---

## Test 2: Passing Verification (Valid Python Edit)

This test verifies the verifier returns `success: true` for clean code.

```powershell
# Create a valid edit plan
$goodEdit = '[{"filePath":"main.py","content":"def hello():\n    \"\"\"Greet the user.\"\"\"\n    print(\"Hello from Albion\")\n"}]'
$goodEdit | Out-File -FilePath $env:TEMP\edit-pass.json -Encoding utf8

node verifier.js $env:TEMP\albion-test-project $env:TEMP\edit-pass.json python
```

**Expected output:**
```json
{
  "success": true,
  "worktreePath": "C:\\Users\\...\\AppData\\Local\\Temp\\albion-verify-xxxxxxxx",
  "stdout": ""
}
```

> **Note:** Even on success, the worktree is cleaned up immediately. The `worktreePath` in the output is already gone by the time you see it.

---

## Test 3: 30-Second Timeout Enforcement

This test verifies the timeout kills a hanging process.

```powershell
# Create a Python file that runs forever
'import time\nwhile True:\n    time.sleep(1)\n' | Out-File -FilePath $env:TEMP\hang.json -Encoding utf8

# Create an edit plan that replaces main.py with the infinite loop
$hangEdit = '[{"filePath":"main.py","content":"import time\nwhile True:\n    time.sleep(1)\n"}]'
$hangEdit | Out-File -FilePath $env:TEMP\edit-hang.json -Encoding utf8

# This should time out after 30 seconds and return success: false
node verifier.js $env:TEMP\albion-test-project $env:TEMP\edit-hang.json python
```

**Expected output (after ~30 seconds):**
```json
{
  "success": false,
  "error": "Verification timed out after 30s",
  "exitCode": -1,
  "needsRetry": true
}
```

---

## Test 4: Path Traversal Attack Prevention

This test verifies the security boundary — a malicious edit cannot escape the worktree.

```powershell
# Attempt to write outside the worktree via path traversal
$maliciousEdit = '[{"filePath":"../../evil.txt","content":"pwned"}]'
$maliciousEdit | Out-File -FilePath $env:TEMP\edit-traversal.json -Encoding utf8

node verifier.js $env:TEMP\albion-test-project $env:TEMP\edit-traversal.json python
```

**Expected output:**
```json
{
  "success": false,
  "error": "Path traversal detected: ../../evil.txt resolves outside worktree",
  "needsRetry": false
}
```

---

## Test 5: Unsupported Language Rejection

```powershell
node verifier.js $env:TEMP\albion-test-project $env:TEMP\edit-pass.json ruby
```

**Expected output:**
```json
{
  "success": false,
  "error": "Unsupported language: \"ruby\". Supported: javascript, typescript, python, go, rust",
  "needsRetry": false
}
```

---

## Test 6: Autosave Module (Requires Real Supabase Credentials)

Create a `.env` file in `albion-verifier/`:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGci...your-service-role-key
```

Then run this quick test script:

```javascript
// Save as albion-verifier/scripts/test-autosave.js and run: node scripts/test-autosave.js
require('dotenv').config();
const { saveTurn, loadLastSession } = require('../supabase-autosave');

const TEST_USER_ID = 'your-test-user-uuid-from-supabase';
const TEST_SESSION = `test-session-${Date.now()}`;

async function main() {
  console.log('Testing saveTurn (debounced - will write after 2s)...');
  await saveTurn(TEST_SESSION, TEST_USER_ID, {
    projectPath: 'C:\\test\\project',
    messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi!' }],
    fileEdits: [],
    currentStep: 'test',
    modelUsed: 'deepseek-v4-flash',
    tokenCount: 42
  });

  console.log('Waiting 3s for debounce to fire...');
  await new Promise(r => setTimeout(r, 3000));

  console.log('Testing loadLastSession...');
  const session = await loadLastSession(TEST_USER_ID, 'C:\\test\\project');
  console.log('Restored session:', JSON.stringify(session, null, 2));

  if (session && session.messages.length === 2) {
    console.log('PASS: Autosave and restore working correctly');
  } else {
    console.log('FAIL: Session data mismatch');
  }
}

main().catch(console.error);
```

---

## Test Results Checklist

| Test | What It Verifies | Expected Result |
|------|-----------------|-----------------|
| Test 1 | Bad AI edit caught | `success: false, needsRetry: true` |
| Test 2 | Good AI edit passes | `success: true` |
| Test 3 | 30s timeout fires | Times out, returns `success: false` |
| Test 4 | Path traversal blocked | Error, `needsRetry: false` |
| Test 5 | Unknown language rejected | Error with supported list |
| Test 6 | Autosave + restore | Saved state matches loaded state |

All 6 tests must pass before Phase 2 is considered complete.
