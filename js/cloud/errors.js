// Provider-neutral errors of the cloud storage layer (twin of
// app/cloudsync/errors.py).  Network failures stay api.js NetworkError.

export class StorageError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Compare-and-swap of the head lost: another device changed it meanwhile. */
export class HeadConflict extends StorageError {}

/** A file that must be new already exists. */
export class StorageConflict extends StorageError {}

export class NotFoundError extends StorageError {}

/** Rate limit or temporary server trouble that outlasted the retries. */
export class ThrottledError extends StorageError {}

/** The sign-in is missing or expired – the user taps "Anmelden". */
export class AuthRequiredError extends Error {
  constructor(message = 'Bitte erneut anmelden.') {
    super(message);
    this.authRequired = true;
  }
}
