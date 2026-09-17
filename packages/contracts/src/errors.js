import { z } from 'zod';

export class ValidationError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

export function parseContract(schema, value, fallbackMessage) {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) throw validationErrorFromZod(error, fallbackMessage);
    throw error;
  }
}

export function validationErrorFromZod(error, fallbackMessage = '数据格式不正确') {
  const issues = error?.issues?.map((issue) => issue.path.join('.')).filter(Boolean) || [];
  return new ValidationError(error?.issues?.[0]?.message || fallbackMessage, issues);
}
