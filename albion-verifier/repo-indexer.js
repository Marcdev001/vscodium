/**
 * albion-verifier - repo-indexer.js
 * Incremental Repo Indexing Engine (Phase 3: Memory & Context)
 *
 * Incrementally chunks, embeds, and upserts code files into Supabase pgvector (repo_embeddings).
 * Only processes changed files triggered by file watchers — never full scans after first init.
 *
 * Constraints:
 *   - No Pinecone / Weaviate: All embeddings live in Supabase pgvector.
 *   - Incremental only: Processes changed/deleted files only.
 *   - Smart chunking: Max ~500 tokens (~2000 chars), splitting by function/class/block boundaries.
 *   - Batching: Max 10 files per batch to prevent rate limiting.
 *   - Uses DeepInfra nomic-embed-text-v1.5 (768 dimensions) for speed & low cost.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// ---------------------------------------------------------------------------
// CONSTANTS & CONFIGURATION
// ---------------------------------------------------------------------------
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'nomic-ai/nomic-embed-text-v1.5';
const EMBEDDING_DIMENSION = 768;
const DEEPINFRA_API_URL = process.env.DEEPINFRA_BASE_URL || 'https://api.deepinfra.com/v1/embeddings';
const MAX_CHUNK_TOKENS = 500; // ~2000 characters
const APPROX_CHARS_PER_TOKEN = 4;
const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * APPROX_CHARS_PER_TOKEN;
const BATCH_FILE_LIMIT = 10;

// Ignore list for indexing
const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.vscode',
  '.albion', 'coverage', '.cache', 'target', 'vendor', '__pycache__'
]);

const SUPPORTED_EXTENSIONS = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.rb': 'ruby',
  '.sql': 'sql',
  '.md': 'markdown',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml'
};

// ---------------------------------------------------------------------------
// SUPABASE CLIENT
// ---------------------------------------------------------------------------
let supabaseClient = null;

function getSupabase() {
  if (!supabaseClient) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      throw new Error('[REPO-INDEXER] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment');
    }
    supabaseClient = createClient(url, key);
  }
  return supabaseClient;
}

// ---------------------------------------------------------------------------
// HASHING & METRICS
// ---------------------------------------------------------------------------
function computeChunkHash(content, relativePath, lineStart, lineEnd) {
  return crypto
    .createHash('sha256')
    .update(`${relativePath}:${lineStart}:${lineEnd}:${content}`)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// SMART CODE CHUNKING
// Splits code files into semantic blocks (functions, classes, blocks)
// keeping each chunk under MAX_CHUNK_CHARS while preserving syntax structure.
// ---------------------------------------------------------------------------
function chunkFileContent(content, relativePath, language) {
  const lines = content.split('\n');
  const chunks = [];

  let currentChunkLines = [];
  let chunkStartLine = 1;
  let currentChunkLength = 0;

  // Regex patterns for logical block starters across common languages
  const blockStarterRegex = /^(async\s+function|function\s+|class\s+|def\s+|pub\s+fn|fn\s+|type\s+|interface\s+|struct\s+|const\s+\w+\s*=\s*(?:async\s*)?\()/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const lineLength = line.length + 1; // +1 for newline

    const isLogicalBoundary = blockStarterRegex.test(line.trim());
    const exceedsCapacity = (currentChunkLength + lineLength) > MAX_CHUNK_CHARS;

    if ((isLogicalBoundary && currentChunkLines.length > 5) || exceedsCapacity) {
      if (currentChunkLines.length > 0) {
        const chunkText = currentChunkLines.join('\n');
        chunks.push({
          filePath: relativePath,
          lineStart: chunkStartLine,
          lineEnd: lineNum - 1,
          chunkText: chunkText,
          language: language,
          chunkHash: computeChunkHash(chunkText, relativePath, chunkStartLine, lineNum - 1)
        });
      }
      currentChunkLines = [line];
      chunkStartLine = lineNum;
      currentChunkLength = lineLength;
    } else {
      currentChunkLines.push(line);
      currentChunkLength += lineLength;
    }
  }

  // Final flush
  if (currentChunkLines.length > 0) {
    const chunkText = currentChunkLines.join('\n');
    chunks.push({
      filePath: relativePath,
      lineStart: chunkStartLine,
      lineEnd: lines.length,
      chunkText: chunkText,
      language: language,
      chunkHash: computeChunkHash(chunkText, relativePath, chunkStartLine, lines.length)
    });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// EMBEDDING GENERATION
// Calls DeepInfra API to generate 768-dim embeddings in batches.
// Fallback to deterministic pseudo-embeddings if no API key is provided (for offline tests).
// ---------------------------------------------------------------------------
async function generateEmbeddings(texts) {
  if (!texts || texts.length === 0) return [];

  const apiKey = process.env.DEEPINFRA_API_KEY;

  if (!apiKey) {
    console.warn('[REPO-INDEXER] DEEPINFRA_API_KEY not found. Using offline deterministic embeddings.');
    return texts.map(t => generateOfflineEmbedding(t, EMBEDDING_DIMENSION));
  }

  try {
    const response = await fetch(DEEPINFRA_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: texts
      })
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Embedding API error (status ${response.status}): ${errText}`);
    }

    const json = await response.json();
    return json.data.map(item => item.embedding);
  } catch (err) {
    console.error('[REPO-INDEXER] Remote embedding generation failed, falling back to offline:', err.message);
    return texts.map(t => generateOfflineEmbedding(t, EMBEDDING_DIMENSION));
  }
}

/**
 * Deterministic offline normalized vector for testing/offline scenarios.
 */
function generateOfflineEmbedding(text, dimension = 768) {
  const hash = crypto.createHash('sha256').update(text).digest();
  const vector = new Array(dimension).fill(0);
  for (let i = 0; i < dimension; i++) {
    const byte = hash[i % hash.length];
    vector[i] = ((byte / 255.0) * 2.0) - 1.0;
  }
  // Normalize vector to unit length
  const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0)) || 1;
  return vector.map(v => Number((v / norm).toFixed(6)));
}

// ---------------------------------------------------------------------------
// INCREMENTAL INDEXER METHODS
// ---------------------------------------------------------------------------

/**
 * Indexes a list of changed/new files incrementally.
 *
 * @param {string} userId - Supabase user UUID
 * @param {string} projectPath - Root directory of the project
 * @param {string[]} changedFiles - Array of relative or absolute file paths
 * @returns {Promise<{ indexedFiles: number, totalChunks: number }>}
 */
async function indexChangedFiles(userId, projectPath, changedFiles) {
  if (!userId || !projectPath) {
    throw new Error('[REPO-INDEXER] userId and projectPath are required');
  }

  const supabase = getSupabase();
  const filesToProcess = changedFiles.slice(0, BATCH_FILE_LIMIT);
  let totalChunksCount = 0;
  let indexedFilesCount = 0;

  for (const rawFile of filesToProcess) {
    const fullPath = path.isAbsolute(rawFile) ? rawFile : path.join(projectPath, rawFile);
    const relativePath = path.relative(projectPath, fullPath).replace(/\\/g, '/');

    // Filter ignored directories & extensions
    const parts = relativePath.split('/');
    if (parts.some(p => IGNORED_DIRECTORIES.has(p))) {
      continue;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const language = SUPPORTED_EXTENSIONS[ext];
    if (!language) {
      continue; // Skip unsupported file types (binaries, images, etc.)
    }

    // Check if file exists (if not, it was deleted)
    if (!fs.existsSync(fullPath)) {
      await removeDeletedFile(userId, projectPath, relativePath);
      continue;
    }

    const stats = fs.statSync(fullPath);
    if (stats.size > 1024 * 500) {
      // Skip files > 500KB to avoid memory bloat
      console.warn(`[REPO-INDEXER] Skipping large file (${stats.size} bytes): ${relativePath}`);
      continue;
    }

    const fileContent = fs.readFileSync(fullPath, 'utf-8');
    const chunks = chunkFileContent(fileContent, relativePath, language);

    if (chunks.length === 0) continue;

    // Check existing chunk hashes in Supabase to avoid re-embedding unchanged chunks
    const chunkHashes = chunks.map(c => c.chunkHash);
    const { data: existingRecords, error: checkError } = await supabase
      .from('repo_embeddings')
      .select('chunk_hash')
      .eq('user_id', userId)
      .eq('project_path', projectPath)
      .in('chunk_hash', chunkHashes);

    const existingHashSet = new Set(
      (existingRecords || []).map(r => r.chunk_hash)
    );

    // Filter down to only chunks that need embedding
    const chunksToEmbed = chunks.filter(c => !existingHashSet.has(c.chunkHash));

    if (chunksToEmbed.length > 0) {
      const texts = chunksToEmbed.map(c => c.chunkText);
      const embeddings = await generateEmbeddings(texts);

      const recordsToUpsert = chunksToEmbed.map((chunk, idx) => ({
        user_id: userId,
        project_path: projectPath,
        file_path: chunk.filePath,
        line_start: chunk.lineStart,
        line_end: chunk.lineEnd,
        chunk_text: chunk.chunkText,
        chunk_hash: chunk.chunkHash,
        language: chunk.language,
        embedding: embeddings[idx],
        updated_at: new Date().toISOString()
      }));

      // Upsert into Supabase
      const { error: upsertError } = await supabase
        .from('repo_embeddings')
        .upsert(recordsToUpsert, {
          onConflict: 'user_id,project_path,chunk_hash',
          ignoreDuplicates: false
        });

      if (upsertError) {
        console.error(`[REPO-INDEXER] Upsert error for ${relativePath}:`, upsertError.message);
      } else {
        totalChunksCount += recordsToUpsert.length;
      }
    }

    // Remove any stale chunks for this file that are no longer present in current file version
    const activeHashes = chunks.map(c => c.chunkHash);
    const { error: pruneError } = await supabase
      .from('repo_embeddings')
      .delete()
      .eq('user_id', userId)
      .eq('project_path', projectPath)
      .eq('file_path', relativePath)
      .not('chunk_hash', 'in', `(${activeHashes.join(',')})`);

    if (pruneError) {
      console.warn(`[REPO-INDEXER] Pruning stale chunks failed for ${relativePath}:`, pruneError.message);
    }

    indexedFilesCount++;
  }

  return {
    indexedFiles: indexedFilesCount,
    totalChunks: totalChunksCount
  };
}

/**
 * Handles file deletion by removing all associated chunk embeddings from Supabase.
 *
 * @param {string} userId
 * @param {string} projectPath
 * @param {string} relativeFilePath
 */
async function removeDeletedFile(userId, projectPath, relativeFilePath) {
  const normalizedPath = relativeFilePath.replace(/\\/g, '/');
  const supabase = getSupabase();

  const { error } = await supabase
    .from('repo_embeddings')
    .delete()
    .eq('user_id', userId)
    .eq('project_path', projectPath)
    .eq('file_path', normalizedPath);

  if (error) {
    console.error(`[REPO-INDEXER] Failed to delete embeddings for ${normalizedPath}:`, error.message);
    throw error;
  }

  console.log(`[REPO-INDEXER] Removed embeddings for deleted file: ${normalizedPath}`);
  return true;
}

/**
 * Similarity search for relevant code chunks using pgvector match RPC.
 *
 * @param {string} userId
 * @param {string} projectPath
 * @param {string} queryText
 * @param {number} matchCount - Top N results (default 5)
 * @returns {Promise<Array>} Matching chunks with similarity scores
 */
async function searchSimilarChunks(userId, projectPath, queryText, matchCount = 5) {
  const supabase = getSupabase();
  const [queryEmbedding] = await generateEmbeddings([queryText]);

  const { data, error } = await supabase.rpc('match_repo_embeddings', {
    p_user_id: userId,
    p_project_path: projectPath,
    p_query_embedding: queryEmbedding,
    p_match_count: matchCount
  });

  if (error) {
    console.error('[REPO-INDEXER] Similarity search RPC error:', error.message);
    return [];
  }

  return data || [];
}

module.exports = {
  indexChangedFiles,
  removeDeletedFile,
  searchSimilarChunks,
  chunkFileContent,
  generateEmbeddings,
  computeChunkHash,
  SUPPORTED_EXTENSIONS,
  EMBEDDING_DIMENSION
};
