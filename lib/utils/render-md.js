import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, skillsDir, configDir } from '../paths.js';
import { isWebSearchAvailable } from '../ai/web-search.js';

const INCLUDE_PATTERN = /\{\{([^}]+\.md)\}\}/g;
const VARIABLE_PATTERN = /\{\{(datetime|skills|web_search|soul)\}\}/gi;

// Scan skill directories under skills/active/ for SKILL.md files and extract
// description from YAML frontmatter. Returns a bullet list of descriptions.
function loadSkillDescriptions() {
  const activeDir = path.join(skillsDir, 'active');
  try {
    if (!fs.existsSync(activeDir)) {
      return 'No additional abilities configured.';
    }

    const entries = fs.readdirSync(activeDir, { withFileTypes: true });
    const descriptions = [];

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

      const skillMdPath = path.join(activeDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;

      const content = fs.readFileSync(skillMdPath, 'utf8');
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatterMatch) continue;

      const frontmatter = frontmatterMatch[1];
      const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
      if (descMatch) {
        descriptions.push(`- ${descMatch[1].trim()}`);
      }
    }

    if (descriptions.length === 0) {
      return 'No additional abilities configured.';
    }

    return descriptions.join('\n');
  } catch {
    return 'No additional abilities configured.';
  }
}

/**
 * Resolve built-in variables like {{datetime}}, {{skills}}, and {{soul}}.
 * @param {string} content - Content with possible variable placeholders
 * @param {object} [extraVars={}] - Additional variables (e.g., { soul: '...' })
 * @returns {string} Content with variables resolved
 */
function resolveVariables(content, extraVars = {}) {
  return content.replace(VARIABLE_PATTERN, (match, variable) => {
    switch (variable.toLowerCase()) {
      case 'datetime':
        return new Date().toISOString();
      case 'skills':
        return loadSkillDescriptions();
      case 'web_search': {
        const mdFile = isWebSearchAvailable()
          ? path.join(configDir, 'WEB_SEARCH_AVAILABLE.md')
          : path.join(configDir, 'WEB_SEARCH_UNAVAILABLE.md');
        try {
          return fs.readFileSync(mdFile, 'utf8').trim();
        } catch {
          return match;
        }
      }
      case 'soul':
        return extraVars.soul ?? '';
      default:
        return match;
    }
  });
}

/**
 * Render a markdown file, resolving {{filepath}} includes recursively
 * and {{datetime}}, {{skills}}, {{soul}} built-in variables.
 * Referenced file paths resolve relative to the project root.
 * @param {string} filePath - Absolute path to the markdown file
 * @param {string[]} [chain=[]] - Already-resolved file paths (for circular detection)
 * @param {object} [extraVars={}] - Extra variables passed through (e.g., { soul: '...' })
 * @returns {string} Rendered markdown content
 */
function render_md(filePath, chain = [], extraVars = {}) {
  const resolved = path.resolve(filePath);

  if (chain.includes(resolved)) {
    const cycle = [...chain, resolved].map((p) => path.relative(PROJECT_ROOT, p)).join(' -> ');
    console.log(`[render_md] Circular include detected: ${cycle}`);
    return '';
  }

  if (!fs.existsSync(resolved)) {
    return '';
  }

  const content = fs.readFileSync(resolved, 'utf8');
  const currentChain = [...chain, resolved];

  const withIncludes = content.replace(INCLUDE_PATTERN, (match, includePath) => {
    const includeResolved = path.resolve(PROJECT_ROOT, includePath.trim());
    if (!fs.existsSync(includeResolved)) {
      return match;
    }
    return render_md(includeResolved, currentChain, extraVars);
  });

  return resolveVariables(withIncludes, extraVars);
}

export { render_md };
