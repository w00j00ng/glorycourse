import type { ErrorObject } from 'ajv/dist/2020.js';

export class StoreRevisionConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super(`Expected store revision does not match current revision ${currentRevision}`);
    this.name = 'StoreRevisionConflictError';
    this.currentRevision = currentRevision;
  }
}

export class StoreEpochConflictError extends Error {
  constructor() {
    super('Expected store epoch does not match current epoch');
    this.name = 'StoreEpochConflictError';
  }
}

export class StoreRecoveryRequiredError extends Error {
  constructor() {
    super('Store state cannot be determined; writes are blocked until recovery');
    this.name = 'StoreRecoveryRequiredError';
  }
}

export class StoreValidationError extends Error {
  readonly issues: ErrorObject[];

  constructor(issues: ErrorObject[]) {
    super('Candidate store violates the storage contract');
    this.name = 'StoreValidationError';
    this.issues = issues;
  }
}
