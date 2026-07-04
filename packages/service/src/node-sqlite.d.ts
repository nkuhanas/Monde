declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }

  export interface StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  }
}
