/** Typed service errors so the web app / worker / AI tools can map them to responses. */
export class CoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = new.target.name;
  }
}

export class NotFoundError extends CoreError {
  constructor(entity: string, id: string) {
    super("not_found", `${entity} ${id} not found`);
  }
}

export class ValidationError extends CoreError {
  constructor(message: string) {
    super("invalid", message);
  }
}

/** The data changed underneath the operation (stale undo/redo, concurrent edit, FK in use). */
export class ConflictError extends CoreError {
  constructor(message: string) {
    super("conflict", message);
  }
}

export function assertFound<T>(value: T | undefined | null, entity: string, id: string): T {
  if (value === undefined || value === null) throw new NotFoundError(entity, id);
  return value;
}
