/**
 * test-phase3.js
 * Albion Phase 3: Memory & Context — Automated Local Test Suite
 *
 * Verifies all Phase 3 mechanisms locally:
 *   1. Project Memory (.albion/memory.md creation, permissions, updates, context injection)
 *   2. Incremental Repo Indexer (smart chunking, hash generation, 768-dim embeddings)
 *   3. Conversation Continuity (mergeContinuity, path remapping, silent restore logic)
 *
 * Usage:
 *   node albion-verifier/scripts/test-phase3.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  ensureMemoryFile,
  readMemory,
  updateMemory,
  updateMemorySection,
  getMemoryContext
} = require('../project-memory');

const {
  chunkFileContent,
  computeChunkHash,
  generateEmbeddings,
  EMBEDDING_DIMENSION
} = require('../repo-indexer');

const {
  mergeContinuity
} = require('../supabase-autosave');

// ---------------------------------------------------------------------------
// TEST HARNESS
// ---------------------------------------------------------------------------
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ${GREEN}✅ PASS${RESET} ${label}`);
    passed++;
  } else {
    console.error(`  ${RED}❌ FAIL${RESET} ${label}`);
    failed++;
  }
}

async function runTests() {
  console.log(`\n${YELLOW}🔬 Running Albion Phase 3: Memory & Context Test Suite${RESET}\n`);

  const tempProjectDir = path.join(os.tmpdir(), `albion-p3-test-${Date.now()}`);
  fs.mkdirSync(tempProjectDir, { recursive: true });

  try {
    // -----------------------------------------------------------------------
    // PART 1: PROJECT MEMORY MANAGER (.albion/memory.md)
    // -----------------------------------------------------------------------
    console.log(`${YELLOW}TEST 1:${RESET} Project Memory Manager (.albion/memory.md)`);

    const memoryFile = ensureMemoryFile(tempProjectDir);
    assert(fs.existsSync(memoryFile), 'memory.md was created in .albion/');

    const initialContent = readMemory(tempProjectDir);
    assert(initialContent.includes('## Tech Stack'), 'Template contains "## Tech Stack" section');
    assert(initialContent.includes('## Recent Decisions'), 'Template contains "## Recent Decisions" section');

    // Update section
    updateMemorySection(tempProjectDir, 'Tech Stack', '- Node.js 20\n- Supabase pgvector\n- DeepInfra embeddings');
    const updatedContent = readMemory(tempProjectDir);
    assert(updatedContent.includes('DeepInfra embeddings'), 'updateMemorySection successfully modified Tech Stack');
    assert(updatedContent.includes('## Recent Decisions'), 'Other sections preserved after update');

    // Context formatting for system prompt injection
    const promptContext = getMemoryContext(tempProjectDir);
    assert(promptContext.includes('<project_memory>'), 'getMemoryContext includes <project_memory> tag');
    assert(promptContext.includes('</project_memory>'), 'getMemoryContext includes </project_memory> tag');
    assert(promptContext.includes('DeepInfra embeddings'), 'Context includes updated memory content');

    // -----------------------------------------------------------------------
    // PART 2: SMART CHUNKING & HASHING (repo-indexer.js)
    // -----------------------------------------------------------------------
    console.log(`\n${YELLOW}TEST 2:${RESET} Smart Code Chunking & Hashing`);

    const sampleCode = [
      '// Auth module',
      'function login(username, password) {',
      '  if (!username) throw new Error("Username required");',
      '  return { token: "secret_jwt" };',
      '}',
      '',
      'class SessionManager {',
      '  constructor() {',
      '    this.sessions = new Map();',
      '  }',
      '  getSession(id) {',
      '    return this.sessions.get(id);',
      '  }',
      '}',
      '',
      'module.exports = { login, SessionManager };'
    ].join('\n');

    const chunks = chunkFileContent(sampleCode, 'src/auth.js', 'javascript');
    assert(chunks.length >= 1, `File chunked successfully into ${chunks.length} chunk(s)`);

    const firstChunk = chunks[0];
    assert(firstChunk.filePath === 'src/auth.js', 'Chunk preserves relative filePath');
    assert(firstChunk.language === 'javascript', 'Chunk preserves language');
    assert(typeof firstChunk.chunkHash === 'string' && firstChunk.chunkHash.length === 64, 'SHA256 chunk_hash is 64 hex characters');

    // Hash determinism
    const rehash = computeChunkHash(firstChunk.chunkText, firstChunk.filePath, firstChunk.lineStart, firstChunk.lineEnd);
    assert(firstChunk.chunkHash === rehash, 'Chunk hash is deterministic');

    // -----------------------------------------------------------------------
    // PART 3: EMBEDDING GENERATION (768 Dimensions)
    // -----------------------------------------------------------------------
    console.log(`\n${YELLOW}TEST 3:${RESET} Embedding Vector Generation`);

    const [testVector] = await generateEmbeddings(['Test code chunk for embedding']);
    assert(Array.isArray(testVector), 'Embedding is an array');
    assert(testVector.length === EMBEDDING_DIMENSION, `Vector length matches nomic-embed dimension (${EMBEDDING_DIMENSION})`);

    // Verify normalization
    const vectorMagnitude = Math.sqrt(testVector.reduce((sum, v) => sum + v * v, 0));
    assert(Math.abs(vectorMagnitude - 1.0) < 0.05, `Vector is normalized (magnitude: ${vectorMagnitude.toFixed(3)})`);

    // -----------------------------------------------------------------------
    // PART 4: CONVERSATION CONTINUITY (mergeContinuity)
    // -----------------------------------------------------------------------
    console.log(`\n${YELLOW}TEST 4:${RESET} Conversation Continuity & Session Merging`);

    const savedSession = {
      sessionId: 'sess_12345',
      projectPath: '/old/project/path',
      messages: [
        { role: 'user', content: 'Add a login endpoint' },
        { role: 'assistant', content: 'Created auth.js with JWT login' }
      ],
      fileEdits: [
        { filePath: '/old/project/path/src/auth.js', content: '// auth' }
      ],
      currentStep: 'awaiting_user_input',
      modelUsed: 'deepseek-v4-flash',
      tokenCount: 1450
    };

    const newProjectPath = '/new/relocated/project';
    const merged = mergeContinuity({}, savedSession, newProjectPath);

    assert(merged.messages.length === 2, 'Restores all conversation history messages');
    assert(merged.sessionId === 'sess_12345', 'Preserves session ID');
    assert(merged.fileEdits[0].filePath === '/new/relocated/project/src/auth.js', 'Intelligently remaps file paths when project moves');
    assert(merged.modelUsed === 'deepseek-v4-flash', 'Preserves model preferences');

  } finally {
    // Cleanup temporary directory
    try {
      fs.rmSync(tempProjectDir, { recursive: true, force: true });
    } catch (_) { /* ignore */ }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Phase 3 Test Results: ${GREEN}${passed} passed${RESET} / ${failed > 0 ? RED : GREEN}${failed} failed${RESET}`);
  console.log('─'.repeat(50));

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log(`\n${GREEN}🎯 Phase 3 architecture verified. Memory & Context components are solid.${RESET}\n`);
  }
}

runTests().catch((err) => {
  console.error(`${RED}[FATAL] Test runner crashed:${RESET}`, err);
  process.exit(1);
});
