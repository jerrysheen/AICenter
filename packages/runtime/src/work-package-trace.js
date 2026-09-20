import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseWorkPackageGoal,
  parseWorkPackageParentTrace,
  parseWorkPackageProgress,
  parseWorkPackageTraceStep,
} from '../../contracts/src/index.js';
import { workPackageTraceId } from '../../connectors/src/cursor-session.js';
import { splitWorkPackageStepRecords, workPackageStepTextLooksGarbled } from './work-package-step-text.js';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toRelative(repositoryRoot, absolutePath) {
  return path.relative(text(repositoryRoot) || process.cwd(), absolutePath).replace(/\\/g, '/');
}

function readJsonFile(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFile(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function goalObjective(workPackage) {
  if (text(workPackage?.parentWorkPackageId)) {
    const title = text(workPackage?.title);
    if (title) return title;
  }
  return text(workPackage?.body) || text(workPackage?.title) || '工作包';
}

function defaultProgressSummary(workPackage) {
  const status = text(workPackage?.status) || 'open';
  if (status === 'claimed') return '本机 Cursor 已领取并开始执行';
  if (status === 'completed') return text(workPackage?.resultSummary) || '已完成';
  if (status === 'failed') return text(workPackage?.resultSummary) || '未完成';
  if (status === 'cancelled') return '已取消';
  if (text(workPackage?.dispatchJobId)) return '已派发独立会话';
  return '已投递，等待本机 Cursor 领取';
}

export function createWorkPackageTracePort({
  logDirectory,
  repositoryRoot = process.cwd(),
  now = () => Date.now(),
} = {}) {
  const root = text(logDirectory);
  if (!root) throw new Error('work package trace requires logDirectory');

  function directoryFor(workPackageId) {
    return path.join(root, 'work-packages', workPackageTraceId(workPackageId));
  }

  function readSteps(file) {
    if (!existsSync(file)) return [];
    return splitWorkPackageStepRecords(readFileSync(file)).flatMap((line) => {
      try {
        return [parseWorkPackageTraceStep(JSON.parse(line))];
      } catch {
        return [];
      }
    });
  }

  function writeGoal(directory, workPackage) {
    const file = path.join(directory, 'goal.json');
    if (existsSync(file)) {
      const existing = readJsonFile(file);
      try {
        return parseWorkPackageGoal(existing);
      } catch {
        // rewrite a valid goal below
      }
    }
    const goal = parseWorkPackageGoal({
      objective: goalObjective(workPackage),
      parentWorkPackageId: text(workPackage?.parentWorkPackageId),
      createdAt: now(),
    });
    writeJsonFile(file, goal);
    return goal;
  }

  function writeProgress(directory, workPackage, summary) {
    const progress = parseWorkPackageProgress({
      status: text(workPackage?.status) || 'open',
      summary: text(summary) || defaultProgressSummary(workPackage),
      updatedAt: now(),
    });
    writeJsonFile(path.join(directory, 'progress.json'), progress);
    return progress;
  }

  function snapshotParentTrace(parentId) {
    const id = text(parentId);
    if (!id) return null;
    const parent = readTrace(id);
    try {
      return parseWorkPackageParentTrace({
        workPackageId: id,
        hashId: parent.hashId,
        goal: parent.goal,
        progress: parent.progress,
        steps: parent.steps,
      });
    } catch {
      return null;
    }
  }

  function writeParentTrace(directory, parentId) {
    const file = path.join(directory, 'parent-trace.json');
    if (existsSync(file)) {
      const existing = readJsonFile(file);
      try {
        return parseWorkPackageParentTrace(existing);
      } catch {
        // rewrite a valid snapshot below
      }
    }
    const snapshot = snapshotParentTrace(parentId);
    if (snapshot) writeJsonFile(file, snapshot);
    return snapshot;
  }

  function repairParentTrace(snapshot) {
    if (!snapshot) return null;
    const rows = Array.isArray(snapshot.steps) ? snapshot.steps : [];
    if (!rows.some((item) => workPackageStepTextLooksGarbled(item?.summary))) {
      return snapshot;
    }
    const live = readTrace(snapshot.workPackageId);
    if (!live.steps.length || live.steps.some((item) => workPackageStepTextLooksGarbled(item?.summary))) {
      return snapshot;
    }
    try {
      return parseWorkPackageParentTrace({
        ...snapshot,
        steps: live.steps,
      });
    } catch {
      return snapshot;
    }
  }

  function readParentTrace(directory) {
    const raw = readJsonFile(path.join(directory, 'parent-trace.json'));
    if (!raw) return null;
    try {
      return repairParentTrace(parseWorkPackageParentTrace(raw));
    } catch {
      return null;
    }
  }

  function readTrace(workPackageId) {
    const id = text(workPackageId);
    const directory = directoryFor(id);
    const hashId = workPackageTraceId(id);
    const relativeDir = toRelative(repositoryRoot, directory);
    const promptFile = path.join(directory, 'prompt.txt');
    const metaFile = path.join(directory, 'meta.json');
    let meta = { hashId, workPackageId: id, relativeDir };
    if (existsSync(metaFile)) {
      try {
        meta = { ...meta, ...JSON.parse(readFileSync(metaFile, 'utf8')) };
      } catch {
        // keep derived fields
      }
    }
    let goal = null;
    try {
      const raw = readJsonFile(path.join(directory, 'goal.json'));
      goal = raw ? parseWorkPackageGoal(raw) : null;
    } catch {
      goal = null;
    }
    let progress = null;
    try {
      const raw = readJsonFile(path.join(directory, 'progress.json'));
      progress = raw ? parseWorkPackageProgress(raw) : null;
    } catch {
      progress = null;
    }
    return {
      ...meta,
      hashId,
      workPackageId: id,
      relativeDir,
      prompt: existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : '',
      goal,
      progress,
      steps: readSteps(path.join(directory, 'steps.jsonl')),
      parentTrace: readParentTrace(directory),
    };
  }

  function ensureDirectory(workPackageId) {
    const directory = directoryFor(workPackageId);
    mkdirSync(directory, { recursive: true });
    return directory;
  }

  return Object.freeze({
    hashId(workPackageId) {
      return workPackageTraceId(workPackageId);
    },
    relativeDir(workPackageId) {
      return toRelative(repositoryRoot, directoryFor(workPackageId));
    },
    seed({ workPackage } = {}) {
      const id = text(workPackage?.id);
      if (!id) throw new Error('work package id is required');
      const directory = ensureDirectory(id);
      const hashId = workPackageTraceId(id);
      const relativeDir = toRelative(repositoryRoot, directory);
      const goal = writeGoal(directory, workPackage);
      const progress = writeProgress(directory, workPackage);
      const parentTrace = writeParentTrace(directory, workPackage?.parentWorkPackageId);
      return { hashId, relativeDir, directory, goal, progress, parentTrace };
    },
    writeProgress({ workPackage, summary } = {}) {
      const id = text(workPackage?.id);
      if (!id) throw new Error('work package id is required');
      const directory = ensureDirectory(id);
      writeGoal(directory, workPackage);
      return writeProgress(directory, workPackage, summary);
    },
    prepare({ workPackage, prompt } = {}) {
      const id = text(workPackage?.id);
      if (!id) throw new Error('work package id is required');
      const directory = ensureDirectory(id);
      const hashId = workPackageTraceId(id);
      const relativeDir = toRelative(repositoryRoot, directory);
      const meta = {
        hashId,
        workPackageId: id,
        title: text(workPackage.title),
        createdAt: now(),
        relativeDir,
      };
      writeFileSync(path.join(directory, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
      writeFileSync(path.join(directory, 'prompt.txt'), String(prompt || ''), 'utf8');
      writeGoal(directory, workPackage);
      writeProgress(directory, { ...workPackage, status: workPackage?.status || 'claimed' }, '本机 Cursor 已领取并写好提示词');
      appendFileSync(path.join(directory, 'steps.jsonl'), `${JSON.stringify({
        at: now(),
        step: 'claim',
        status: 'done',
        summary: 'Worker 已领取并写好提示词',
        paths: [],
      })}\n`, 'utf8');
      return { hashId, relativeDir, directory };
    },
    read(workPackageId) {
      return readTrace(workPackageId);
    },
  });
}
