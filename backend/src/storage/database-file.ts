import { stat } from 'node:fs/promises';

export const fileExists = async (file: string): Promise<boolean> => {
  try { await stat(file); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
};
