import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  parseContract,
  QuantRunJobInputSchema,
  QUANT_PREPARE_JOB_TYPE,
  QUANT_RUN_JOB_TYPE,
} from '../../contracts/src/index.js';

export const quantLabManifest = Object.freeze({
  id: 'quant.lab',
  version: '0.1.0',
  capabilities: [QUANT_PREPARE_JOB_TYPE, QUANT_RUN_JOB_TYPE],
  jobTypes: [QUANT_PREPARE_JOB_TYPE, QUANT_RUN_JOB_TYPE],
});

export function resolveQuantPython(repositoryRoot) {
  const binary = process.platform === 'win32' ? 'python.exe' : 'python';
  return path.join(repositoryRoot, 'quant', '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', binary);
}

export function buildQuantCommand({ repositoryRoot, quantRoot, command, experimentId, topk, nDrop }) {
  const pythonPath = resolveQuantPython(repositoryRoot);
  const args = ['-m', 'aicenter_quant', command, '--root', quantRoot];
  if (command === 'run') {
    args.push('--experiment-id', experimentId, '--topk', String(topk), '--n-drop', String(nDrop));
  }
  return { pythonPath, args, shell: false };
}

function runProcess(pythonPath, args, { quantRoot, env }) {
  return new Promise((resolve, reject) => {
    if (!existsSync(pythonPath)) {
      reject(new Error('量化环境还没安装。请在仓库根目录运行 scripts/setup-quant.ps1'));
      return;
    }
    const child = spawn(pythonPath, args, {
      shell: false,
      cwd: quantRoot,
      env,
      windowsHide: true,
    });
    let output = '';
    const append = (chunk) => {
      output = `${output}${chunk}`.slice(-8000);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ code, output: output.slice(-2000) });
      else reject(new Error(output.trim().split('\n').slice(-8).join('\n') || `量化进程退出码 ${code}`));
    });
  });
}

export function createQuantJobHandlers({ repositoryRoot, quantRoot, env = process.env }) {
  if (!repositoryRoot || !quantRoot) throw new Error('quant jobs require repositoryRoot and quantRoot');
  const childEnv = { ...env, PYTHONPATH: path.join(repositoryRoot, 'quant', 'src') };

  return {
    [QUANT_PREPARE_JOB_TYPE]: async () => {
      const command = buildQuantCommand({ repositoryRoot, quantRoot, command: 'prepare' });
      const result = await runProcess(command.pythonPath, command.args, { quantRoot, env: childEnv });
      return { prepared: true, output: result.output };
    },
    [QUANT_RUN_JOB_TYPE]: async (rawInput) => {
      const input = parseContract(QuantRunJobInputSchema, rawInput || {});
      const command = buildQuantCommand({
        repositoryRoot,
        quantRoot,
        command: 'run',
        experimentId: input.experimentId,
        topk: input.topk,
        nDrop: input.nDrop,
      });
      const result = await runProcess(command.pythonPath, command.args, { quantRoot, env: childEnv });
      return {
        experimentId: input.experimentId,
        topk: input.topk,
        nDrop: input.nDrop,
        output: result.output,
      };
    },
  };
}
