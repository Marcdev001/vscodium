/**
 * albion-verifier - project-memory.js
 * Project Memory Manager (Phase 3: Memory & Context)
 *
 * Manages `.albion/memory.md` as a persistent, agent-updated summary of stack,
 * conventions, and key decisions. Injected into every prompt before conversation history.
 *
 * Constraints:
 *   - Auto-generated on first project open if missing.
 *   - Read-only for the user (protected from accidental edits).
 *   - Agent writes via explicit permission override.
 *   - Provides getMemoryContext() for system prompt injection.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ALBION_DIR_NAME = '.albion';
const MEMORY_FILE_NAME = 'memory.md';

const DEFAULT_MEMORY_TEMPLATE = `# Project Memory

## Tech Stack
- [Agent fills this]

## Key Conventions
- [Agent fills this]

## Recent Decisions
- [Agent fills this]

## Open Questions
- [Agent fills this]
`;

/**
 * Resolves the path to the .albion directory and memory.md file.
 * @param {string} projectPath
 * @returns {{ albionDir: string, memoryFilePath: string }}
 */
function getMemoryPaths(projectPath) {
  if (!projectPath) {
    throw new Error('[PROJECT-MEMORY] projectPath is required');
  }
  const albionDir = path.join(projectPath, ALBION_DIR_NAME);
  const memoryFilePath = path.join(albionDir, MEMORY_FILE_NAME);
  return { albionDir, memoryFilePath };
}

/**
 * Sets file permissions cross-platform.
 * On Windows/POSIX, attempts chmod.
 * @param {string} filePath
 * @param {boolean} readOnly
 */
function setFileReadOnly(filePath, readOnly) {
  try {
    if (fs.existsSync(filePath)) {
      if (readOnly) {
        // Read-only: 0o444 (read for owner/group/others)
        fs.chmodSync(filePath, 0o444);
      } else {
        // Writable: 0o644 (read/write for owner, read for group/others)
        fs.chmodSync(filePath, 0o644);
      }
    }
  } catch (err) {
    // Non-fatal warning if OS filesystem permissions fail (e.g. FAT32 or certain Windows mounts)
    console.warn(`[PROJECT-MEMORY] Warning: could not set permission (readOnly=${readOnly}):`, err.message);
  }
}

/**
 * Ensures .albion/memory.md exists. Creates directory and template if missing.
 * Sets file to read-only after creation.
 * @param {string} projectPath
 * @returns {string} Path to memory.md
 */
function ensureMemoryFile(projectPath) {
  const { albionDir, memoryFilePath } = getMemoryPaths(projectPath);

  if (!fs.existsSync(albionDir)) {
    fs.mkdirSync(albionDir, { recursive: true });
  }

  if (!fs.existsSync(memoryFilePath)) {
    // Write default template
    fs.writeFileSync(memoryFilePath, DEFAULT_MEMORY_TEMPLATE, 'utf-8');
    setFileReadOnly(memoryFilePath, true);
    console.log(`[PROJECT-MEMORY] Created ${memoryFilePath} with default template`);
  }

  return memoryFilePath;
}

/**
 * Returns the raw content of .albion/memory.md, or default template if missing.
 * @param {string} projectPath
 * @returns {string}
 */
function readMemory(projectPath) {
  const { memoryFilePath } = getMemoryPaths(projectPath);
  if (!fs.existsSync(memoryFilePath)) {
    return ensureMemoryFile(projectPath) ? fs.readFileSync(memoryFilePath, 'utf-8') : DEFAULT_MEMORY_TEMPLATE;
  }
  return fs.readFileSync(memoryFilePath, 'utf-8');
}

/**
 * Updates the content of .albion/memory.md.
 * Temporarily relaxes read-only permissions, writes the content, and restores read-only.
 *
 * @param {string} projectPath
 * @param {string} newContent - Entire updated content or markdown
 * @returns {boolean} True if successful
 */
function updateMemory(projectPath, newContent) {
  if (!newContent || typeof newContent !== 'string') {
    throw new Error('[PROJECT-MEMORY] newContent must be a non-empty string');
  }

  const { albionDir, memoryFilePath } = getMemoryPaths(projectPath);

  if (!fs.existsSync(albionDir)) {
    fs.mkdirSync(albionDir, { recursive: true });
  }

  try {
    // Unlock file
    setFileReadOnly(memoryFilePath, false);

    // Write updated content
    fs.writeFileSync(memoryFilePath, newContent.trim() + '\n', 'utf-8');

    // Relock file to read-only for user protection
    setFileReadOnly(memoryFilePath, true);

    console.log(`[PROJECT-MEMORY] Successfully updated ${memoryFilePath}`);
    return true;
  } catch (err) {
    // Ensure file is re-locked even if write failed
    setFileReadOnly(memoryFilePath, true);
    console.error(`[PROJECT-MEMORY] Failed to update memory.md:`, err.message);
    throw err;
  }
}

/**
 * Appends or replaces a specific section in .albion/memory.md.
 * @param {string} projectPath
 * @param {string} sectionTitle - e.g. "Recent Decisions"
 * @param {string} sectionContent - bullet points or text
 */
function updateMemorySection(projectPath, sectionTitle, sectionContent) {
  const currentMemory = readMemory(projectPath);
  const normalizedTitle = sectionTitle.replace(/^#+\s*/, '').trim();
  const headerRegex = new RegExp(`(^##\\s+${normalizedTitle}\\s*$)([\\s\\S]*?)(?=^##|$)`, 'm');

  const formattedNewSection = `## ${normalizedTitle}\n${sectionContent.trim()}\n\n`;

  let updated;
  if (headerRegex.test(currentMemory)) {
    updated = currentMemory.replace(headerRegex, formattedNewSection);
  } else {
    // Section doesn't exist, append to end
    updated = currentMemory.trim() + '\n\n' + formattedNewSection;
  }

  return updateMemory(projectPath, updated);
}

/**
 * Returns formatted memory context for system prompt injection.
 * Anchors the model before conversation history.
 *
 * @param {string} projectPath
 * @returns {string} Formatted context block
 */
function getMemoryContext(projectPath) {
  try {
    const content = readMemory(projectPath);
    return [
      '<!-- ALBION PROJECT MEMORY (DO NOT MODIFY MANUALLY) -->',
      '<project_memory>',
      content.trim(),
      '</project_memory>'
    ].join('\n');
  } catch (err) {
    console.warn('[PROJECT-MEMORY] Unable to load memory context:', err.message);
    return '';
  }
}

module.exports = {
  ensureMemoryFile,
  readMemory,
  updateMemory,
  updateMemorySection,
  getMemoryContext,
  getMemoryPaths,
  DEFAULT_MEMORY_TEMPLATE
};
