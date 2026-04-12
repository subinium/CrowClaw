export interface DurableObjectIdLike {
  toString(): string;
}

export interface DurableObjectStateLike {
  id: DurableObjectIdLike;
}

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface D1StatementLike {
  first?<T>(): Promise<T | null>;
  all?<T>(): Promise<{ results: T[] }>;
  run?(): Promise<unknown>;
  bind(...values: unknown[]): {
    first<T>(): Promise<T | null>;
    all?<T>(): Promise<{ results: T[] }>;
    run(): Promise<unknown>;
  };
}

export interface D1DatabaseLike {
  prepare(query: string): D1StatementLike;
}

export interface R2ObjectLike {
  text(): Promise<string>;
}

export interface R2BucketLike {
  put(key: string, value: string, options?: Record<string, unknown>): Promise<unknown>;
  get(key: string): Promise<R2ObjectLike | null>;
}
