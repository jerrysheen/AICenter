import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function javascriptFiles(directory) {
  const absolute = path.join(root, directory);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(relative);
    return entry.isFile() && relative.endsWith('.js') ? [relative] : [];
  });
}

function imports(file) {
  const source = readFileSync(path.join(root, file), 'utf8');
  return [...source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g)]
    .map((match) => match[1]);
}

const rules = [
  {
    files: javascriptFiles('packages/domain/src'),
    forbidden: ['/packages/database/', '/packages/connectors/', '/apps/'],
    description: 'domain 不能依赖数据库、Connector 或 App',
  },
  {
    files: javascriptFiles('apps/web/src/routes'),
    forbidden: ['/packages/database/', '/packages/connectors/'],
    description: 'HTTP 路由不能直接依赖数据库或 Connector',
  },
  {
    files: javascriptFiles('packages/connectors/src'),
    forbidden: ['/packages/database/', '/packages/domain/', '/apps/'],
    description: 'Connector 不能依赖数据库、领域实现或 App',
  },
];

const violations = [];
for (const rule of rules) {
  for (const file of rule.files) {
    const directory = path.dirname(path.join(root, file));
    for (const specifier of imports(file)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = path.resolve(directory, specifier).replaceAll('\\', '/');
      if (rule.forbidden.some((fragment) => resolved.includes(fragment))) {
        violations.push(`${file}: ${specifier} (${rule.description})`);
      }
    }
  }
}

if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Architecture boundaries verified.');
}
