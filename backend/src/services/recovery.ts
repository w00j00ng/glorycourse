import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import {
  createBackup,
  listBackups,
  readBackupFile,
  type Backup,
} from '../storage/backup.ts';
import {
  StoreEpochConflictError,
  StoreRevisionConflictError,
  type Store,
  type DatabaseState,
  type RestoreReceiptRecord,
} from '../storage/store.ts';

type RecoveryIssue = {
  code: string;
  message: string;
  severity: 'WARNING';
  blockingStages: never[];
  acknowledgementStages: ['RESTORE'];
  subject: { entityType: 'store' };
  source: Record<string, never>;
  detail: { currentStoreRevision: number; backupStoreRevision: number };
};

type RestorePreview = {
  preparedActionToken: string;
  warningDigest: string;
  storeRevision: number;
  storeEpoch: string;
  expiresAt: string;
  issues: RecoveryIssue[];
  backupStoreRevision: number;
  backupStoreEpoch: string;
};

type RestoreReceipt = Omit<RestoreReceiptRecord, 'idempotencyKey' | 'requestHash'>;

type PreparedRestore = RestorePreview & { candidate: DatabaseState };
type Dependencies = {
  dataFile: string;
  backupDirectory: string;
  id: () => string;
  now: () => Date;
  ttlMs?: number;
};

export class RecoveryValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'RecoveryValidationError'; }
}
export class RecoveryAcknowledgementError extends Error {
  constructor() { super('Restore warning requires exact acknowledgement'); this.name = 'RecoveryAcknowledgementError'; }
}
export class RecoveryTokenError extends Error {
  constructor() { super('Restore preview is invalid or expired'); this.name = 'RecoveryTokenError'; }
}
export class RecoveryStaleError extends Error {
  constructor() { super('Restore preview no longer matches current data'); this.name = 'RecoveryStaleError'; }
}
export class RecoveryIdempotencyConflictError extends Error {
  constructor() { super('Idempotency key was already used for another restore'); this.name = 'RecoveryIdempotencyConflictError'; }
}

export class RecoveryService {
  readonly #store: Store;
  readonly #dependencies: Dependencies & { ttlMs: number };
  readonly #previews = new Map<string, PreparedRestore>();
  #backupTail: Promise<void> = Promise.resolve();

  constructor(store: Store, dependencies: Dependencies) {
    this.#store = store;
    this.#dependencies = { ...dependencies, ttlMs: dependencies.ttlMs ?? 10 * 60 * 1000 };
  }

  async list(): Promise<Backup[]> { return listBackups(this.#dependencies.backupDirectory); }

  create(): Promise<Backup> {
    const run = this.#backupTail.then(() => this.#createBackup());
    this.#backupTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async #createBackup(): Promise<Backup> {
    const current = this.#store.version();
    const latest = (await this.list()).find(({ status }) => status === 'READY');
    if (latest?.storeEpoch === current.storeEpoch && latest.storeRevision === current.storeRevision) return latest;
    return createBackup(this.#dependencies.dataFile, this.#dependencies.backupDirectory, {
      id: this.#dependencies.id(), now: this.#dependencies.now(),
    });
  }

  async preview(file: string): Promise<RestorePreview> {
    const candidate = await readBackupFile(file, join(dirname(this.#dependencies.dataFile), 'recovery-work'));
    const current = this.#store.version();
    const preparedActionToken = this.#dependencies.id();
    const expiresAt = new Date(this.#dependencies.now().getTime() + this.#dependencies.ttlMs).toISOString();
    const issues: RecoveryIssue[] = [{
      code: 'RESTORE_REPLACES_CURRENT_DATA',
      message: '백업 이후의 현재 자료가 사라집니다.',
      severity: 'WARNING',
      blockingStages: [],
      acknowledgementStages: ['RESTORE'],
      subject: { entityType: 'store' },
      source: {},
      detail: {
        currentStoreRevision: current.storeRevision,
        backupStoreRevision: candidate.meta.storeRevision,
      },
    }];
    const preview: PreparedRestore = {
      preparedActionToken,
      warningDigest: digest(issues),
      storeRevision: current.storeRevision,
      storeEpoch: current.storeEpoch,
      expiresAt,
      issues,
      backupStoreRevision: candidate.meta.storeRevision,
      backupStoreEpoch: candidate.meta.storeEpoch,
      candidate,
    };
    this.#removeExpired();
    this.#previews.set(preparedActionToken, structuredClone(preview));
    return publicPreview(preview);
  }

  async restore(input: {
    idempotencyKey: string;
    preparedActionToken: string;
    acknowledgedWarningDigest: string;
    acknowledgementNote: string;
  }): Promise<RestoreReceipt> {
    validateRestoreInput(input);
    const requestHash = digest({
      preparedActionToken: input.preparedActionToken,
      acknowledgedWarningDigest: input.acknowledgedWarningDigest,
      acknowledgementNote: input.acknowledgementNote,
    });
    const current = this.#store.version();
    const history = this.#store.restoreHistory();
    const previous = findReceipt(history, input.idempotencyKey, requestHash);
    if (previous) return previous;
    const preview = this.#previews.get(input.preparedActionToken);
    if (!preview || Date.parse(preview.expiresAt) <= this.#dependencies.now().getTime()) {
      this.#previews.delete(input.preparedActionToken);
      throw new RecoveryTokenError();
    }
    if (current.storeRevision !== preview.storeRevision || current.storeEpoch !== preview.storeEpoch) {
      throw new RecoveryStaleError();
    }
    if (input.acknowledgedWarningDigest !== preview.warningDigest || !input.acknowledgementNote.trim()) {
      throw new RecoveryAcknowledgementError();
    }
    const restoredAt = this.#dependencies.now();
    const candidate = structuredClone(preview.candidate);
    candidate.meta.storeEpoch = this.#dependencies.id();
    const receipt: RestoreReceipt = {
      receiptId: this.#dependencies.id(),
      previousBackupId: this.#dependencies.id(),
      storeRevision: candidate.meta.storeRevision,
      storeEpoch: candidate.meta.storeEpoch,
      restoredAt: restoredAt.toISOString(),
    };
    // Receipt history belongs to this installation, not to the older backup.
    candidate.restoreReceipts = [...history, { idempotencyKey: input.idempotencyKey, requestHash, ...receipt }];
    try {
      await this.#store.restore(candidate, {
        expectedRevision: preview.storeRevision,
        expectedEpoch: preview.storeEpoch,
        backup: async () => {
          await createBackup(this.#dependencies.dataFile, this.#dependencies.backupDirectory, {
            id: receipt.previousBackupId, now: restoredAt,
          });
        },
      });
    } catch (error) {
      if (error instanceof StoreRevisionConflictError || error instanceof StoreEpochConflictError) {
        const committed = findReceipt(this.#store.restoreHistory(), input.idempotencyKey, requestHash);
        if (committed) return committed;
        throw new RecoveryStaleError();
      }
      throw error;
    }
    this.#previews.clear();
    return receipt;
  }

  #removeExpired(): void {
    const now = this.#dependencies.now().getTime();
    for (const [token, preview] of this.#previews) {
      if (Date.parse(preview.expiresAt) <= now) this.#previews.delete(token);
    }
  }
}

export const publicBackup = ({ file: _file, ...backup }: Backup) => backup;

const publicPreview = ({ candidate: _candidate, ...preview }: PreparedRestore): RestorePreview => preview;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const findReceipt = (history: ReadonlyArray<RestoreReceiptRecord>, key: string, hash: string): RestoreReceipt | undefined => {
  const record = history.find((item) => item.idempotencyKey === key);
  if (!record) return undefined;
  const { idempotencyKey: _key, requestHash, ...receipt } = record;
  if (requestHash !== hash) throw new RecoveryIdempotencyConflictError();
  return receipt;
};

const validateRestoreInput = (input: Record<string, unknown>): void => {
  for (const [name, value, maximum] of [
    ['idempotencyKey', input.idempotencyKey, 200],
    ['preparedActionToken', input.preparedActionToken, Number.POSITIVE_INFINITY],
    ['acknowledgedWarningDigest', input.acknowledgedWarningDigest, Number.POSITIVE_INFINITY],
    ['acknowledgementNote', input.acknowledgementNote, 2000],
  ] as const) {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
      throw new RecoveryValidationError(`${name} is invalid`);
    }
  }
};
