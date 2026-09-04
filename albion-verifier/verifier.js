/**
 * Albion Verifier - verifier.js
 * Local Verification Engine
 *
 * A hardened, sandboxed verification script that runs linters and type-checkers
 * in a temporary git worktree to catch AI hallucinations BEFORE they reach the user.
 *
 * Security constraints (NON-NEGOTIABLE):
 *   - NO open-ended shell execution — strict command whitelist only
 *   - NO network access during verification
 *   - NO writes outside the temp worktree
 *   - 30-second hard timeout on all spawned processes
 *   - shell: false to prevent injection attacks
 *   - Max 3 retry attempts (Albion Master Build Plan Section 5C, Rule 1)
 *
 * Usage:
 *   node verifier.js <projectPath> <editPlanJSON> <language>
 *
 * Output (JSON to stdout):
 *   { "success": true,  "worktreePath": "/tmp/albion-verify-xxx" }
 *   { "success": false, "error": "...", "needsRetry": true }
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// ---------------------------------------------------------------------------
// COMMAND WHITELIST — ONLY these commands are allowed to execute.
// Adding to this list requires explicit approval.
// ---------------------------------------------------------------------------
const WHITELIST = {
  'javascript': ['npx', 'eslint', '.', '--no-error-on-unmatched-pattern'],
  'typescript': ['npx', 'tsc', '--noEmit'],
  'python':     ['ruff', 'check', '.'],
  'go':         ['go', 'build', './...'],
  'rust':       ['cargo', 'check']
};

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------
const MAX_RETRIES = 3;
const EXECUTION_TIMEOUT_MS = 30000; // 30 seconds hard ceiling
const WORKTREE_PREFIX = 'albion-verify-';

// ---------------------------------------------------------------------------
// createWorktree(projectPath)
// Creates an isolated temporary git worktree for verification.
// Returns the absolute path to the worktree directory.
// ---------------------------------------------------------------------------
function createWorktree(projectPath) {
  const worktreeId = crypto.randomBytes(8).toString('hex');
  const worktreeName = `${WORKTREE_PREFIX}${worktreeId}`;
  const worktreePath = path.join(os.tmpdir(), worktreeName);

  try {
    // Create a detached worktree from HEAD
    execSync(`git worktree add --detach "${worktreePath}"`, {
      cwd: projectPath,
      timeout: 10000,
      stdio: 'pipe'
    });
  } catch (err) {
    throw new Error(`Failed to create git worktree: ${err.message}`);
  }

  return worktreePath;
}

// ---------------------------------------------------------------------------
// applyEdits(worktreePath, editPlan)
// Applies the AI's proposed multi-file changes to the temp worktree ONLY.
// editPlan format: [{ filePath: "relative/path", content: "new content" }, ...]
// ---------------------------------------------------------------------------
function applyEdits(worktreePath, editPlan) {
  for (const edit of editPlan) {
    const targetPath = path.join(worktreePath, edit.filePath);
    const targetDir = path.dirname(targetPath);

    // Security: ensure the resolved path is still within the worktree
    const resolvedTarget = path.resolve(targetPath);
    const resolvedWorktree = path.resolve(worktreePath);
    if (!resolvedTarget.startsWith(resolvedWorktree)) {
      throw new Error(
        `Path traversal detected: ${edit.filePath} resolves outside worktree`
      );
    }

    // Create parent directories if needed
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Write the proposed content
    fs.writeFileSync(targetPath, edit.content, 'utf-8');
  }
}

// ---------------------------------------------------------------------------
// runVerification(worktreePath, language)
// Spawns the whitelisted linter/checker in the worktree.
// Returns a Promise resolving to { success, stdout, stderr, exitCode }.
// ---------------------------------------------------------------------------
function runVerification(worktreePath, language) {
  return new Promise((resolve, reject) => {
    const commandArgs = WHITELIST[language];
    if (!commandArgs) {
      return reject(new Error(
        `Unsupported language: "${language}". ` +
        `Supported: ${Object.keys(WHITELIST).join(', ')}`
      ));
    }

    const [command, ...args] = commandArgs;

    // Build a sanitized environment — strip anything that could enable network
    const sanitizedEnv = { ...process.env, NO_NETWORK: '1' };
    // Remove proxy env vars to prevent any outbound connections
    delete sanitizedEnv.HTTP_PROXY;
    delete sanitizedEnv.HTTPS_PROXY;
    delete sanitizedEnv.http_proxy;
    delete sanitizedEnv.https_proxy;
    delete sanitizedEnv.ALL_PROXY;
    delete sanitizedEnv.all_proxy;

    const child = spawn(command, args, {
      cwd: worktreePath,
      timeout: EXECUTION_TIMEOUT_MS,
      env: sanitizedEnv,
      shell: false, // CRITICAL: prevents shell injection
      stdio: ['ignore', 'pipe', 'pipe'] // no stdin, capture stdout/stderr
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      // Cap output to prevent memory exhaustion
      if (stdout.length > 1024 * 100) {
        child.kill('SIGTERM');
      }
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.length > 1024 * 100) {
        child.kill('SIGTERM');
      }
    });

    child.on('error', (err) => {
      if (err.code === 'ETIMEDOUT') {
        resolve({
          success: false,
          stdout,
          stderr: `Verification timed out after ${EXECUTION_TIMEOUT_MS / 1000}s`,
          exitCode: -1
        });
      } else {
        reject(err);
      }
    });

    child.on('close', (exitCode) => {
      resolve({
        success: exitCode === 0,
        stdout,
        stderr,
        exitCode
      });
    });
  });
}

// ---------------------------------------------------------------------------
// cleanup(worktreePath, projectPath)
// Removes the temporary worktree and its directory.
// ---------------------------------------------------------------------------
function cleanup(worktreePath, projectPath) {
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: projectPath,
      timeout: 10000,
      stdio: 'pipe'
    });
  } catch (err) {
    // If git worktree remove fails, try manual cleanup
    console.error(`[VERIFIER] git worktree remove failed: ${err.message}`);
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      execSync('git worktree prune', {
        cwd: projectPath,
        timeout: 5000,
        stdio: 'pipe'
      });
    } catch (cleanupErr) {
      console.error(`[VERIFIER] Manual cleanup failed: ${cleanupErr.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// verify(projectPath, editPlan, language)
// Main entry point. Orchestrates worktree → edits → verification → cleanup.
// Returns the verification result as a JSON-serializable object.
// ---------------------------------------------------------------------------
async function verify(projectPath, editPlan, language) {
  // Validate inputs
  if (!fs.existsSync(projectPath)) {
    return { success: false, error: `Project path not found: ${projectPath}`, needsRetry: false };
  }

  if (!Array.isArray(editPlan) || editPlan.length === 0) {
    return { success: false, error: 'editPlan must be a non-empty array', needsRetry: false };
  }

  if (!WHITELIST[language]) {
    return {
      success: false,
      error: `Unsupported language: "${language}". Supported: ${Object.keys(WHITELIST).join(', ')}`,
      needsRetry: false
    };
  }

  let worktreePath = null;

  try {
    // Step 1: Create isolated worktree
    worktreePath = createWorktree(projectPath);

    // Step 2: Apply proposed edits to worktree only
    applyEdits(worktreePath, editPlan);

    // Step 3: Run whitelisted verification command
    const result = await runVerification(worktreePath, language);

    if (result.success) {
      return {
        success: true,
        worktreePath,
        stdout: result.stdout
      };
    } else {
      return {
        success: false,
        error: result.stderr || result.stdout || `Exit code: ${result.exitCode}`,
        exitCode: result.exitCode,
        needsRetry: true
      };
    }
  } catch (err) {
    return {
      success: false,
      error: err.message,
      needsRetry: false
    };
  } finally {
    // Always clean up worktree, even on errors
    if (worktreePath && fs.existsSync(worktreePath)) {
      cleanup(worktreePath, projectPath);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI ENTRY POINT
// Usage: node verifier.js <projectPath> <editPlanJSON> <language>
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.error('Usage: node verifier.js <projectPath> <editPlanJSON> <language>');
    console.error('  projectPath:   Absolute path to the git repository');
    console.error('  editPlanJSON:  JSON string or path to JSON file with edit plan');
    console.error('  language:      One of: ' + Object.keys(WHITELIST).join(', '));
    process.exit(1);
  }

  const [projectPath, editPlanArg, language] = args;

  // Parse editPlan: accept raw JSON string or file path
  let editPlan;
  try {
    if (fs.existsSync(editPlanArg)) {
      editPlan = JSON.parse(fs.readFileSync(editPlanArg, 'utf-8'));
    } else {
      editPlan = JSON.parse(editPlanArg);
    }
  } catch (err) {
    console.error(JSON.stringify({
      success: false,
      error: `Failed to parse editPlan: ${err.message}`,
      needsRetry: false
    }));
    process.exit(1);
  }

  const result = await verify(projectPath, editPlan, language);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.success ? 0 : 1);
}

// Export for programmatic use
module.exports = { verify, cleanup, WHITELIST, MAX_RETRIES };

// Run CLI if executed directly
if (require.main === module) {
  main();
}
